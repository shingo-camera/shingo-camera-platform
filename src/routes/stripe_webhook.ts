/**
 * Stripe Webhook ルート
 *   POST /api/stripe/webhook  （利用者 JWT 不要、Stripe 署名検証必須）
 *
 * 設計根拠: api/PURCHASE_API.md 3, adr/ADR-007, REVIEW_RULE.md 4
 *
 * 重要:
 * - raw request body を変更せず使用する（署名検証のため text() は 1 回だけ呼ぶ）。
 * - 署名検証は Stripe 公式 SDK の constructEventAsync + createSubtleCryptoProvider。
 * - checkout.session.completed かつ payment_status=paid の場合のみ権限付与。
 * - 冪等: 同じ Webhook 再送は「処理済み」として 200 を返す。
 * - 権限付与の正本は Webhook のみ（完了画面から付与しない）。
 * - 将来の遅延決済追加時は async_payment_succeeded で成立させる構成へ拡張可能。
 */

import Stripe from "stripe";
import { getStripe, getCryptoProvider, StripeConfigError } from "../shared/stripe";
import { fulfillCheckout, resolvePriceId } from "../shared/purchase";
import { AppError } from "../shared/errors";
import { nowIso } from "../shared/datetime";
import { jsonOk, jsonError } from "../shared/response";
import type { Env } from "../index";

/** Stripe の epoch 秒を JST ISO 文字列へ変換 */
function epochToJstIso(epochSec: number): string {
  const JST_OFFSET_MIN = 9 * 60;
  const jst = new Date(epochSec * 1000 + JST_OFFSET_MIN * 60 * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const y = jst.getUTCFullYear();
  const mo = p2(jst.getUTCMonth() + 1);
  const d = p2(jst.getUTCDate());
  const h = p2(jst.getUTCHours());
  const mi = p2(jst.getUTCMinutes());
  const s = p2(jst.getUTCSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}

/**
 * POST /api/stripe/webhook
 */
export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  // Webhook Secret 未設定は内部設定エラー（利用者へ詳細を返さない）
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET is not configured");
    return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }

  // 署名ヘッダー
  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return jsonError("INVALID_SIGNATURE", "署名がありません。", 400);
  }

  // raw body は 1 回だけ取得（body は一度しか読めない）。署名検証に未加工の文字列を使う。
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

  // 署名検証（公式 SDK・Web Crypto）。tolerance 等は SDK 標準に従う。
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      webhookSecret,
      undefined,
      getCryptoProvider(),
    );
  } catch (err) {
    // 署名不正は 400（内部詳細は返さない）
    console.error("[webhook] signature verification failed");
    return jsonError("INVALID_SIGNATURE", "署名の検証に失敗しました。", 400);
  }

  // イベント種別で分岐。初期対象は購入成立に必要な範囲。
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        return await handleSessionCompleted(env, stripe, session);
      }
      // 将来の遅延決済のための拡張ポイント（現状は即時決済のみ）。
      // completed で payment_status=paid を確認するため、ここでは受理して 200 を返す。
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired":
        return jsonOk({ received: true, handled: false });
      default:
        // 対象外イベントは受理のみ（200）。二重送信・想定外でもエラーにしない。
        return jsonOk({ received: true, handled: false });
    }
  } catch (err) {
    if (err instanceof AppError) {
      // 不整合（USER_NOT_FOUND / PRODUCT_NOT_FOUND 等）は内部エラーとして記録し、
      // 権限付与しない。Stripe には 400 を返し、再送では冪等に扱う。
      console.error("[webhook] fulfillment inconsistency:", err.code, err.message);
      return jsonError(err.code, "処理できませんでした。", err.status);
    }
    throw err;
  }
}

/**
 * checkout.session.completed の処理。
 * payment_status=paid の場合のみ権限付与。
 */
async function handleSessionCompleted(
  env: Env,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<Response> {
  // payment_status=paid のみ成立（unpaid 等は付与しない）
  if (session.payment_status !== "paid") {
    // 未払い完了（遅延決済など）は現状では付与しない。受理のみ。
    return jsonOk({ received: true, handled: false });
  }

  // metadata 検証
  const authUserId = session.metadata?.auth_user_id;
  const productCode = session.metadata?.product_code;
  if (!authUserId || !productCode) {
    console.error("[webhook] metadata missing");
    return jsonError("METADATA_MISSING", "処理できませんでした。", 400);
  }

  // 期待 Price ID をサーバー側 env から解決（未設定は内部不整合）
  const expectedPriceId = resolvePriceId(env, productCode);
  if (!expectedPriceId) {
    // Price 未設定・未対応商品。権限付与せず内部不整合として記録（詳細は返さない）。
    console.error("[webhook] price id not configured for product_code:", productCode);
    return jsonError("INTERNAL_ERROR", "処理できませんでした。", 500);
  }

  // 金額・Price 照合のため、署名検証済み Session を Stripe から再取得し line_items を展開する。
  // クライアント値（payload の amount_total 等）を信用せず、Stripe 側の確定値で照合する。
  // 1 Session につき 1 回のみの API 呼び出し。
  // line_items.data[].price は Line Item 内に Price オブジェクトとして含まれるため、
  // line_items のみを expand する（line_items.data.price の追加 expand は不要）。
  let full: Stripe.Checkout.Session;
  try {
    full = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["line_items"],
    });
  } catch (err) {
    console.error("[webhook] failed to retrieve session for price verification");
    return jsonError("INTERNAL_ERROR", "処理できませんでした。", 500);
  }

  // 照合結果が不一致なら権限付与せず内部不整合として記録（Secret/内部 Price 情報は返さない）
  const mismatch = verifyAmountAndPrice(full, expectedPriceId);
  if (mismatch) {
    console.error("[webhook] amount/price mismatch:", mismatch);
    return jsonError("INTERNAL_ERROR", "処理できませんでした。", 500);
  }

  // 照合済みの確定値を使用（Stripe 側の値。クライアント値は使わない）
  const sessionId = full.id;
  const amountTotal = typeof full.amount_total === "number" ? full.amount_total : 0;
  const purchaseDate =
    typeof full.created === "number" ? epochToJstIso(full.created) : nowIso();

  const result = await fulfillCheckout(env, {
    authUserId,
    productCode,
    sessionId,
    amountTotal,
    purchaseDate,
  });

  return jsonOk({ received: true, handled: true, alreadyProcessed: result.alreadyProcessed });
}

/**
 * 金額・Price・通貨の照合。不一致があれば内部ログ用の理由文字列を返す（利用者には返さない）。
 * 一致すれば null。
 *
 * WORK-007 初期仕様（割引・Stripe Tax・複数量販売は使わない）として固定:
 * - line_items がちょうど 1 件（買い切り 1 商品）
 * - line_items[0].quantity が厳密に 1（null / undefined / 1 以外は不整合）
 * - その price.id が期待 Price ID と一致
 * - price.currency が jpy かつ session.currency が jpy
 * - price.unit_amount が null でない
 * - session.amount_total が price.unit_amount と一致（quantity=1 のため乗算不要）
 * 将来、割引・Tax・複数量販売を導入する場合は別途仕様変更する。
 *
 * @param session line_items を expand 済みの Checkout Session
 * @param expectedPriceId サーバー側の期待 Price ID
 * @returns 不一致理由（内部ログ用）／一致なら null
 */
function verifyAmountAndPrice(session: Stripe.Checkout.Session, expectedPriceId: string): string | null {
  const items = session.line_items?.data ?? [];
  if (items.length !== 1) {
    return `line_items count is ${items.length}, expected 1`;
  }
  const item = items[0];

  // quantity は厳密に 1（fallback しない。null/undefined/1 以外は不整合）
  if (item.quantity !== 1) {
    return `quantity is ${item.quantity}, expected exactly 1`;
  }

  const price = item.price;
  if (!price || typeof price !== "object") {
    return "line item price is missing";
  }

  // Price ID 一致
  if (price.id !== expectedPriceId) {
    return "price id mismatch";
  }

  // 通貨 JPY 一致（Price 側とセッション側の両方）
  if (price.currency !== "jpy") {
    return `price currency is ${price.currency}, expected jpy`;
  }
  if (session.currency !== "jpy") {
    return `session currency is ${session.currency}, expected jpy`;
  }

  // 期待金額（quantity=1 のため unit_amount と amount_total の一致）
  if (typeof price.unit_amount !== "number") {
    return "price unit_amount is null";
  }
  if (session.amount_total !== price.unit_amount) {
    return `amount_total ${session.amount_total} != unit_amount ${price.unit_amount}`;
  }

  return null;
}

/**
 * テスト用エクスポート（本番コードからは使用しない）。
 * 金額・Price 照合ロジックを実コードのまま検証するために公開する。
 */
export const __testonly = {
  handleSessionCompleted,
  verifyAmountAndPrice,
  epochToJstIso,
};
