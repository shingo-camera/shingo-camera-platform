/**
 * 共通 fulfillment（webhook / success recovery / admin reconcile の 3 経路が同一ロジックを通る）
 *
 * 確定設計:
 * - 検証ロジックを 3 箇所へコピーしない。Webhook 固有は署名検証のみ。
 * - Session 再取得 / line_items 検証 / Price 逆引き / 金額照合 / DB 反映を本モジュールへ集約。
 * - 既存 fulfillMultiCheckout（Session ID 冪等・原子的 batch）をそのまま活かす。
 * - PAYMENT_INTENT_ID を T_ORDER に保存（refund/dispute 逆引き）。
 * - 二重 paid を fulfill 時に検出し、entitlement は 1 件維持しつつ記録・通知（自動返金しない）。
 * - 付与成立時は対応する attempt を PAID にし lock を解放する。
 */

import Stripe from "stripe";
import { getStripe } from "./stripe";
import {
  fulfillMultiCheckout,
  buildPriceIdToCodeMap,
  PriceConfigError,
  type FulfillItem,
} from "./purchase";
import { getActiveProductByCode } from "./entitlement";
import { nowIso } from "./datetime";
import { getDb } from "./db";
import {
  detectDuplicatePaidProductIds,
  recordPaymentEvent,
  markAttemptPaid,
  markAttemptPaidWithSession,
  getAttemptByOperationId,
  getAttemptItems,
  buildPriceIdToCodeMapFromAttempt,
  buildCartKey,
  ATTEMPT_STATUS,
  PAYMENT_EVENT_TYPE,
} from "./checkout_attempt";
import type { Env } from "../index";

/** Stripe の epoch 秒を JST ISO 文字列へ変換 */
export function epochToJstIso(epochSec: number): string {
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

/** 検証成功時の確定明細 */
export interface VerifiedItem {
  productCode: string;
  unitAmount: number;
}

/** 検証成功結果 */
export interface VerifiedOrder {
  items: VerifiedItem[];
}

/**
 * line_items を検証し、Price 逆引きで付与対象商品を確定する。
 * - line_items が 1 件以上 / 各 quantity===1 / price.id 存在 / currency jpy / unit_amount number /
 *   Price ID がサーバー既知 / 同一 PRODUCT_CODE の重複なし / session.currency jpy /
 *   全 unit_amount 合計 == amount_total
 * @returns 確定明細 or 不一致理由（内部ログ用）
 */
export function verifyLineItemsAndResolve(
  session: Stripe.Checkout.Session,
  priceIdToCode: Map<string, string>,
): VerifiedOrder | string {
  const items = session.line_items?.data ?? [];
  if (items.length < 1) return `line_items count is ${items.length}, expected >= 1`;
  if (session.currency !== "jpy") return `session currency is ${session.currency}, expected jpy`;

  const verified: VerifiedItem[] = [];
  const seenCodes = new Set<string>();
  let sum = 0;

  for (const item of items) {
    if (item.quantity !== 1) return `quantity is ${item.quantity}, expected exactly 1`;
    const price = item.price;
    if (!price || typeof price !== "object") return "line item price is missing";
    if (!price.id) return "line item price id is missing";
    if (price.currency !== "jpy") return `price currency is ${price.currency}, expected jpy`;
    if (typeof price.unit_amount !== "number") return "price unit_amount is null";
    const code = priceIdToCode.get(price.id);
    if (!code) return "unknown price id in line item";
    if (seenCodes.has(code)) return `duplicate product in line items: ${code}`;
    seenCodes.add(code);
    verified.push({ productCode: code, unitAmount: price.unit_amount });
    sum += price.unit_amount;
  }

  if (session.amount_total !== sum) {
    return `amount_total ${session.amount_total} != sum of unit_amount ${sum}`;
  }
  return { items: verified };
}

/** retrieve+検証の結果 */
export type ValidatedSession =
  | {
      ok: true;
      authUserId: string;
      sessionId: string;
      totalAmount: number;
      purchaseDate: string;
      paymentIntentId: string | null;
      /** client_reference_id（= operationId。CASE C の attempt 再特定に使用） */
      clientReferenceId: string | null;
      items: FulfillItem[];
    }
  | { ok: false; reason: "not_paid" | "invalid_session"; detail?: string };

/**
 * Session を Stripe から expand 取得し、検証して付与対象を確定する。
 * クライアント値・metadata を信用せず、Stripe 側の確定値で照合する。
 */
export async function retrieveAndValidateCheckoutSession(
  env: Env,
  sessionId: string,
): Promise<ValidatedSession> {
  const stripe = getStripe(env);

  let full: Stripe.Checkout.Session;
  try {
    full = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "line_items.data.price"],
    });
  } catch {
    return { ok: false, reason: "invalid_session", detail: "retrieve failed" };
  }

  if (full.payment_status !== "paid") {
    return { ok: false, reason: "not_paid" };
  }

  const authUserId = full.metadata?.auth_user_id;
  if (!authUserId) {
    return { ok: false, reason: "invalid_session", detail: "metadata auth_user_id missing" };
  }

  const clientReferenceId =
    typeof full.client_reference_id === "string" ? full.client_reference_id : null;

  // Price ID → 商品コードの逆引きは「Checkout 開始時に保存した attempt snapshot」を正本にする。
  // これにより、Checkout 開始後に M_PRODUCT.STRIPE_PRICE_ID が変更されても、旧 Session の
  // line item price を snapshot から正しく解決でき、決済済み Session を正常 fulfill できる。
  const snap = await buildPriceIdToCodeMapFromAttempt(env, full.id, clientReferenceId);
  let priceIdToCode: Map<string, string>;
  if (snap.status === "resolved") {
    // 通常経路: snapshot を正本に解決。現在の M_PRODUCT には一切依存しない。
    priceIdToCode = snap.map;
  } else if (snap.status === "invalid") {
    // attempt は特定できたが snapshot が不正（item なし / 空 Price / 重複割当）。
    // ここで現在の M_PRODUCT へ fallback すると Price 変更後に誤付与し得るため、安全側でエラーにする。
    return { ok: false, reason: "invalid_session", detail: `attempt snapshot invalid: ${snap.detail}` };
  } else {
    // not_found: SID / operationId のどちらでも attempt を特定できない、限定された互換経路のみ。
    // 新方式の正常な Checkout では attempt + snapshot が必ず存在するため通常ここには来ない。
    // この場合に限り、unknown price で権限付与不能になるのを避けるため現在の M_PRODUCT で解決を試みる。
    priceIdToCode = await buildPriceIdToCodeMap(env);
  }
  if (priceIdToCode.size === 0) {
    return { ok: false, reason: "invalid_session", detail: "no price ids configured" };
  }

  const verified = verifyLineItemsAndResolve(full, priceIdToCode);
  if (typeof verified === "string") {
    return { ok: false, reason: "invalid_session", detail: verified };
  }

  const items: FulfillItem[] = [];
  for (const v of verified.items) {
    const product = await getActiveProductByCode(env, v.productCode);
    if (!product) {
      return { ok: false, reason: "invalid_session", detail: `product not found: ${v.productCode}` };
    }
    items.push({ productCode: v.productCode, productId: product.PRODUCT_ID, amount: v.unitAmount });
  }

  const paymentIntentId =
    typeof full.payment_intent === "string"
      ? full.payment_intent
      : full.payment_intent && typeof full.payment_intent === "object"
        ? full.payment_intent.id
        : null;

  return {
    ok: true,
    authUserId,
    sessionId: full.id,
    totalAmount: typeof full.amount_total === "number" ? full.amount_total : 0,
    purchaseDate: typeof full.created === "number" ? epochToJstIso(full.created) : nowIso(),
    paymentIntentId,
    clientReferenceId,
    items,
  };
}

/** fulfillCheckoutSession の結果種別 */
export type FulfillOutcome =
  | "newly_fulfilled"
  | "already_fulfilled"
  | "not_paid"
  | "invalid_session"
  | "duplicate_detected"
  | "inconsistent_data";

/** fulfillCheckoutSession の戻り値 */
export interface FulfillCheckoutResult {
  outcome: FulfillOutcome;
  detail?: string;
  /** 今回 Session の購入商品コード（success 画面の全商品追跡に使用）。paid 検証成功時のみ。 */
  productCodes?: string[];
}

/**
 * Session ID を受けて付与を行う共通関数（webhook / recovery / admin から呼ぶ）。
 * 冪等（同一 Session の再実行は already_fulfilled）。paid のみ付与。
 *
 * @param context "webhook" | "recovery" | "admin"（ログ・記録の文脈用）
 */
export async function fulfillCheckoutSession(
  env: Env,
  sessionId: string,
  context: "webhook" | "recovery" | "admin",
): Promise<FulfillCheckoutResult> {
  // 1. Stripe 側の確定値で検証
  const v = await retrieveAndValidateCheckoutSession(env, sessionId);
  if (!v.ok) {
    if (v.reason === "not_paid") return { outcome: "not_paid" };
    return { outcome: "invalid_session", detail: v.detail };
  }

  // 2. 二重 paid 検出（別注文で既に paid 済みの商品が含まれるか）
  const productIds = v.items.map((it) => it.productId);
  const dupProductIds = await detectDuplicatePaidProductIds(
    env,
    v.authUserId,
    productIds,
    v.sessionId,
  );

  // 3. fulfill（Session ID 冪等・原子的 batch・PAYMENT_INTENT_ID 保存）
  let alreadyProcessed = false;
  try {
    const r = await fulfillMultiCheckout(env, {
      authUserId: v.authUserId,
      sessionId: v.sessionId,
      totalAmount: v.totalAmount,
      purchaseDate: v.purchaseDate,
      items: v.items,
      paymentIntentId: v.paymentIntentId,
    });
    alreadyProcessed = r.alreadyProcessed;
  } catch (e) {
    // USER_NOT_FOUND / NO_FULFILL_ITEMS 等の不整合。付与しない。記録して調査対象へ。
    await recordPaymentEvent(env, {
      eventType: PAYMENT_EVENT_TYPE.FULFILL_FAILURE,
      authUserId: v.authUserId,
      stripeSessionId: v.sessionId,
      paymentIntentId: v.paymentIntentId,
      detail: `${context}: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { outcome: "inconsistent_data", detail: e instanceof Error ? e.message : String(e) };
  }

  // 4. 付与成立 → 対応 attempt を PAID にし lock 解放（SID 一致 / CASE C の operationId 再特定）
  await reconcileAttemptForSession(env, {
    sessionId: v.sessionId,
    authUserId: v.authUserId,
    clientReferenceId: v.clientReferenceId,
    items: v.items,
  });

  // 今回 Session の購入商品コード（success 画面の全商品追跡に使用）
  const productCodes = v.items.map((it) => it.productCode);

  // 5. 二重 paid が検出されていた場合は記録・通知（entitlement は 1 件維持済み。自動返金しない）
  if (dupProductIds.length > 0) {
    const orderId = await lookupOrderIdBySession(env, v.sessionId);
    await recordPaymentEvent(env, {
      eventType: PAYMENT_EVENT_TYPE.DUPLICATE_PAID,
      authUserId: v.authUserId,
      orderId,
      stripeSessionId: v.sessionId,
      paymentIntentId: v.paymentIntentId,
      amount: v.totalAmount,
      detail: `duplicate paid product_ids: ${dupProductIds.join(",")} (${context})`,
    });
    return { outcome: "duplicate_detected", detail: `product_ids: ${dupProductIds.join(",")}`, productCodes };
  }

  return { outcome: alreadyProcessed ? "already_fulfilled" : "newly_fulfilled", productCodes };
}

/** Session ID から T_ORDER.ORDER_ID を引く（記録用）。 */
async function lookupOrderIdBySession(env: Env, sessionId: string): Promise<number | null> {
  const db = getDb(env);
  const row = await db
    .prepare("SELECT ORDER_ID FROM T_ORDER WHERE PURCHASE_SOURCE = 0 AND EXTERNAL_ORDER_ID = ?")
    .bind(sessionId)
    .first<{ ORDER_ID: number }>();
  return row?.ORDER_ID ?? null;
}

/**
 * 付与成立時に対応 attempt を PAID にし lock を解放する。
 *
 * 第一経路: STRIPE_SESSION_ID 一致（通常）。
 * 第二経路（CASE C: SID 保存失敗）: SID で見つからない場合、client_reference_id(=operationId) で
 *   attempt を再特定する。ただし client_reference_id だけで所有断定せず、以下を全て照合する:
 *     1. OPERATION_ID 一致（getAttemptByOperationId）
 *     2. Session 検証済み AUTH_USER_ID == ATTEMPT.AUTH_USER_ID
 *     3. Stripe 実 line_items の商品構成 == ATTEMPT_ITEM snapshot（CART_KEY）== ATTEMPT.CART_KEY
 *   一致した場合のみ SID 回収 → PAID → lock 解放（attempt/lock の残留を防ぐ）。
 */
export async function reconcileAttemptForSession(
  env: Env,
  v: {
    sessionId: string;
    authUserId: string;
    clientReferenceId: string | null;
    items: FulfillItem[];
  },
): Promise<void> {
  const db = getDb(env);

  // 第一経路: SID 一致
  const bySid = await db
    .prepare("SELECT ATTEMPT_ID FROM T_CHECKOUT_ATTEMPT WHERE STRIPE_SESSION_ID = ?")
    .bind(v.sessionId)
    .first<{ ATTEMPT_ID: number }>();
  if (bySid) {
    await markAttemptPaid(env, bySid.ATTEMPT_ID);
    return;
  }

  // 第二経路（CASE C）: operationId で再特定
  const opId = v.clientReferenceId;
  if (!opId) return; // 特定不能（安全側で何もしない。管理者 reconcile で回収可能）

  const attempt = await getAttemptByOperationId(env, opId);
  if (!attempt) return;
  if (attempt.STATUS === ATTEMPT_STATUS.PAID) return; // 既に処理済み

  // 照合1: 所有者
  if (attempt.AUTH_USER_ID !== v.authUserId) return;

  // 照合2/3: 商品構成（Stripe 実 line_items と ATTEMPT_ITEM snapshot を正本に）
  const attemptItems = await getAttemptItems(env, attempt.ATTEMPT_ID);
  const attemptKey = buildCartKey(attemptItems.map((it) => it.PRODUCT_CODE));
  const sessionKey = buildCartKey(v.items.map((it) => it.productCode));
  if (attemptKey !== sessionKey) return; // 実 line_items ≠ snapshot
  if (attempt.CART_KEY !== sessionKey) return; // 保存済み CART_KEY とも一致必須

  // 全一致 → SID 回収 + PAID + lock 解放
  await markAttemptPaidWithSession(env, attempt.ATTEMPT_ID, v.sessionId);
}

/** PriceConfigError を呼出側で判別するための re-export。 */
export { PriceConfigError };
