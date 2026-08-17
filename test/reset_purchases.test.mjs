// Local/Test 専用 購入状態リセットのテスト
// 環境ガード・active attempt 分類は純関数で、DB 削除は D1 アダプタで検証。
// Stripe retrieve/expire の実挙動と requireAdmin の HTTP 経路は E2E で確認。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  isResetAllowedEnv,
  classifyActiveAttemptForReset,
  deletePurchaseStateForUser,
} from "./_bundle/purchase_logic.mjs";

/* ============================================================
 * 1/2. 環境ガード（deny-by-default: local/test/development のみ許可）
 * ============================================================ */
test("isResetAllowedEnv: local → 許可", () => {
  assert.equal(isResetAllowedEnv({ APP_ENV: "local" }), true);
});
test("isResetAllowedEnv: test → 許可", () => {
  assert.equal(isResetAllowedEnv({ APP_ENV: "test" }), true);
});
test("isResetAllowedEnv: development（正式DEV）→ 許可", () => {
  assert.equal(isResetAllowedEnv({ APP_ENV: "development" }), true);
});
test("isResetAllowedEnv: production → 拒否", () => {
  assert.equal(isResetAllowedEnv({ APP_ENV: "production" }), false);
});
test("isResetAllowedEnv: undefined（未設定）→ 拒否", () => {
  assert.equal(isResetAllowedEnv({}), false);
  assert.equal(isResetAllowedEnv({ APP_ENV: undefined }), false);
});
test("isResetAllowedEnv: 空文字 → 拒否", () => {
  assert.equal(isResetAllowedEnv({ APP_ENV: "" }), false);
});
test("isResetAllowedEnv: 未知値・typo → 拒否", () => {
  assert.equal(isResetAllowedEnv({ APP_ENV: "unknown" }), false);
  assert.equal(isResetAllowedEnv({ APP_ENV: "prod" }), false);
  assert.equal(isResetAllowedEnv({ APP_ENV: "Local" }), false);
});

/* ============================================================
 * active attempt 分類（方針表の固定）
 * ============================================================ */
test("classifyActiveAttemptForReset: CREATE_ATTEMPTED=0 + SID=NULL → deletable（未試行）", () => {
  assert.equal(classifyActiveAttemptForReset({ STRIPE_SESSION_ID: null, CREATE_ATTEMPTED: 0 }, "no_session"), "deletable");
});
test("classifyActiveAttemptForReset: CREATE_ATTEMPTED=1 + SID=NULL → indeterminate（中止）", () => {
  assert.equal(classifyActiveAttemptForReset({ STRIPE_SESSION_ID: null, CREATE_ATTEMPTED: 1 }, "no_session"), "indeterminate");
});
test("classifyActiveAttemptForReset: SID + open → expire_needed", () => {
  assert.equal(classifyActiveAttemptForReset({ STRIPE_SESSION_ID: "cs_1", CREATE_ATTEMPTED: 1 }, "open"), "expire_needed");
});
test("classifyActiveAttemptForReset: SID + expired → deletable", () => {
  assert.equal(classifyActiveAttemptForReset({ STRIPE_SESSION_ID: "cs_1", CREATE_ATTEMPTED: 1 }, "expired"), "deletable");
});
test("classifyActiveAttemptForReset: SID + complete/paid → deletable（expire しない）", () => {
  assert.equal(classifyActiveAttemptForReset({ STRIPE_SESSION_ID: "cs_1", CREATE_ATTEMPTED: 1 }, "complete"), "deletable");
});
test("classifyActiveAttemptForReset: SID + Stripe 状態不明 → indeterminate（blind delete しない）", () => {
  assert.equal(classifyActiveAttemptForReset({ STRIPE_SESSION_ID: "cs_1", CREATE_ATTEMPTED: 1 }, "indeterminate"), "indeterminate");
});

/* ============================================================
 * DB 削除（D1 アダプタ）
 * ============================================================ */
class D1Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new D1Stmt(this.db, this.sql, args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { return { success: true, meta: this.db.prepare(this.sql).run(...this.args) }; }
}
class D1Adapter {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const st of stmts) out.push(this.db.prepare(st.sql).run(...st.args));
      this.db.exec("COMMIT");
      return out;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}
const MIGRATIONS = [
  "0001_initial_schema.sql", "0002_fix_jst_datetime.sql", "0003_add_access_log_interval_setting.sql",
  "0004_add_warning_threshold_settings.sql", "0005_add_t_order_and_purchase_order_id.sql",
  "0006_add_checkout_attempt_lifecycle.sql",
];
const NOW = "2026-08-09T00:00:00+09:00";

function makeDb(foreignKeys = true) {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync("migrations/" + f, "utf8"));
  if (foreignKeys) db.exec("PRAGMA foreign_keys=ON");
  return db;
}
function pidOf(db) {
  const prod = db.prepare("SELECT PRODUCT_ID, PRODUCT_CODE FROM M_PRODUCT ORDER BY SORT_NO").all();
  return Object.fromEntries(prod.map((r) => [r.PRODUCT_CODE, r.PRODUCT_ID]));
}
function seedUser(db, u) {
  db.prepare("INSERT INTO M_USER (AUTH_USER_ID,LOGIN_MAIL,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,1,0,?,?)").run(u, u + "@x.c", NOW, NOW);
}
// 1 商品分の購入状態（order/purchase/user_product/attempt/item/lock/payment_event）を作る
function seedPurchase(db, u, productId, code) {
  db.prepare("INSERT INTO T_ORDER (AUTH_USER_ID,PURCHASE_SOURCE,EXTERNAL_ORDER_ID,PAYMENT_INTENT_ID,ORDER_DATE,TOTAL_AMOUNT,PAYMENT_STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,0,?,?,?,4000,1,0,?,?)")
    .run(u, "cs_" + u + "_" + code, "pi_" + u, NOW, NOW, NOW);
  const oid = db.prepare("SELECT ORDER_ID FROM T_ORDER WHERE EXTERNAL_ORDER_ID=?").get("cs_" + u + "_" + code).ORDER_ID;
  db.prepare("INSERT INTO T_PURCHASE (AUTH_USER_ID,PRODUCT_ID,ORDER_ID,PURCHASE_DATE,AMOUNT,PAYMENT_STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE,PURCHASE_SOURCE) VALUES (?,?,?,?,4000,1,0,?,?,0)")
    .run(u, productId, oid, NOW, NOW, NOW);
  const puid = db.prepare("SELECT PURCHASE_ID FROM T_PURCHASE WHERE ORDER_ID=?").get(oid).PURCHASE_ID;
  db.prepare("INSERT INTO T_USER_PRODUCT (AUTH_USER_ID,PRODUCT_ID,PURCHASE_ID,START_DATE,END_DATE,STATUS,GRANT_TYPE,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,?,?,?,1,0,0,?,?)")
    .run(u, productId, puid, NOW, "9999-12-31T23:59:59+09:00", NOW, NOW);
  db.prepare("INSERT INTO T_CHECKOUT_ATTEMPT (OPERATION_ID,AUTH_USER_ID,CART_KEY,BUYER_EMAIL,STATUS,CREATE_ATTEMPTED,STRIPE_SESSION_ID,TOTAL_AMOUNT,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,?,?,2,1,?,4000,0,?,?)")
    .run("op_" + u + "_" + code, u, "ck", u + "@x.c", "cs_" + u + "_" + code, NOW, NOW);
  const aid = db.prepare("SELECT ATTEMPT_ID FROM T_CHECKOUT_ATTEMPT WHERE OPERATION_ID=?").get("op_" + u + "_" + code).ATTEMPT_ID;
  db.prepare("INSERT INTO T_CHECKOUT_ATTEMPT_ITEM (ATTEMPT_ID,PRODUCT_ID,PRODUCT_CODE,STRIPE_PRICE_ID,EXPECTED_AMOUNT,SORT_NO,CREATE_DATE) VALUES (?,?,?,?,4000,0,?)")
    .run(aid, productId, code, "p", NOW);
  db.prepare("INSERT INTO T_PRODUCT_CHECKOUT_LOCK (AUTH_USER_ID,PRODUCT_ID,ATTEMPT_ID,CREATE_DATE) VALUES (?,?,?,?)").run(u, productId, aid, NOW);
  db.prepare("INSERT INTO T_PAYMENT_EVENT (EVENT_TYPE,AUTH_USER_ID,ORDER_ID,STRIPE_SESSION_ID,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (2,?,?,?,0,?,?)").run(u, oid, "cs_" + u + "_" + code, NOW, NOW);
}
function count(db, table, where, ...binds) {
  return db.prepare(`SELECT COUNT(*) c FROM ${table} ${where}`).get(...binds).c;
}

test("deletePurchaseStateForUser: 対象ユーザーの全購入状態を削除し件数を返す（FK ON）", async () => {
  const db = makeDb(true);
  const pid = pidOf(db);
  seedUser(db, "target");
  seedPurchase(db, "target", pid.SUN_AND_MOON, "SUN_AND_MOON");
  seedPurchase(db, "target", pid.HANABI, "HANABI");
  seedPurchase(db, "target", pid.HANABI_GOOGLE_EARTH, "HANABI_GOOGLE_EARTH");
  const env = { DB: new D1Adapter(db) };

  const deleted = await deletePurchaseStateForUser(env, "target");
  // 件数（3 商品分）
  assert.equal(deleted.userProducts, 3);
  assert.equal(deleted.purchases, 3);
  assert.equal(deleted.orders, 3);
  assert.equal(deleted.checkoutAttempts, 3);
  assert.equal(deleted.checkoutAttemptItems, 3);
  assert.equal(deleted.checkoutLocks, 3);
  assert.equal(deleted.paymentEvents, 3);
  // 実際に 0 になっている（各テーブル）
  assert.equal(count(db, "T_USER_PRODUCT", "WHERE AUTH_USER_ID='target'"), 0);
  assert.equal(count(db, "T_PURCHASE", "WHERE AUTH_USER_ID='target'"), 0);
  assert.equal(count(db, "T_ORDER", "WHERE AUTH_USER_ID='target'"), 0);
  assert.equal(count(db, "T_CHECKOUT_ATTEMPT", "WHERE AUTH_USER_ID='target'"), 0);
  assert.equal(count(db, "T_PRODUCT_CHECKOUT_LOCK", "WHERE AUTH_USER_ID='target'"), 0);
  assert.equal(count(db, "T_PAYMENT_EVENT", "WHERE AUTH_USER_ID='target'"), 0);
  // item は attempt 経由で 0
  assert.equal(count(db, "T_CHECKOUT_ATTEMPT_ITEM", ""), 0);
  // M_USER は残る（Auth ユーザーを消さない）
  assert.equal(count(db, "M_USER", "WHERE AUTH_USER_ID='target'"), 1);
});

test("deletePurchaseStateForUser: 他ユーザーのデータは消えない", async () => {
  const db = makeDb(true);
  const pid = pidOf(db);
  seedUser(db, "target");
  seedUser(db, "other");
  seedPurchase(db, "target", pid.HANABI, "HANABI");
  seedPurchase(db, "other", pid.HANABI, "HANABI");
  const env = { DB: new D1Adapter(db) };

  await deletePurchaseStateForUser(env, "target");
  // other は 1 件ずつ残る
  assert.equal(count(db, "T_USER_PRODUCT", "WHERE AUTH_USER_ID='other'"), 1);
  assert.equal(count(db, "T_PURCHASE", "WHERE AUTH_USER_ID='other'"), 1);
  assert.equal(count(db, "T_ORDER", "WHERE AUTH_USER_ID='other'"), 1);
  assert.equal(count(db, "T_CHECKOUT_ATTEMPT", "WHERE AUTH_USER_ID='other'"), 1);
  assert.equal(count(db, "T_PRODUCT_CHECKOUT_LOCK", "WHERE AUTH_USER_ID='other'"), 1);
  assert.equal(count(db, "T_PAYMENT_EVENT", "WHERE AUTH_USER_ID='other'"), 1);
  // other の item も残る
  assert.equal(count(db, "T_CHECKOUT_ATTEMPT_ITEM", ""), 1);
});

test("deletePurchaseStateForUser: 途中失敗時は全 rollback（部分削除を作らない）", async () => {
  const db = makeDb(true);
  const pid = pidOf(db);
  seedUser(db, "target");
  seedPurchase(db, "target", pid.HANABI, "HANABI");
  // batch の最後の DELETE を強制的に失敗させるアダプタ（原子性の検証）
  class FailingAdapter extends D1Adapter {
    async batch(stmts) {
      this.db.exec("BEGIN");
      try {
        for (let i = 0; i < stmts.length; i++) {
          if (i === stmts.length - 1) throw new Error("simulated failure on last statement");
          this.db.prepare(stmts[i].sql).run(...stmts[i].args);
        }
        this.db.exec("COMMIT");
      } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    }
  }
  const env = { DB: new FailingAdapter(db) };
  await assert.rejects(() => deletePurchaseStateForUser(env, "target"));
  // rollback により全テーブルが元の 1 件のまま（部分削除なし）
  assert.equal(count(db, "T_USER_PRODUCT", "WHERE AUTH_USER_ID='target'"), 1);
  assert.equal(count(db, "T_PURCHASE", "WHERE AUTH_USER_ID='target'"), 1);
  assert.equal(count(db, "T_ORDER", "WHERE AUTH_USER_ID='target'"), 1);
  assert.equal(count(db, "T_CHECKOUT_ATTEMPT", "WHERE AUTH_USER_ID='target'"), 1);
  assert.equal(count(db, "T_PAYMENT_EVENT", "WHERE AUTH_USER_ID='target'"), 1);
});

test("deletePurchaseStateForUser: reset 後 T_USER_PRODUCT が空 = account/products は granted=false 相当", async () => {
  const db = makeDb(true);
  const pid = pidOf(db);
  seedUser(db, "target");
  for (const [code, id] of [["SUN_AND_MOON", pid.SUN_AND_MOON], ["HANABI", pid.HANABI], ["HANABI_GOOGLE_EARTH", pid.HANABI_GOOGLE_EARTH]]) {
    seedPurchase(db, "target", id, code);
  }
  const env = { DB: new D1Adapter(db) };
  await deletePurchaseStateForUser(env, "target");
  // granted 判定は T_USER_PRODUCT 行の有無。全商品で行が無い＝granted=false。
  for (const id of [pid.SUN_AND_MOON, pid.HANABI, pid.HANABI_GOOGLE_EARTH]) {
    assert.equal(count(db, "T_USER_PRODUCT", "WHERE AUTH_USER_ID='target' AND PRODUCT_ID=" + id), 0);
  }
});

test("deletePurchaseStateForUser: paid Stripe 履歴前提（PAYMENT_INTENT_ID あり）でも DB reset 可能", async () => {
  const db = makeDb(true);
  const pid = pidOf(db);
  seedUser(db, "target");
  seedPurchase(db, "target", pid.HANABI, "HANABI"); // PAYMENT_INTENT_ID=pi_target 付き
  const env = { DB: new D1Adapter(db) };
  const deleted = await deletePurchaseStateForUser(env, "target");
  assert.equal(deleted.orders, 1);
  assert.equal(count(db, "T_ORDER", "WHERE AUTH_USER_ID='target'"), 0);
  // Stripe 側は本テストの対象外（削除しない）。DB のみ初期化される。
});

test("deletePurchaseStateForUser: reset 後に同じ Session を再付与できる余地（EXTERNAL_ORDER_ID 制約が残らない）", async () => {
  const db = makeDb(true);
  const pid = pidOf(db);
  seedUser(db, "target");
  seedPurchase(db, "target", pid.HANABI, "HANABI");
  const sid = "cs_target_HANABI";
  const env = { DB: new D1Adapter(db) };
  await deletePurchaseStateForUser(env, "target");
  // 同一 Session ID の注文が消えている → reconcile で再度この Session ID の注文を作れる
  assert.equal(count(db, "T_ORDER", "WHERE EXTERNAL_ORDER_ID='" + sid + "'"), 0);
  // 再付与を模擬（同じ Session ID で再 INSERT できる = UNIQUE 制約に引っかからない）
  db.prepare("INSERT INTO T_ORDER (AUTH_USER_ID,PURCHASE_SOURCE,EXTERNAL_ORDER_ID,ORDER_DATE,TOTAL_AMOUNT,PAYMENT_STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES ('target',0,?,?,4000,1,0,?,?)")
    .run(sid, NOW, NOW, NOW);
  assert.equal(count(db, "T_ORDER", "WHERE EXTERNAL_ORDER_ID='" + sid + "'"), 1);
});
