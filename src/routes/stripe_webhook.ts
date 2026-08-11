/**
 * Stripe Webhook ルート
 *   POST /api/stripe/webhook  （利用者 JWT 不要、Stripe 署名検証必須）
 *
 * 設計根拠: api/PURCHASE_API.md 3, adr/ADR-007, REVIEW_RULE.md 4,
 *           ORDER_LIFECYCLE_DESIGN_*（共通 fulfill・expired/refund/dispute）
 *
 * 重要（WORK-007 で確定・維持必須）:
 * - raw request body を変更せず使用する（署名検証のため text() は 1 回だけ呼ぶ）。
 * - 署名検証は Stripe 公式 SDK の constructEventAsync + createSubtleCryptoProvider。
 * - 権限付与の正本は Webhook（主経路）。付与ロジックは共通 fulfill に集約。
 *
 * WORK-011 注文ライフサイクル:
 * - checkout.session.completed → fulfillCheckoutSession(webhook)（Session ID 冪等）。
 * - checkout.session.expired   → 対応 attempt を EXPIRED / lock 解放。
 * - refund 関連 / dispute 関連  → T_PAYMENT_EVENT へ記録（event.id 冪等・自動剥奪しない）。
 */

import Stripe from "stripe";
import { getStripe, getCryptoProvider, StripeConfigError } from "../shared/stripe";
import { PriceConfigError } from "../shared/purchase";
import { AppError } from "../shared/errors";
import { getDb } from "../shared/db";
import { jsonOk, jsonError } from "../shared/response";
import {
  fulfillCheckoutSession,
  retrieveAndValidateCheckoutSession,
  epochToJstIso,
  verifyLineItemsAndResolve,
} from "../shared/stripe_fulfill";
import {
  expireAttempt,
  recordPaymentEvent,
  PAYMENT_EVENT_TYPE,
} from "../shared/checkout_attempt";
import type { Env } from "../index";

/**
 * POST /api/stripe/webhook
 */
export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET is not configured");
    return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }

  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return jsonError("INVALID_SIGNATURE", "署名がありません。", 400);
  }

  // raw body は 1 回だけ取得（署名検証に未加工の文字列を使う）。
  const rawBody = await request.text();

  let stripe: Stripe;
  try {
    stripe = getStripe(env);
  } catch (err) {
    if (err instanceof StripeConfigError) {
      console.error("[webhook] stripe config error:", err.message);
      return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
    }
    throw err;
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      webhookSecret,
      undefined,
      getCryptoProvider(),
    );
  } catch {
    console.error("[webhook] signature verification failed");
    return jsonError("INVALID_SIGNATURE", "署名の検証に失敗しました。", 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const r = await fulfillCheckoutSession(env, session.id, "webhook");
        return jsonOk({ received: true, handled: true, outcome: r.outcome });
      }
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleSessionExpired(env, session.id);
        return jsonOk({ received: true, handled: true });
      }
      // refund 関連（2024-10-28 Acacia 以降は refund.* が全 refund で発火）
      case "charge.refunded":
      case "refund.created":
      case "refund.updated":
      case "refund.failed": {
        await handleRefundEvent(env, event);
        return jsonOk({ received: true, handled: true });
      }
      // dispute 関連
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed": {
        await handleDisputeEvent(env, event);
        return jsonOk({ received: true, handled: true });
      }
      // 将来の遅延決済（現状は即時決済のみ）。
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
        return jsonOk({ received: true, handled: false });
      default:
        return jsonOk({ received: true, handled: false });
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error("[webhook] fulfillment inconsistency:", err.code, err.message);
      return jsonError(err.code, "処理できませんでした。", err.status);
    }
    if (err instanceof PriceConfigError) {
      console.error("[webhook] price config error:", err.message);
      return jsonError("INTERNAL_ERROR", "処理できませんでした。", 500);
    }
    throw err;
  }
}

/**
 * checkout.session.expired: 対応 attempt を EXPIRED にし lock を解放する。
 * attempt が無い（既に処理済み・別経路）場合は何もしない（冪等）。
 */
async function handleSessionExpired(env: Env, sessionId: string): Promise<void> {
  const db = getDb(env);
  const row = await db
    .prepare("SELECT ATTEMPT_ID, STATUS FROM T_CHECKOUT_ATTEMPT WHERE STRIPE_SESSION_ID = ?")
    .bind(sessionId)
    .first<{ ATTEMPT_ID: number; STATUS: number }>();
  if (!row) return;
  // PAID 済みは触らない（保護）。それ以外は EXPIRED + lock 解放。
  if (row.STATUS === 2) return;
  await expireAttempt(env, row.ATTEMPT_ID);
}

/** payment_intent（string|object|null）から ID を取り出す。 */
function extractPaymentIntentId(pi: unknown): string | null {
  if (typeof pi === "string") return pi;
  if (pi && typeof pi === "object" && "id" in pi) {
    const id = (pi as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/** PaymentIntent ID から注文を逆引き（無ければ null）。 */
async function lookupOrderByPaymentIntent(
  env: Env,
  paymentIntentId: string | null,
): Promise<{ ORDER_ID: number; AUTH_USER_ID: string } | null> {
  if (!paymentIntentId) return null;
  const db = getDb(env);
  const row = await db
    .prepare(
      "SELECT ORDER_ID, AUTH_USER_ID FROM T_ORDER WHERE PAYMENT_INTENT_ID = ? AND DEL_FLG = 0",
    )
    .bind(paymentIntentId)
    .first<{ ORDER_ID: number; AUTH_USER_ID: string }>();
  return row ?? null;
}

/**
 * refund 関連イベントを T_PAYMENT_EVENT へ記録する（event.id 冪等・自動剥奪しない）。
 * Charge/Refund の payment_intent から注文を逆引きする。
 */
async function handleRefundEvent(env: Env, event: Stripe.Event): Promise<void> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const paymentIntentId = extractPaymentIntentId(obj.payment_intent);
  const order = await lookupOrderByPaymentIntent(env, paymentIntentId);
  const objId = typeof obj.id === "string" ? obj.id : null;
  const amount =
    typeof obj.amount === "number"
      ? obj.amount
      : typeof obj.amount_refunded === "number"
        ? obj.amount_refunded
        : null;
  const status = typeof obj.status === "string" ? obj.status : null;
  const reason = typeof obj.reason === "string" ? obj.reason : null;
  await recordPaymentEvent(env, {
    eventType: PAYMENT_EVENT_TYPE.REFUND,
    authUserId: order?.AUTH_USER_ID ?? null,
    orderId: order?.ORDER_ID ?? null,
    paymentIntentId,
    stripeObjectId: objId,
    stripeEventId: event.id,
    stripeRequestId: event.request?.id ?? null,
    status,
    amount,
    detail: `${event.type}${reason ? ` reason=${reason}` : ""}`,
  });
}

/**
 * dispute 関連イベントを T_PAYMENT_EVENT へ記録する（event.id 冪等・自動剥奪しない）。
 */
async function handleDisputeEvent(env: Env, event: Stripe.Event): Promise<void> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const paymentIntentId = extractPaymentIntentId(obj.payment_intent);
  const order = await lookupOrderByPaymentIntent(env, paymentIntentId);
  const objId = typeof obj.id === "string" ? obj.id : null;
  const amount = typeof obj.amount === "number" ? obj.amount : null;
  const status = typeof obj.status === "string" ? obj.status : null;
  const reason = typeof obj.reason === "string" ? obj.reason : null;
  await recordPaymentEvent(env, {
    eventType: PAYMENT_EVENT_TYPE.DISPUTE,
    authUserId: order?.AUTH_USER_ID ?? null,
    orderId: order?.ORDER_ID ?? null,
    paymentIntentId,
    stripeObjectId: objId,
    stripeEventId: event.id,
    stripeRequestId: event.request?.id ?? null,
    status,
    amount,
    detail: `${event.type}${reason ? ` reason=${reason}` : ""}`,
  });
}

/**
 * テスト用エクスポート（本番コードからは使用しない）。
 * 検証ロジックは stripe_fulfill.ts の共通版を参照する。
 */
export const __testonly = {
  verifyLineItemsAndResolve,
  retrieveAndValidateCheckoutSession,
  epochToJstIso,
};
