// 購入再開始フロー（Checkout 再開始）のテスト
// DB/純ロジックで検証できる範囲（旧 attempt 検出・settle の SID=NULL 経路）を自動化。
// Stripe retrieve/expire を伴う open/expired/complete 経路は E2E で確認。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  createAttemptWithLocks,
  findActiveAttemptHoldingAnyProduct,
  getAttemptByOperationId,
  markCreateAttempted,
  cancelAttempt,
  updateAttemptStatus,
  settleAttemptViaStripe,
  ATTEMPT_STATUS,
} from "./_bundle/purchase_logic.mjs";

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
  db.prepare("INSERT INTO M_USER (AUTH_USER_ID,LOGIN_MAIL,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,1,0,?,?)").run("u1", "a@b.c", now, now);
  const prod = db.prepare("SELECT PRODUCT_ID, PRODUCT_CODE FROM M_PRODUCT ORDER BY SORT_NO").all();
  const pid = Object.fromEntries(prod.map((r) => [r.PRODUCT_CODE, r.PRODUCT_ID]));
  return { env: { DB: new D1Adapter(db) }, raw: db, authUserId: "u1", pid };
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

/* ---- findActiveAttemptHoldingAnyProduct（旧 attempt 検出）---- */
test("旧attempt検出: 商品を保持する未完了 attempt を検出", async () => {
  const { env, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-old", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const found = await findActiveAttemptHoldingAnyProduct(env, authUserId, [pid.HANABI]);
  assert.ok(found);
  assert.equal(found.ATTEMPT_ID, a.ATTEMPT_ID);
});

test("旧attempt検出: excludeOperationId で自分（同一操作の再送）は除外", async () => {
  const { env, authUserId, pid } = freshEnv();
  await createAttemptWithLocks(env, {
    operationId: "op-self", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const found = await findActiveAttemptHoldingAnyProduct(env, authUserId, [pid.HANABI], "op-self");
  assert.equal(found, null);
});

test("旧attempt検出: CANCELLED は未完了でないため検出しない", async () => {
  const { env, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-done", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await cancelAttempt(env, a.ATTEMPT_ID);
  const found = await findActiveAttemptHoldingAnyProduct(env, authUserId, [pid.HANABI]);
  assert.equal(found, null);
});

test("旧attempt検出: 商品構成が一部でも重複すれば検出（部分再利用しない）", async () => {
  const { env, authUserId, pid } = freshEnv();
  await createAttemptWithLocks(env, {
    operationId: "op-h", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const found = await findActiveAttemptHoldingAnyProduct(env, authUserId, [pid.SUN_AND_MOON, pid.HANABI]);
  assert.ok(found);
  assert.equal(found.OPERATION_ID, "op-h");
});

test("旧attempt検出: 重複商品が無ければ null（通常の新規 Checkout へ）", async () => {
  const { env, authUserId, pid } = freshEnv();
  await createAttemptWithLocks(env, {
    operationId: "op-h2", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const found = await findActiveAttemptHoldingAnyProduct(env, authUserId, [pid.SUN_AND_MOON]);
  assert.equal(found, null);
});

/* ---- settleAttemptViaStripe の SID=NULL 経路（Stripe 呼び出しなし）---- */
test("settle: SID=NULL + CREATE_ATTEMPTED=0 → not_created（cancel + lock解放）", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-nc", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const row = await getAttemptByOperationId(env, "op-nc");
  const r = await settleAttemptViaStripe(env, row, { expireOpen: true });
  assert.equal(r, "not_created");
  assert.equal((await getAttemptByOperationId(env, "op-nc")).STATUS, ATTEMPT_STATUS.CANCELLED);
  assert.equal(locksFor(raw, a.ATTEMPT_ID), 0);
});

test("settle: SID=NULL + CREATE_ATTEMPTED=1 → indeterminate（何もしない・lock維持）", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-ind", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await markCreateAttempted(env, a.ATTEMPT_ID);
  const row = await getAttemptByOperationId(env, "op-ind");
  const r = await settleAttemptViaStripe(env, row, { expireOpen: true });
  assert.equal(r, "indeterminate");
  assert.notEqual((await getAttemptByOperationId(env, "op-ind")).STATUS, ATTEMPT_STATUS.CANCELLED);
  assert.equal(locksFor(raw, a.ATTEMPT_ID), 1);
});

test("settle: PAID attempt → already_paid（終着しない）", async () => {
  const { env, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-paid", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await updateAttemptStatus(env, a.ATTEMPT_ID, ATTEMPT_STATUS.PAID);
  const row = await getAttemptByOperationId(env, "op-paid");
  const r = await settleAttemptViaStripe(env, row, { expireOpen: true });
  assert.equal(r, "already_paid");
});

/* ---- exclude を SQL 側で行う回帰テスト（LIMIT 前に除外し見逃さない）---- */
test("旧attempt検出: 除外対象が並び順の先頭でも、別の active 候補を見逃さない", async () => {
  const { env, authUserId, pid } = freshEnv();
  // 先に作る attempt-A（ATTEMPT_ID 小 = ORDER BY ASC の先頭）が SUN_AND_MOON を保持。
  const a = await createAttemptWithLocks(env, {
    operationId: "op-A", authUserId, cartKey: "SUN_AND_MOON", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "p1", 3000)],
  });
  // 後に作る attempt-B（ATTEMPT_ID 大）が HANABI を保持。
  await createAttemptWithLocks(env, {
    operationId: "op-B", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  // カート [SUN_AND_MOON, HANABI] で op-A を除外 → 先頭の A が除外対象。
  // 旧実装（TS 側で LIMIT 1 後に除外）だと A を取得して null 化し、B を見逃す。
  const found = await findActiveAttemptHoldingAnyProduct(
    env, authUserId, [pid.SUN_AND_MOON, pid.HANABI], "op-A",
  );
  assert.ok(found, "除外対象でない別 active 候補(B)を返すべき");
  assert.equal(found.OPERATION_ID, "op-B");
  assert.notEqual(found.ATTEMPT_ID, a.ATTEMPT_ID);
});

test("旧attempt検出: 除外対象のみが候補なら null（除外が効く）", async () => {
  const { env, authUserId, pid } = freshEnv();
  await createAttemptWithLocks(env, {
    operationId: "op-only", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const found = await findActiveAttemptHoldingAnyProduct(env, authUserId, [pid.HANABI], "op-only");
  assert.equal(found, null);
});

/* ---- 複数 active attempt（商品ごとに別 attempt）の把握 ---- */
import { findActiveAttemptsHoldingAnyProduct } from "./_bundle/purchase_logic.mjs";

test("複数attempt: 新カートと重複する active attempt を全件返す（attempt単位で一意）", async () => {
  const { env, authUserId, pid } = freshEnv();
  // A = SUN_AND_MOON, B = HANABI（別々の attempt）
  await createAttemptWithLocks(env, {
    operationId: "op-A", authUserId, cartKey: "SUN_AND_MOON", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "p1", 3000)],
  });
  await createAttemptWithLocks(env, {
    operationId: "op-B", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  // 新カート [SUN_AND_MOON, HANABI] → A と B の両方が重複
  const found = await findActiveAttemptsHoldingAnyProduct(
    env, authUserId, [pid.SUN_AND_MOON, pid.HANABI],
  );
  assert.equal(found.length, 2);
  const ops = found.map((a) => a.OPERATION_ID).sort();
  assert.deepEqual(ops, ["op-A", "op-B"]);
});

test("複数attempt: 重複しない別商品の attempt は含めない", async () => {
  const { env, authUserId, pid } = freshEnv();
  // A = SUN_AND_MOON（新カートと重複）, C = HANABI_GOOGLE_EARTH（重複しない）
  await createAttemptWithLocks(env, {
    operationId: "op-A", authUserId, cartKey: "SUN_AND_MOON", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "p1", 3000)],
  });
  await createAttemptWithLocks(env, {
    operationId: "op-C", authUserId, cartKey: "HANABI_GOOGLE_EARTH", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI_GOOGLE_EARTH", "p3", 1000)],
  });
  // 新カート [SUN_AND_MOON] のみ → A だけ対象、C は触らない
  const found = await findActiveAttemptsHoldingAnyProduct(env, authUserId, [pid.SUN_AND_MOON]);
  assert.equal(found.length, 1);
  assert.equal(found[0].OPERATION_ID, "op-A");
});

test("複数attempt: excludeOperationId を除いた全件を返す", async () => {
  const { env, authUserId, pid } = freshEnv();
  await createAttemptWithLocks(env, {
    operationId: "op-A", authUserId, cartKey: "SUN_AND_MOON", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "p1", 3000)],
  });
  await createAttemptWithLocks(env, {
    operationId: "op-B", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const found = await findActiveAttemptsHoldingAnyProduct(
    env, authUserId, [pid.SUN_AND_MOON, pid.HANABI], "op-A",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].OPERATION_ID, "op-B");
});

test("複数attempt: settle を全件に適用すると両方の lock が解放される（残ロック無し）", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  // A/B とも SID=NULL・CREATE_ATTEMPTED=0（create 未試行）→ settle で not_created
  const a = await createAttemptWithLocks(env, {
    operationId: "op-A", authUserId, cartKey: "SUN_AND_MOON", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "p1", 3000)],
  });
  const b = await createAttemptWithLocks(env, {
    operationId: "op-B", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const found = await findActiveAttemptsHoldingAnyProduct(
    env, authUserId, [pid.SUN_AND_MOON, pid.HANABI],
  );
  for (const old of found) {
    const r = await settleAttemptViaStripe(env, old, { expireOpen: true });
    assert.equal(r, "not_created");
  }
  // 両 attempt の lock が解放され、新カートの商品を押さえる lock が残っていない
  const remain = raw.prepare(
    "SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK WHERE PRODUCT_ID IN (?,?)",
  ).get(pid.SUN_AND_MOON, pid.HANABI).c;
  assert.equal(remain, 0);
  assert.equal(locksFor(raw, a.ATTEMPT_ID), 0);
  assert.equal(locksFor(raw, b.ATTEMPT_ID), 0);
});

/* ---- getActiveAttemptsForUser（STORE表示の状態同期・別端末対応）---- */
import { getActiveAttemptsForUser, updateAttemptStatus as updAttStatus } from "./_bundle/purchase_logic.mjs";

test("activeCheckout: ユーザーの active(CREATING/OPEN) attempt を operationId なしで取得", async () => {
  const { env, authUserId, pid } = freshEnv();
  await createAttemptWithLocks(env, {
    operationId: "op-1", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  // operationId を渡さずに（別端末想定で）取得できる
  const actives = await getActiveAttemptsForUser(env, authUserId);
  assert.equal(actives.length, 1);
  assert.equal(actives[0].OPERATION_ID, "op-1");
});

test("activeCheckout: 終端(EXPIRED/CANCELLED/PAID)は active に含めない", async () => {
  const { env, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-exp", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await updAttStatus(env, a.ATTEMPT_ID, ATTEMPT_STATUS.EXPIRED);
  const actives = await getActiveAttemptsForUser(env, authUserId);
  assert.equal(actives.length, 0);
});

test("activeCheckout: 他ユーザーの attempt は取得しない（境界）", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  // 別ユーザー u2 を追加し、その attempt を作る
  raw.prepare("INSERT INTO M_USER (AUTH_USER_ID,LOGIN_MAIL,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES ('u2','x@y.z',1,0,'2026-08-09T00:00:00+09:00','2026-08-09T00:00:00+09:00')").run();
  await createAttemptWithLocks(env, {
    operationId: "op-u2", authUserId: "u2", cartKey: "HANABI", buyerEmail: "x@y.z", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  // u1 で取得 → u2 の attempt は含まれない
  const actives = await getActiveAttemptsForUser(env, authUserId);
  assert.equal(actives.length, 0);
});

test("activeCheckout: 複数 active は ATTEMPT_ID 昇順（開始順）で返る（最新判定用）", async () => {
  const { env, authUserId, pid } = freshEnv();
  const a1 = await createAttemptWithLocks(env, {
    operationId: "op-A", authUserId, cartKey: "SUN_AND_MOON", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "p1", 3000)],
  });
  const a2 = await createAttemptWithLocks(env, {
    operationId: "op-B", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const actives = await getActiveAttemptsForUser(env, authUserId);
  assert.equal(actives.length, 2);
  // 昇順（a1 が先、a2 が後＝最新）
  assert.ok(actives[0].ATTEMPT_ID < actives[1].ATTEMPT_ID);
  assert.equal(actives[actives.length - 1].OPERATION_ID, "op-B");
});

/* ---- 3点補正: settle の completed 区別・handleActiveCheckout の安全側 ---- */
test("settle: 元PAID は already_paid（completed ではない）", async () => {
  const { env, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-paid2", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await updAttStatus(env, a.ATTEMPT_ID, ATTEMPT_STATUS.PAID);
  const row = await getAttemptByOperationId(env, "op-paid2");
  // 元 PAID は Stripe を見ずに already_paid（completed に丸めない）
  const r = await settleAttemptViaStripe(env, row, { expireOpen: false });
  assert.equal(r, "already_paid");
});

test("settle: SID=NULL 経路は completed を返さない（not_created / indeterminate のみ）", async () => {
  const { env, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-nc2", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const row = await getAttemptByOperationId(env, "op-nc2");
  const r = await settleAttemptViaStripe(env, row, { expireOpen: false });
  assert.equal(r, "not_created"); // completed ではない
});
