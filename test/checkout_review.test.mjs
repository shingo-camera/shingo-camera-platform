// レビュー指摘の追加テスト（DB/純ロジックで検証可能な範囲を自動化）
// Stripe 実機依存（expire 失敗時の再 retrieve、フロント表示）は README「E2E 手順」で確認。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  createAttemptWithLocks,
  getAttemptByOperationId,
  markCreateAttempted,
  isCreateResultIndeterminate,
  reconcileAttemptForSession,
  rebuildCreateParams,
  resolveBaseUrl,
  buildCartKey,
  ATTEMPT_STATUS,
} from "./_bundle/purchase_logic.mjs";

/* ---- D1 アダプタ（node:sqlite ラップ）---- */
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
function freshEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync("migrations/" + f, "utf8"));
  const now = "2026-08-09T00:00:00+09:00";
  if (!db.prepare("SELECT AUTH_USER_ID FROM M_USER LIMIT 1").get()) {
    db.prepare("INSERT INTO M_USER (AUTH_USER_ID,LOGIN_MAIL,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,?,?,?,?)")
      .run("u1", "a@b.c", 1, 0, now, now);
  }
  const authUserId = db.prepare("SELECT AUTH_USER_ID FROM M_USER LIMIT 1").get().AUTH_USER_ID;
  const prod = db.prepare("SELECT PRODUCT_ID, PRODUCT_CODE FROM M_PRODUCT ORDER BY SORT_NO").all();
  const pid = Object.fromEntries(prod.map((r) => [r.PRODUCT_CODE, r.PRODUCT_ID]));
  return { env: { DB: new D1Adapter(db) }, raw: db, authUserId, pid };
}
function prepared(pid, code, priceId, amount) {
  return {
    product: { PRODUCT_ID: pid[code], PRODUCT_CODE: code, PRODUCT_NAME: code, STATUS: 1, SORT_NO: 1, DEL_FLG: 0 },
    priceId, amount,
  };
}
function locksFor(raw, attemptId) {
  return raw.prepare("SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK WHERE ATTEMPT_ID=?").get(attemptId).c;
}

/* ============================================================
 * 1. SID=NULL + CREATE_ATTEMPTED 判定（cancel の lock 解放可否）
 * ============================================================ */
test("isCreateResultIndeterminate: SID=NULL + CREATE_ATTEMPTED=1 → 結果不明（lock 維持側）", () => {
  assert.equal(isCreateResultIndeterminate({ STRIPE_SESSION_ID: null, CREATE_ATTEMPTED: 1 }), true);
});
test("isCreateResultIndeterminate: SID=NULL + CREATE_ATTEMPTED=0 → 未試行（解放可）", () => {
  assert.equal(isCreateResultIndeterminate({ STRIPE_SESSION_ID: null, CREATE_ATTEMPTED: 0 }), false);
});
test("isCreateResultIndeterminate: SID 有 → 判定対象外（false）", () => {
  assert.equal(isCreateResultIndeterminate({ STRIPE_SESSION_ID: "cs_1", CREATE_ATTEMPTED: 1 }), false);
});

test("markCreateAttempted: DB に CREATE_ATTEMPTED=1 が確定し、以後 lock は cancel だけで解放しない対象になる", async () => {
  const { env, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-ca", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  // create 直前相当
  await markCreateAttempted(env, a.ATTEMPT_ID);
  const row = await getAttemptByOperationId(env, "op-ca");
  assert.equal(row.CREATE_ATTEMPTED, 1);
  assert.equal(row.STRIPE_SESSION_ID, null);
  // この状態は「結果不明」→ cancel で解放してはいけない
  assert.equal(isCreateResultIndeterminate(row), true);
});

/* ============================================================
 * 3. CASE C: SID 保存失敗 → paid webhook → attempt PAID + lock 解放
 * ============================================================ */
test("reconcileAttemptForSession: 第一経路 SID 一致で PAID + lock 解放", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-sid", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  // SID を保存済みにする（通常経路）
  raw.prepare("UPDATE T_CHECKOUT_ATTEMPT SET STRIPE_SESSION_ID='cs_known', STATUS=1 WHERE ATTEMPT_ID=?").run(a.ATTEMPT_ID);
  await reconcileAttemptForSession(env, {
    sessionId: "cs_known", authUserId, clientReferenceId: "op-sid",
    items: [{ productCode: "HANABI", productId: pid.HANABI, amount: 4000 }],
  });
  assert.equal((await getAttemptByOperationId(env, "op-sid")).STATUS, ATTEMPT_STATUS.PAID);
  assert.equal(locksFor(raw, a.ATTEMPT_ID), 0);
});

test("reconcileAttemptForSession: CASE C（SID=NULL）→ operationId で回収 → SID 保存 + PAID + lock 解放", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-casec", authUserId, cartKey: buildCartKey(["HANABI", "SUN_AND_MOON"]),
    buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "p1", 13000), prepared(pid, "HANABI", "p2", 4000)],
  });
  // CASE C: create は成功したが SID 保存に失敗した状態（SID=NULL のまま、CREATE_ATTEMPTED=1）
  await markCreateAttempted(env, a.ATTEMPT_ID);
  // Webhook: SID 一致では見つからない → client_reference_id(operationId) で回収
  await reconcileAttemptForSession(env, {
    sessionId: "cs_recovered", authUserId, clientReferenceId: "op-casec",
    items: [
      { productCode: "SUN_AND_MOON", productId: pid.SUN_AND_MOON, amount: 13000 },
      { productCode: "HANABI", productId: pid.HANABI, amount: 4000 },
    ],
  });
  const row = await getAttemptByOperationId(env, "op-casec");
  assert.equal(row.STATUS, ATTEMPT_STATUS.PAID);
  assert.equal(row.STRIPE_SESSION_ID, "cs_recovered"); // SID 回収済み
  assert.equal(locksFor(raw, a.ATTEMPT_ID), 0);        // lock 解放
});

test("reconcileAttemptForSession: CASE C で AUTH_USER_ID 不一致なら回収しない（他人の Session）", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-owner", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await markCreateAttempted(env, a.ATTEMPT_ID);
  await reconcileAttemptForSession(env, {
    sessionId: "cs_x", authUserId: "someone-else", clientReferenceId: "op-owner",
    items: [{ productCode: "HANABI", productId: pid.HANABI, amount: 4000 }],
  });
  const row = await getAttemptByOperationId(env, "op-owner");
  assert.notEqual(row.STATUS, ATTEMPT_STATUS.PAID); // 変化なし
  assert.equal(locksFor(raw, a.ATTEMPT_ID), 1);      // lock 維持
});

test("reconcileAttemptForSession: CASE C で商品構成不一致なら回収しない", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-cart", authUserId, cartKey: buildCartKey(["HANABI", "SUN_AND_MOON"]),
    buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "p1", 13000), prepared(pid, "HANABI", "p2", 4000)],
  });
  await markCreateAttempted(env, a.ATTEMPT_ID);
  // Session の実 line_items が HANABI のみ（snapshot と不一致）
  await reconcileAttemptForSession(env, {
    sessionId: "cs_mismatch", authUserId, clientReferenceId: "op-cart",
    items: [{ productCode: "HANABI", productId: pid.HANABI, amount: 4000 }],
  });
  const row = await getAttemptByOperationId(env, "op-cart");
  assert.notEqual(row.STATUS, ATTEMPT_STATUS.PAID);
  assert.equal(locksFor(raw, a.ATTEMPT_ID), 2); // 2 lock 維持
});

/* ============================================================
 * 9. 固定 origin: retry でも Stripe create パラメータ不変
 * ============================================================ */
test("resolveBaseUrl: env.APP_BASE_URL の基底 URL を返す（request 非依存・パス保持）", () => {
  // Production（パス無し）＝従来どおり origin のまま（末尾スラッシュ除去）
  assert.equal(resolveBaseUrl({ APP_BASE_URL: "https://platform.example.com" }), "https://platform.example.com");
  assert.equal(resolveBaseUrl({ APP_BASE_URL: "https://platform.example.com/" }), "https://platform.example.com");
  assert.equal(resolveBaseUrl({ APP_BASE_URL: "http://localhost:8787" }), "http://localhost:8787");
  // Production 実値
  assert.equal(resolveBaseUrl({ APP_BASE_URL: "https://shingo-camera.com" }), "https://shingo-camera.com");
  // DEV（/dev パス）＝ /dev を保持（origin だけに潰さない）
  assert.equal(resolveBaseUrl({ APP_BASE_URL: "https://shingo-camera.com/dev" }), "https://shingo-camera.com/dev");
  assert.equal(resolveBaseUrl({ APP_BASE_URL: "https://shingo-camera.com/dev/" }), "https://shingo-camera.com/dev");
});
test("resolveBaseUrl: Checkout return URL が env 別に正しく組める（success/cancel とも脱出しない）", () => {
  // Production: /dev 無し
  const prod = resolveBaseUrl({ APP_BASE_URL: "https://shingo-camera.com" });
  assert.equal(`${prod}/purchase/success/?session_id={CHECKOUT_SESSION_ID}`,
    "https://shingo-camera.com/purchase/success/?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(`${prod}/purchase/cancel/?operation_id=op1`,
    "https://shingo-camera.com/purchase/cancel/?operation_id=op1");
  // DEV: success/cancel とも /dev を含む（Production root へ脱出しない）
  const dev = resolveBaseUrl({ APP_BASE_URL: "https://shingo-camera.com/dev" });
  assert.equal(`${dev}/purchase/success/?session_id={CHECKOUT_SESSION_ID}`,
    "https://shingo-camera.com/dev/purchase/success/?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(`${dev}/purchase/cancel/?operation_id=op1`,
    "https://shingo-camera.com/dev/purchase/cancel/?operation_id=op1");
});
test("resolveBaseUrl: 未設定・不正は throw（壊れた URL の Session を作らない）", () => {
  assert.throws(() => resolveBaseUrl({}));
  assert.throws(() => resolveBaseUrl({ APP_BASE_URL: "" }));
  assert.throws(() => resolveBaseUrl({ APP_BASE_URL: "not-a-url" }));
});

test("rebuildCreateParams: 同一 attempt + 同一 origin の retry で create パラメータが完全一致（不変）", async () => {
  const { env, authUserId, pid } = freshEnv();
  const attempt = await createAttemptWithLocks(env, {
    operationId: "op-stable", authUserId, cartKey: buildCartKey(["HANABI", "SUN_AND_MOON"]),
    buyerEmail: "snap@example.com", totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "price_sam", 13000), prepared(pid, "HANABI", "price_hanabi", 4000)],
  });
  const origin = resolveBaseUrl({ APP_BASE_URL: "https://platform.example.com" });
  const p1 = await rebuildCreateParams(env, attempt, origin);
  const p2 = await rebuildCreateParams(env, attempt, origin);
  // idempotencyKey / lineItems / metadata / URL がすべて一致（retry しても変化しない）
  assert.deepEqual(p1, p2);
  assert.ok(p1.successUrl.startsWith("https://platform.example.com/"));
  assert.ok(p1.cancelUrl.startsWith("https://platform.example.com/"));
  assert.ok(p1.successUrl.includes("{CHECKOUT_SESSION_ID}"));
  assert.ok(p1.cancelUrl.includes("operation_id=op-stable"));
});

test("rebuildCreateParams: origin を APP_BASE_URL 由来にすれば request origin が変わっても create params は不変", async () => {
  const { env, authUserId, pid } = freshEnv();
  const attempt = await createAttemptWithLocks(env, {
    operationId: "op-origin", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "price_hanabi", 4000)],
  });
  // request.url.origin がどう変化しても、rebuildCreateParams に渡すのは resolveBaseUrl(env) のみ。
  const fixed = resolveBaseUrl({ APP_BASE_URL: "https://fixed.example.com" });
  const first = await rebuildCreateParams(env, attempt, fixed);
  // 別リクエスト（別 origin ヘッダ）でも fixed を使う限り同一
  const second = await rebuildCreateParams(env, attempt, fixed);
  assert.equal(first.successUrl, second.successUrl);
  assert.equal(first.cancelUrl, second.cancelUrl);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
});

/* ============================================================
 * 4/5/6. success の全商品追跡ロジック（純判定）
 *   success 画面は「今回購入した全 targetCodes が available」で完了。
 *   フロント表示は E2E で確認するが、判定ロジックの核をここで固定する。
 * ============================================================ */
function allTargetsGranted(targetCodes, availableMap) {
  if (!targetCodes || targetCodes.length === 0) return false; // 対象未確定は完了にしない
  return targetCodes.every((c) => availableMap[c] === true);
}
test("success 判定: 既保有 HANABI + EARTH 購入で EARTH 未反映 → 完了にならない", () => {
  // 今回購入は EARTH のみ（recover の purchasedCodes = [EARTH]）。HANABI は既保有だが対象外。
  const target = ["HANABI_GOOGLE_EARTH"];
  const map = { HANABI: true, HANABI_GOOGLE_EARTH: false };
  assert.equal(allTargetsGranted(target, map), false);
});
test("success 判定: 複数購入で一部だけ granted → 完了にならない", () => {
  const target = ["SUN_AND_MOON", "HANABI"];
  const map = { SUN_AND_MOON: true, HANABI: false };
  assert.equal(allTargetsGranted(target, map), false);
});
test("success 判定: 全購入商品 granted → 完了", () => {
  const target = ["SUN_AND_MOON", "HANABI"];
  const map = { SUN_AND_MOON: true, HANABI: true };
  assert.equal(allTargetsGranted(target, map), true);
});
test("success 判定: 対象未確定（recover 失敗で targetCodes 空）→ 完了にしない", () => {
  assert.equal(allTargetsGranted([], { HANABI: true }), false);
});
