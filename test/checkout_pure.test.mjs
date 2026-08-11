// 純関数テスト（DB / Stripe 不要）
// 対象: validateOperationId / buildCartKey / buildIdempotencyKey / classifyCreateError /
//       verifyLineItemsAndResolve / epochToJstIso
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateOperationId,
  buildCartKey,
  buildIdempotencyKey,
  classifyCreateError,
  verifyLineItemsAndResolve,
  epochToJstIso,
} from "./_bundle/purchase_logic.mjs";

/* ---- operationId validation ---- */
test("validateOperationId: 正常な UUID を受理", () => {
  const v = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  assert.equal(validateOperationId(v), v);
});
test("validateOperationId: 前後空白を trim して受理", () => {
  const v = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  assert.equal(validateOperationId("  " + v + "  "), v);
});
test("validateOperationId: 非文字列を拒否", () => {
  assert.throws(() => validateOperationId(123));
  assert.throws(() => validateOperationId(null));
  assert.throws(() => validateOperationId(undefined));
});
test("validateOperationId: 不正形式を拒否（長さ/文字種）", () => {
  assert.throws(() => validateOperationId("not-a-uuid"));
  assert.throws(() => validateOperationId("1b4e28ba2fa111d2883f0016d3cca427")); // ハイフンなし
  assert.throws(() => validateOperationId("1b4e28ba-2fa1-11d2-883f-0016d3cca427-extra")); // 長すぎ
  assert.throws(() => validateOperationId("zb4e28ba-2fa1-11d2-883f-0016d3cca427")); // 不正文字 z
});

/* ---- CART_KEY ---- */
test("buildCartKey: 順序非依存で同一（並べ替えても同じ）", () => {
  const a = buildCartKey(["HANABI", "SUN_AND_MOON"]);
  const b = buildCartKey(["SUN_AND_MOON", "HANABI"]);
  assert.equal(a, b);
});
test("buildCartKey: 商品構成が違えば異なる", () => {
  const a = buildCartKey(["HANABI"]);
  const b = buildCartKey(["HANABI", "HANABI_GOOGLE_EARTH"]);
  assert.notEqual(a, b);
});

/* ---- idempotencyKey ---- */
test("buildIdempotencyKey: 同一 user+operation は同一 key", () => {
  const k1 = buildIdempotencyKey("user-a", "op-1");
  const k2 = buildIdempotencyKey("user-a", "op-1");
  assert.equal(k1, k2);
});
test("buildIdempotencyKey: 別 user は同じ operationId でも別 key（namespace 分離）", () => {
  const k1 = buildIdempotencyKey("user-a", "op-1");
  const k2 = buildIdempotencyKey("user-b", "op-1");
  assert.notEqual(k1, k2);
  assert.ok(k1.startsWith("checkout:user-a:"));
  assert.ok(k2.startsWith("checkout:user-b:"));
});
test("buildIdempotencyKey: 255 文字以内", () => {
  const k = buildIdempotencyKey(
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
  );
  assert.ok(k.length <= 255);
});

/* ---- classifyCreateError（確定設計 ERROR_CLASSIFICATION_FINAL） ---- */
test("classifyCreateError: A 確定失敗（InvalidRequest/Authentication/Permission）", () => {
  assert.equal(classifyCreateError({ type: "StripeInvalidRequestError" }), "CONFIRMED_FAILURE");
  assert.equal(classifyCreateError({ type: "StripeAuthenticationError" }), "CONFIRMED_FAILURE");
  assert.equal(classifyCreateError({ type: "StripePermissionError" }), "CONFIRMED_FAILURE");
});
test("classifyCreateError: RATE_LIMIT", () => {
  assert.equal(classifyCreateError({ type: "StripeRateLimitError" }), "RATE_LIMIT");
});
test("classifyCreateError: INCONSISTENT（idempotency 誤用）", () => {
  assert.equal(classifyCreateError({ type: "StripeIdempotencyError" }), "INCONSISTENT");
});
test("classifyCreateError: B1 NETWORK_INDETERMINATE（connection）", () => {
  assert.equal(classifyCreateError({ type: "StripeConnectionError" }), "NETWORK_INDETERMINATE");
});
test("classifyCreateError: B2 SERVER_INDETERMINATE（APIError/5xx）", () => {
  assert.equal(classifyCreateError({ type: "StripeAPIError" }), "SERVER_INDETERMINATE");
});
test("classifyCreateError: 判定不能は保守的に SERVER_INDETERMINATE（lock 維持側）", () => {
  assert.equal(classifyCreateError({ type: "SomethingUnknown" }), "SERVER_INDETERMINATE");
  assert.equal(classifyCreateError({}), "SERVER_INDETERMINATE");
  assert.equal(classifyCreateError(null), "SERVER_INDETERMINATE");
});

/* ---- verifyLineItemsAndResolve ---- */
function mkSession(over = {}) {
  return {
    currency: "jpy",
    amount_total: 13000,
    line_items: {
      data: [
        { quantity: 1, price: { id: "price_sam", currency: "jpy", unit_amount: 13000 } },
      ],
    },
    ...over,
  };
}
const priceMap = new Map([
  ["price_sam", "SUN_AND_MOON"],
  ["price_hanabi", "HANABI"],
]);

test("verifyLineItemsAndResolve: 正常な単一商品を確定", () => {
  const r = verifyLineItemsAndResolve(mkSession(), priceMap);
  assert.notEqual(typeof r, "string");
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].productCode, "SUN_AND_MOON");
  assert.equal(r.items[0].unitAmount, 13000);
});
test("verifyLineItemsAndResolve: 複数商品と合計照合", () => {
  const s = mkSession({
    amount_total: 17000,
    line_items: {
      data: [
        { quantity: 1, price: { id: "price_sam", currency: "jpy", unit_amount: 13000 } },
        { quantity: 1, price: { id: "price_hanabi", currency: "jpy", unit_amount: 4000 } },
      ],
    },
  });
  const r = verifyLineItemsAndResolve(s, priceMap);
  assert.notEqual(typeof r, "string");
  assert.equal(r.items.length, 2);
});
test("verifyLineItemsAndResolve: quantity!=1 を拒否", () => {
  const s = mkSession();
  s.line_items.data[0].quantity = 2;
  assert.equal(typeof verifyLineItemsAndResolve(s, priceMap), "string");
});
test("verifyLineItemsAndResolve: 未知 Price を拒否", () => {
  const s = mkSession();
  s.line_items.data[0].price.id = "price_unknown";
  assert.equal(typeof verifyLineItemsAndResolve(s, priceMap), "string");
});
test("verifyLineItemsAndResolve: 合計不一致を拒否", () => {
  const s = mkSession({ amount_total: 9999 });
  assert.equal(typeof verifyLineItemsAndResolve(s, priceMap), "string");
});
test("verifyLineItemsAndResolve: 重複商品を拒否", () => {
  const s = mkSession({
    amount_total: 26000,
    line_items: {
      data: [
        { quantity: 1, price: { id: "price_sam", currency: "jpy", unit_amount: 13000 } },
        { quantity: 1, price: { id: "price_sam", currency: "jpy", unit_amount: 13000 } },
      ],
    },
  });
  assert.equal(typeof verifyLineItemsAndResolve(s, priceMap), "string");
});
test("verifyLineItemsAndResolve: currency 非 jpy を拒否", () => {
  assert.equal(typeof verifyLineItemsAndResolve(mkSession({ currency: "usd" }), priceMap), "string");
});
test("verifyLineItemsAndResolve: line_items 空を拒否", () => {
  assert.equal(typeof verifyLineItemsAndResolve(mkSession({ line_items: { data: [] } }), priceMap), "string");
});

/* ---- epochToJstIso ---- */
test("epochToJstIso: JST(+09:00) の ISO 文字列を返す", () => {
  // 2026-01-01T00:00:00Z → JST 09:00:00
  const s = epochToJstIso(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000);
  assert.match(s, /\+09:00$/);
  assert.ok(s.startsWith("2026-01-01T09:00:00"));
});
