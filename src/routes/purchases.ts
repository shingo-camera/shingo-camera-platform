/**
 * 購入 API ルート
 *   POST /api/purchases/checkout  Checkout Session 作成（認証必須）
 *   GET  /api/purchases/status    購入反映状況の確認（認証必須）
 *
 * 設計根拠: api/PURCHASE_API.md 2/4/5
 *
 * 決済手段は Stripe Dashboard の Payment methods 設定を正とし、
 * payment_method_types をコードで固定しない（card / 将来の PayPay 等は Dashboard 管理）。
 */

import { requireUser, AuthError } from "../shared/auth";
import { AppError, ValidationError } from "../shared/errors";
import { jsonOk, jsonError } from "../shared/response";
import { validateJson, type Schema } from "../shared/validate";
import { getStripe, StripeConfigError } from "../shared/stripe";
import { precheckCheckout, isProductAvailable, resolvePriceId } from "../shared/purchase";
import type { Env } from "../index";

/** AuthError / AppError / ValidationError / StripeConfigError を共通レスポンスへ変換 */
function toErrorResponse(err: unknown): Response {
  if (err instanceof ValidationError) {
    return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, err.fields);
  }
  if (err instanceof AuthError) {
    return jsonError(err.code, err.message, err.status);
  }
  if (err instanceof AppError) {
    return jsonError(err.code, err.message, err.status);
  }
  if (err instanceof StripeConfigError) {
    console.error("[purchase] stripe config error:", err.message);
    return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
  throw err;
}

/** POST /api/purchases/checkout の入力 */
const CHECKOUT_SCHEMA: Schema = {
  productCode: { type: "string", required: true, maxLength: 64 },
};

/**
 * Checkout Session を作成する。
 *
 * 金額・Price ID・AUTH_USER_ID はクライアントから受け取らない。
 * - AUTH_USER_ID: requireUser の JWT から取得
 * - Price ID: サーバー側 env（Cloudflare Secret）から取得
 * - metadata: auth_user_id / product_code
 */
export async function handleCheckout(request: Request, env: Env): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env);
    const data = await validateJson(request, CHECKOUT_SCHEMA);
    const productCode = data.productCode as string;

    // 前提確認（M_USER 有効・商品存在・二重購入防止）
    const { product } = await precheckCheckout(env, auth.authUserId, productCode);

    // Price ID をサーバー側 env から取得（商品ごと。現状は SUN_AND_MOON のみ）
    const priceId = resolvePriceId(env, product.PRODUCT_CODE);
    if (!priceId) {
      console.error("[purchase] price id not configured for", product.PRODUCT_CODE);
      return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
    }

    // success/cancel URL（productCode を URL encode）
    const origin = new URL(request.url).origin;
    const encoded = encodeURIComponent(product.PRODUCT_CODE);
    const successUrl = `${origin}/purchase/success/?productCode=${encoded}`;
    const cancelUrl = `${origin}/purchase/cancel/?productCode=${encoded}`;

    const stripe = getStripe(env);
    // payment_method_types は指定しない（Dashboard の Payment methods 設定を正とする）
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        auth_user_id: auth.authUserId,
        product_code: product.PRODUCT_CODE,
      },
    });

    if (!session.url) {
      console.error("[purchase] checkout session has no url");
      return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
    }

    return jsonOk({ checkoutUrl: session.url });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** GET /api/purchases/status?productCode= */
export async function handlePurchaseStatus(request: Request, env: Env): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }

  const url = new URL(request.url);
  const productCode = url.searchParams.get("productCode");
  if (!productCode || productCode.length > 64) {
    return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, {
      productCode: "商品コードを指定してください。",
    });
  }

  // 権限反映状況を available で返す（付与はしない。Webhook が正本）
  const granted = await isProductAvailable(env, auth.authUserId, productCode);

  return jsonOk({ productCode, granted });
}
