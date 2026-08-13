/**
 * STORE 購入フロー: モーダル前の依存事前チェック（precheck-dependency）
 *
 * 実機再現に対応する検証:
 * - Earth 単体選択 → 依存 NG（DEPENDENCY_REQUIRED）。購入内容確認モーダルへ進めない根拠。
 * - HANABI + Earth（同時カート）→ 依存 OK。モーダルへ進める。
 * - HANABI を有効 entitlement で所有 → Earth 単体でも依存 OK。
 * - 依存のない商品（HANABI 単体）→ 依存 OK。
 *
 * 本テストは precheck-dependency が正本として使う checkProductDependencies の判定結果を検証する
 * （API ハンドラは requireUser=JWT 検証を伴うため、判定ロジックを直接対象にする）。
 * ここで確認するのは「事前チェックが依存 NG を早期に返せること」であり、
 * 依存判定そのものの網羅は product_dependency.test.mjs が担う。
 *
 * 重要: 事前チェックは Checkout Session を作らない・active checkout を変更しない。
 * checkProductDependencies は D1 の読み取り（M_PRODUCT_DEPENDENCY / T_USER_PRODUCT）のみで、
 * T_CHECKOUT_ATTEMPT へ一切書き込まないことを、実行後の件数で確認する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  checkProductDependencies,
  DependencyConfigError,
} from "./_bundle/purchase_logic.mjs";

/* ---- node:sqlite を D1Database インターフェースへラップ ---- */
class D1Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new D1Stmt(this.db, this.sql, args); }
  async first() { const s = this.db.prepare(this.sql); return s.get(...this.args) ?? null; }
  async all() { const s = this.db.prepare(this.sql); return { results: s.all(...this.args) }; }
  async run() { const s = this.db.prepare(this.sql); return { success: true, meta: s.run(...this.args) }; }
}
class D1Adapter {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Stmt(this.db, sql); }
}

const MIGRATIONS = [
  "0001_initial_schema.sql", "0002_fix_jst_datetime.sql", "0003_add_access_log_interval_setting.sql",
  "0004_add_warning_threshold_settings.sql", "0005_add_t_order_and_purchase_order_id.sql",
  "0006_add_checkout_attempt_lifecycle.sql", "0007_add_product_sale_columns.sql",
  "0008_add_product_dependency.sql",
];
const NOW = "2026-08-09T00:00:00+09:00";
const FOREVER = "9999-12-31T23:59:59+09:00";

function freshEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync("migrations/" + f, "utf8"));
  // テストユーザーを用意（FK: T_USER_PRODUCT.AUTH_USER_ID → M_USER）
  db.prepare(
    `INSERT INTO M_USER (AUTH_USER_ID, LOGIN_MAIL, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
     VALUES (?, ?, 1, 0, ?, ?)`,
  ).run("user-1", "user-1@example.com", NOW, NOW);
  return { env: { DB: new D1Adapter(db) }, raw: db };
}

function productId(raw, code) {
  return raw.prepare("SELECT PRODUCT_ID FROM M_PRODUCT WHERE PRODUCT_CODE=?").get(code).PRODUCT_ID;
}
function grantEntitlement(raw, authUserId, code, grantType = 0) {
  const pid = productId(raw, code);
  raw.prepare(
    `INSERT INTO T_USER_PRODUCT
       (AUTH_USER_ID, PRODUCT_ID, STATUS, START_DATE, END_DATE, GRANT_TYPE, DEL_FLG, CREATE_DATE, UPDATE_DATE)
     VALUES (?, ?, 1, ?, ?, ?, 0, ?, ?)`,
  ).run(authUserId, pid, NOW, FOREVER, grantType, NOW, NOW);
}
function attemptCount(raw) {
  return raw.prepare("SELECT COUNT(*) AS c FROM T_CHECKOUT_ATTEMPT").get().c;
}

test("[precheck-dep] Earth 単体選択 → DEPENDENCY_REQUIRED（モーダルへ進めない）", async () => {
  const { env, raw } = freshEnv();
  await assert.rejects(
    () => checkProductDependencies(env, "user-1", ["HANABI_GOOGLE_EARTH"]),
    (e) => e && e.code === "DEPENDENCY_REQUIRED" && e.status === 409,
  );
  // 事前チェックは Checkout Session を作らない
  assert.equal(attemptCount(raw), 0);
});

test("[precheck-dep] HANABI + Earth 同時カート → 依存 OK（モーダルへ進める）", async () => {
  const { env, raw } = freshEnv();
  await assert.doesNotReject(
    () => checkProductDependencies(env, "user-1", ["HANABI", "HANABI_GOOGLE_EARTH"]),
  );
  assert.equal(attemptCount(raw), 0);
});

test("[precheck-dep] HANABI を有効 entitlement で所有 → Earth 単体でも依存 OK", async () => {
  const { env, raw } = freshEnv();
  grantEntitlement(raw, "user-1", "HANABI", 0);
  await assert.doesNotReject(
    () => checkProductDependencies(env, "user-1", ["HANABI_GOOGLE_EARTH"]),
  );
  assert.equal(attemptCount(raw), 0);
});

test("[precheck-dep] 依存のない商品（HANABI 単体）→ 依存 OK", async () => {
  const { env, raw } = freshEnv();
  await assert.doesNotReject(() => checkProductDependencies(env, "user-1", ["HANABI"]));
  assert.equal(attemptCount(raw), 0);
});

test("[precheck-dep] 事前チェックは T_CHECKOUT_ATTEMPT を作らない（NG・OK 両方）", async () => {
  const { env, raw } = freshEnv();
  // NG ケース
  await assert.rejects(() => checkProductDependencies(env, "user-1", ["HANABI_GOOGLE_EARTH"]));
  // OK ケース
  grantEntitlement(raw, "user-1", "HANABI", 0);
  await assert.doesNotReject(() => checkProductDependencies(env, "user-1", ["HANABI_GOOGLE_EARTH"]));
  // いずれも Checkout Session（attempt）を作らない
  assert.equal(attemptCount(raw), 0);
});

test("[precheck-dep] DEPENDENCY_REQUIRED は details（購入対象＋不足前提グループ）を持つ", async () => {
  const { env } = freshEnv();
  let caught = null;
  try {
    await checkProductDependencies(env, "user-1", ["HANABI_GOOGLE_EARTH"]);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "DEPENDENCY_REQUIRED が投げられること");
  assert.equal(caught.code, "DEPENDENCY_REQUIRED");
  assert.equal(caught.status, 409);
  // details 構造: 購入対象コード＋未充足グループ（ALL_OF）・各グループは候補（ANY_OF）
  assert.ok(caught.details, "details を持つこと");
  assert.equal(caught.details.productCode, "HANABI_GOOGLE_EARTH");
  assert.ok(Array.isArray(caught.details.missingGroups));
  assert.equal(caught.details.missingGroups.length, 1);
  assert.deepEqual(caught.details.missingGroups[0].requiresAnyOf, ["HANABI"]);
  // satisfyMode も返す（EARTH→HANABI は ENTITLEMENT_OR_CART）
  assert.equal(caught.details.missingGroups[0].satisfyMode, "ENTITLEMENT_OR_CART");
  // 固有商品名のハードコードではなくコードで返す（フロントが PRODUCT_NAME へ変換する）
  assert.equal(caught.details.missingGroups[0].requiresAnyOf.includes("HANABI"), true);
});

test("[precheck-dep] details は ANY_OF（同一グループ複数候補）を候補配列で返す", async () => {
  const { env, raw } = freshEnv();
  // 3D_PREVIEW は HANABI または SUN_AND_MOON（同一グループ ANY_OF・ENTITLEMENT_ONLY）を要する初期データ想定。
  // どちらも未所有なら DEPENDENCY_REQUIRED で候補2つを返す。
  const has3d = raw.prepare("SELECT COUNT(*) AS c FROM M_PRODUCT WHERE PRODUCT_CODE='3D_PREVIEW'").get().c;
  if (has3d === 0) return; // 初期データに無ければスキップ（環境差異に強くする）
  let caught = null;
  try {
    await checkProductDependencies(env, "user-1", ["3D_PREVIEW"]);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught && caught.code === "DEPENDENCY_REQUIRED");
  assert.equal(caught.details.missingGroups.length, 1);
  const cands = caught.details.missingGroups[0].requiresAnyOf;
  assert.equal(cands.includes("HANABI"), true);
  assert.equal(cands.includes("SUN_AND_MOON"), true);
});
