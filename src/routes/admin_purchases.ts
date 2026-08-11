/**
 * 管理者向け購入救済・注文追跡（WORK-011）
 *
 * - POST /api/admin/purchases/reconcile { sessionId }
 *     Session ID から共通 fulfill を実行し結果種別を返す（DB 直接編集しない）。
 * - GET  /api/admin/orders               注文一覧（最新順）
 * - GET  /api/admin/orders/{orderId}     注文詳細（明細・PaymentIntent・payment_event）
 * - GET  /api/admin/payment-events       決済運用イベント一覧（B2/duplicate/refund/dispute 追跡）
 *
 * 過剰な ERP 化はしない。最低限の追跡・救済のみ。
 */

import { requireAdmin } from "../shared/admin";
import { AppError, ValidationError } from "../shared/errors";
import { jsonOk, jsonError } from "../shared/response";
import { getDb } from "../shared/db";
import { StripeConfigError } from "../shared/stripe";
import { fulfillCheckoutSession } from "../shared/stripe_fulfill";
import { recordPaymentEvent, PAYMENT_EVENT_TYPE } from "../shared/checkout_attempt";
import { PriceConfigError } from "../shared/purchase";
import type { Env } from "../index";

function toAdminError(err: unknown): Response {
  if (err instanceof ValidationError) {
    return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, err.fields);
  }
  if (err instanceof AppError) {
    return jsonError(err.code, err.message, err.status);
  }
  if (err instanceof StripeConfigError || err instanceof PriceConfigError) {
    console.error("[admin_purchases] config error:", err.message);
    return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
  throw err;
}

function isValidSessionId(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("cs_") && v.length <= 200;
}

/**
 * POST /api/admin/purchases/reconcile { sessionId }
 * Session ID から共通 fulfill を実行。結果種別を返す。
 */
export async function handleAdminReconcile(request: Request, env: Env): Promise<Response> {
  try {
    await requireAdmin(request, env);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError({ sessionId: "セッションIDが不正です。" });
    }
    const sessionId =
      body && typeof body === "object" ? (body as Record<string, unknown>).sessionId : undefined;
    if (!isValidSessionId(sessionId)) {
      throw new ValidationError({ sessionId: "セッションIDが不正です。" });
    }

    // 環境不一致（Test/Prod）は Stripe secret で分離される。retrieve 失敗 = invalid_session
    // または wrong_environment。ここでは fulfill の invalid_session に集約し detail で示す。
    const r = await fulfillCheckoutSession(env, sessionId, "admin");

    // reconcile 実行を記録（監査）
    await recordPaymentEvent(env, {
      eventType: PAYMENT_EVENT_TYPE.RECONCILE,
      stripeSessionId: sessionId,
      status: r.outcome,
      detail: r.detail ?? null,
    });

    return jsonOk({ result: r.outcome, detail: r.detail ?? null });
  } catch (err) {
    return toAdminError(err);
  }
}

/** GET /api/admin/orders 注文一覧（最新 100 件） */
export async function handleAdminOrders(request: Request, env: Env): Promise<Response> {
  try {
    await requireAdmin(request, env);
    const db = getDb(env);
    const res = await db
      .prepare(
        `SELECT ORDER_ID, AUTH_USER_ID, PURCHASE_SOURCE, EXTERNAL_ORDER_ID, PAYMENT_INTENT_ID,
                ORDER_DATE, TOTAL_AMOUNT, PAYMENT_STATUS, REFUND_DATE
         FROM T_ORDER
         WHERE DEL_FLG = 0
         ORDER BY ORDER_DATE DESC
         LIMIT 100`,
      )
      .all();
    return jsonOk({ orders: res.results ?? [] });
  } catch (err) {
    return toAdminError(err);
  }
}

/** GET /api/admin/orders/{orderId} 注文詳細（明細 + payment_event） */
export async function handleAdminOrderDetail(
  request: Request,
  env: Env,
  orderId: number,
): Promise<Response> {
  try {
    await requireAdmin(request, env);
    const db = getDb(env);
    const order = await db
      .prepare(
        `SELECT ORDER_ID, AUTH_USER_ID, PURCHASE_SOURCE, EXTERNAL_ORDER_ID, PAYMENT_INTENT_ID,
                ORDER_DATE, TOTAL_AMOUNT, PAYMENT_STATUS, REFUND_DATE
         FROM T_ORDER WHERE ORDER_ID = ?`,
      )
      .bind(orderId)
      .first();
    if (!order) {
      return jsonError("ORDER_NOT_FOUND", "注文が見つかりません。", 404);
    }
    const items = await db
      .prepare(
        `SELECT p.PURCHASE_ID, p.PRODUCT_ID, m.PRODUCT_CODE, m.PRODUCT_NAME,
                p.AMOUNT, p.PAYMENT_STATUS, p.PURCHASE_DATE
         FROM T_PURCHASE p
         JOIN M_PRODUCT m ON m.PRODUCT_ID = p.PRODUCT_ID
         WHERE p.ORDER_ID = ?
         ORDER BY m.SORT_NO ASC`,
      )
      .bind(orderId)
      .all();
    const events = await db
      .prepare(
        `SELECT PAYMENT_EVENT_ID, EVENT_TYPE, STRIPE_OBJECT_ID, STRIPE_EVENT_ID,
                STATUS, AMOUNT, DETAIL, CREATE_DATE
         FROM T_PAYMENT_EVENT WHERE ORDER_ID = ? ORDER BY CREATE_DATE DESC`,
      )
      .bind(orderId)
      .all();
    return jsonOk({ order, items: items.results ?? [], paymentEvents: events.results ?? [] });
  } catch (err) {
    return toAdminError(err);
  }
}

/** GET /api/admin/payment-events 決済運用イベント一覧（最新 100 件） */
export async function handleAdminPaymentEvents(request: Request, env: Env): Promise<Response> {
  try {
    await requireAdmin(request, env);
    const db = getDb(env);
    const res = await db
      .prepare(
        `SELECT PAYMENT_EVENT_ID, EVENT_TYPE, AUTH_USER_ID, ORDER_ID, STRIPE_SESSION_ID,
                PAYMENT_INTENT_ID, STRIPE_OBJECT_ID, STRIPE_EVENT_ID, STRIPE_REQUEST_ID,
                STATUS, AMOUNT, DETAIL, NOTIFIED_DATE, CREATE_DATE
         FROM T_PAYMENT_EVENT
         WHERE DEL_FLG = 0
         ORDER BY CREATE_DATE DESC
         LIMIT 100`,
      )
      .all();
    return jsonOk({ paymentEvents: res.results ?? [] });
  } catch (err) {
    return toAdminError(err);
  }
}
