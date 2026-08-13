/**
 * セッション観測ログの記録テスト（SESSION_ID_HASH / ACCESS_TYPE / 抑制）
 *
 * 検証:
 * 5. app-start ログ（ACCESS_TYPE=0）に SESSION_ID_HASH が入る
 * 6. entitlement-check ログ（ACCESS_TYPE=1）に SESSION_ID_HASH が入る
 * 7. heartbeat ログは ACCESS_TYPE=2（PERIODIC_CHECK）
 * 8. heartbeat でも IP / 地域 / DEVICE_ID / UA を既存方式で記録
 * - 生 session_id は DB に保存されない（SESSION_ID_HASH は v1: ハッシュのみ）
 * - SESSION_ID_HASH_SECRET 未設定なら SESSION_ID_HASH は NULL（記録は継続）
 * 11. 既存 60 分抑制が意図どおり機能（同一条件は間隔内で 1 件）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  recordAppStartAccess,
  recordEntitlementAccess,
  recordPeriodicAccess,
  ACCESS_TYPE,
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
const SID = "33333333-3333-4333-8333-333333333333";
const SECRET = "obs-test-secret";

function freshEnv({ secret } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync("migrations/" + f, "utf8"));
  // SUN_AND_MOON は 0001 初期データにある想定。念のため取得。
  const prod = db.prepare("SELECT PRODUCT_ID FROM M_PRODUCT WHERE PRODUCT_CODE='SUN_AND_MOON'").get();
  // T_ACCESS_LOG は AUTH_USER_ID→M_USER の FK があるため、テスト用ユーザーを用意する。
  for (const uid of ["user-1", "user-A", "user-B"]) {
    db.prepare(
      `INSERT INTO M_USER (AUTH_USER_ID, LOGIN_MAIL, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
       VALUES (?, ?, 1, 0, ?, ?)`,
    ).run(uid, uid + "@example.com", NOW, NOW);
  }
  const env = { DB: new D1Adapter(db) };
  if (secret !== undefined) env.SESSION_ID_HASH_SECRET = secret;
  return { env, raw: db, productId: prod.PRODUCT_ID };
}

// Cloudflare 相当の接続情報を持つ Request を模す。
function reqWith({ deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } = {}) {
  const headers = new Map([
    ["cf-connecting-ip", "203.0.113.5"],
    ["user-agent", "Mozilla/5.0 (Test)"],
    ["x-device-id", deviceId],
  ]);
  return {
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    cf: { country: "JP", region: "Osaka", city: "Osaka" },
  };
}

function accessRows(raw) {
  return raw.prepare(
    "SELECT ACCESS_TYPE, IP_ADDRESS, COUNTRY_CODE, REGION, CITY, DEVICE_ID, USER_AGENT, SESSION_ID_HASH FROM T_ACCESS_LOG ORDER BY ACCESS_LOG_ID"
  ).all();
}

test("[obs] 要件5: app-start ログ(ACCESS_TYPE=0)に SESSION_ID_HASH が入る", async () => {
  const { env, raw, productId } = freshEnv({ secret: SECRET });
  await recordAppStartAccess(reqWith(), env, "user-1", productId, SID);
  const rows = accessRows(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ACCESS_TYPE, ACCESS_TYPE.APP_START);
  assert.match(rows[0].SESSION_ID_HASH, /^v1:[0-9a-f]{64}$/);
});

test("[obs] 要件6: entitlement-check ログ(ACCESS_TYPE=1)に SESSION_ID_HASH が入る", async () => {
  const { env, raw, productId } = freshEnv({ secret: SECRET });
  await recordEntitlementAccess(reqWith(), env, "user-1", productId, SID);
  const rows = accessRows(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ACCESS_TYPE, ACCESS_TYPE.ENTITLEMENT_CHECK);
  assert.match(rows[0].SESSION_ID_HASH, /^v1:[0-9a-f]{64}$/);
});

test("[obs] 要件7: heartbeat ログは ACCESS_TYPE=2 (PERIODIC_CHECK)", async () => {
  const { env, raw, productId } = freshEnv({ secret: SECRET });
  await recordPeriodicAccess(reqWith(), env, "user-1", productId, SID);
  const rows = accessRows(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ACCESS_TYPE, ACCESS_TYPE.PERIODIC_CHECK);
  assert.equal(rows[0].ACCESS_TYPE, 2);
});

test("[obs] 要件8: heartbeat でも IP/地域/DEVICE_ID/UA を既存方式で記録", async () => {
  const { env, raw, productId } = freshEnv({ secret: SECRET });
  await recordPeriodicAccess(reqWith({ deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), env, "user-1", productId, SID);
  const r = accessRows(raw)[0];
  assert.equal(r.IP_ADDRESS, "203.0.113.5");
  assert.equal(r.COUNTRY_CODE, "JP");
  assert.equal(r.REGION, "Osaka");
  assert.equal(r.CITY, "Osaka");
  assert.equal(r.DEVICE_ID, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(r.USER_AGENT, "Mozilla/5.0 (Test)");
});

test("[obs] 生 session_id は DB に保存されない（v1: ハッシュのみ）", async () => {
  const { env, raw, productId } = freshEnv({ secret: SECRET });
  await recordPeriodicAccess(reqWith(), env, "user-1", productId, SID);
  const r = accessRows(raw)[0];
  assert.equal(r.SESSION_ID_HASH.includes(SID), false, "生 session_id が保存されてはならない");
  assert.match(r.SESSION_ID_HASH, /^v1:/);
});

test("[obs] SESSION_ID_HASH_SECRET 未設定なら SESSION_ID_HASH は NULL（記録は継続）", async () => {
  const { env, raw, productId } = freshEnv({ secret: undefined });
  await recordPeriodicAccess(reqWith(), env, "user-1", productId, SID);
  const r = accessRows(raw)[0];
  assert.equal(r.SESSION_ID_HASH, null);
  // 記録自体は継続（IP 等は入る）
  assert.equal(r.IP_ADDRESS, "203.0.113.5");
});

test("[obs] session_id が null でも SESSION_ID_HASH は NULL で記録継続", async () => {
  const { env, raw, productId } = freshEnv({ secret: SECRET });
  await recordPeriodicAccess(reqWith(), env, "user-1", productId, null);
  const r = accessRows(raw)[0];
  assert.equal(r.SESSION_ID_HASH, null);
  assert.equal(r.ACCESS_TYPE, 2);
});

test("[obs] 要件11: 既存60分抑制が機能（同一条件は間隔内で1件・別ACCESS_TYPEは独立）", async () => {
  const { env, raw, productId } = freshEnv({ secret: SECRET });
  // 同一 user/product/deviceId で heartbeat を2回 → 抑制で1件のみ
  await recordPeriodicAccess(reqWith(), env, "user-1", productId, SID);
  await recordPeriodicAccess(reqWith(), env, "user-1", productId, SID);
  const periodic = raw.prepare("SELECT COUNT(*) AS c FROM T_ACCESS_LOG WHERE ACCESS_TYPE=2").get().c;
  assert.equal(periodic, 1, "60分抑制で PERIODIC は1件");
  // app-start は別 ACCESS_TYPE なので独立して記録される
  await recordAppStartAccess(reqWith(), env, "user-1", productId, SID);
  const appstart = raw.prepare("SELECT COUNT(*) AS c FROM T_ACCESS_LOG WHERE ACCESS_TYPE=0").get().c;
  assert.equal(appstart, 1, "app-start は独立して記録");
});

test("[obs] 同一 session_id → 同一 SESSION_ID_HASH（別 user で確認・決定性）", async () => {
  const { env, raw, productId } = freshEnv({ secret: SECRET });
  await recordAppStartAccess(reqWith(), env, "user-A", productId, SID);
  await recordAppStartAccess(reqWith(), env, "user-B", productId, SID);
  const rows = raw.prepare("SELECT SESSION_ID_HASH FROM T_ACCESS_LOG ORDER BY ACCESS_LOG_ID").all();
  assert.equal(rows[0].SESSION_ID_HASH, rows[1].SESSION_ID_HASH, "同一 session_id は同一 hash");
});
