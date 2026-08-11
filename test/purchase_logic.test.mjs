// 再実行可能テスト（node --test）。
// 純ロジック（Checkout の productCodes 検証 / status の productCodes 正規化 / 成功条件判定）を検証する。
//
// 実行方法（このリポジトリの scripts.test）:
//   npm test
// これは内部で esbuild により src の純関数をバンドルしてから node --test を走らせる。
// （src は Cloudflare Workers 依存を含むため、テスト対象の純関数のみを取り出してバンドルする）

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProductCodes, parseStatusProductCodes, computeAllGranted } from "./_bundle/purchase_logic.mjs";

// ---- A. Checkout API: productCodes 検証（parseProductCodes）----
test("Checkout: 単数 productCode → [code] へ正規化", () => {
  assert.deepEqual(parseProductCodes({ productCode: "SUN_AND_MOON" }), ["SUN_AND_MOON"]);
});
test("Checkout: productCodes 配列をそのまま受理", () => {
  assert.deepEqual(parseProductCodes({ productCodes: ["HANABI", "HANABI_GOOGLE_EARTH"] }), ["HANABI", "HANABI_GOOGLE_EARTH"]);
});
test("Checkout: 重複は拒否（黙って除去しない）", () => {
  assert.throws(() => parseProductCodes({ productCodes: ["HANABI", "HANABI"] }), /validation|ValidationError/i);
});
test("Checkout: 空配列は拒否", () => {
  assert.throws(() => parseProductCodes({ productCodes: [] }));
});
test("Checkout: 非配列は拒否", () => {
  assert.throws(() => parseProductCodes({ productCodes: "HANABI" }));
});
test("Checkout: 未指定は拒否", () => {
  assert.throws(() => parseProductCodes({}));
});

// ---- A/status. URL parsing（parseStatusProductCodes）----
test("status: ?productCode=SUN_AND_MOON → 単数モード", () => {
  const r = parseStatusProductCodes(null, "SUN_AND_MOON");
  assert.deepEqual(r.codes, ["SUN_AND_MOON"]);
  assert.equal(r.singleMode, true);
});
test("status: ?productCodes=HANABI,HANABI_GOOGLE_EARTH → 2商品", () => {
  const r = parseStatusProductCodes("HANABI,HANABI_GOOGLE_EARTH", null);
  assert.deepEqual(r.codes, ["HANABI", "HANABI_GOOGLE_EARTH"]);
  assert.equal(r.singleMode, false);
});
test("status: 重複は安全に一意化（順序維持）", () => {
  const r = parseStatusProductCodes("HANABI,HANABI,SUN_AND_MOON", null);
  assert.deepEqual(r.codes, ["HANABI", "SUN_AND_MOON"]);
});
test("status: 空・trim 処理", () => {
  const r = parseStatusProductCodes(" HANABI , ,SUN_AND_MOON ", null);
  assert.deepEqual(r.codes, ["HANABI", "SUN_AND_MOON"]);
});
test("status: productCodes 優先（両方あれば productCodes）", () => {
  const r = parseStatusProductCodes("HANABI", "SUN_AND_MOON");
  assert.deepEqual(r.codes, ["HANABI"]);
  assert.equal(r.singleMode, false);
});
test("status: 何も無ければ null（→ 400）", () => {
  assert.equal(parseStatusProductCodes(null, null), null);
});
test("status: 空文字のみ → null（→ 400）", () => {
  assert.equal(parseStatusProductCodes(",, ,", null), null);
});
test("status: 64 文字超を含む → null（→ 400）", () => {
  assert.equal(parseStatusProductCodes("A".repeat(65), null), null);
});

// ---- C. 成功条件判定（全商品 granted のときのみ成功）----
test("成功条件: 全商品 granted → allGranted true", () => {
  assert.equal(computeAllGranted([{ granted: true }, { granted: true }]), true);
});
test("成功条件: 一部未反映 → allGranted false", () => {
  assert.equal(computeAllGranted([{ granted: true }, { granted: false }]), false);
});
test("成功条件: 空配列 → false（成功にしない）", () => {
  assert.equal(computeAllGranted([]), false);
});

// ---- C. 偽 email を body に含めても productCodes 抽出に影響しない（email は読まれない）----
test("Checkout: body に email を含めても productCodes のみ抽出（email 無視）", () => {
  // parseProductCodes は productCodes/productCode のみ参照するため email は読まれない。
  assert.deepEqual(
    parseProductCodes({ productCodes: ["HANABI"], email: "attacker@evil.com" }),
    ["HANABI"],
  );
});
test("Checkout: 単数 productCode + 偽 email でも productCode のみ抽出", () => {
  assert.deepEqual(
    parseProductCodes({ productCode: "SUN_AND_MOON", email: "x@y.z" }),
    ["SUN_AND_MOON"],
  );
});
