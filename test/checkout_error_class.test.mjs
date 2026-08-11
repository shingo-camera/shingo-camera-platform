// レビュー修正2 の回帰テスト: createAttemptWithLocks の DB エラー分類
// lock 競合のみ ALREADY_IN_PROGRESS(409)、それ以外（FK/他 constraint/D1 障害）は INTERNAL_ERROR(500)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  isLockConflictError,
  createAttemptWithLocks,
  ATTEMPT_STATUS,
} from "./_bundle/purchase_logic.mjs";

/* ---- isLockConflictError 単体 ---- */
test("isLockConflictError: lock PK/UNIQUE 競合メッセージ → true", () => {
  const e = new Error(
    "UNIQUE constraint failed: T_PRODUCT_CHECKOUT_LOCK.AUTH_USER_ID, T_PRODUCT_CHECKOUT_LOCK.PRODUCT_ID",
  );
  assert.equal(isLockConflictError(e), true);
});
test("isLockConflictError: D1_ERROR プレフィックス付きの lock 競合 → true", () => {
  const e = new Error(
    "D1_ERROR: UNIQUE constraint failed: T_PRODUCT_CHECKOUT_LOCK.AUTH_USER_ID, T_PRODUCT_CHECKOUT_LOCK.PRODUCT_ID: SQLITE_CONSTRAINT",
  );
  assert.equal(isLockConflictError(e), true);
});
test("isLockConflictError: FK 違反 → false（500 扱い）", () => {
  assert.equal(isLockConflictError(new Error("FOREIGN KEY constraint failed")), false);
});
test("isLockConflictError: 他テーブルの UNIQUE 競合 → false", () => {
  const e = new Error("UNIQUE constraint failed: T_CHECKOUT_ATTEMPT_ITEM.ATTEMPT_ID, T_CHECKOUT_ATTEMPT_ITEM.PRODUCT_ID");
  assert.equal(isLockConflictError(e), false);
});
test("isLockConflictError: D1 障害・一般エラー → false", () => {
  assert.equal(isLockConflictError(new Error("D1_ERROR: Network connection lost")), false);
  assert.equal(isLockConflictError(new Error("something went wrong")), false);
  assert.equal(isLockConflictError("string error"), false);
  assert.equal(isLockConflictError(null), false);
});

/* ---- D1 アダプタ ---- */
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
function freshEnv(opts) {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync("migrations/" + f, "utf8"));
  if (opts && opts.foreignKeys) db.exec("PRAGMA foreign_keys=ON");
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

/* ---- createAttemptWithLocks の分類（統合）---- */
test("createAttemptWithLocks: lock 競合は ALREADY_IN_PROGRESS(409)", async () => {
  const { env, authUserId, pid } = freshEnv();
  await createAttemptWithLocks(env, {
    operationId: "opA", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await assert.rejects(
    () => createAttemptWithLocks(env, {
      operationId: "opB", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
      items: [prepared(pid, "HANABI", "p2", 4000)],
    }),
    (e) => e.code === "ALREADY_IN_PROGRESS" && e.status === 409,
  );
});

test("createAttemptWithLocks: 非 lock エラー（FK 違反）は INTERNAL_ERROR(500)・ALREADY_IN_PROGRESS にしない", async () => {
  // foreign_keys=ON + 存在しない AUTH_USER_ID で attempt INSERT を FK 違反させる
  const { env, pid } = freshEnv({ foreignKeys: true });
  await assert.rejects(
    () => createAttemptWithLocks(env, {
      operationId: "opGhost", authUserId: "ghost-user-not-in-M_USER", cartKey: "HANABI",
      buyerEmail: "a@b.c", totalAmount: 0,
      items: [prepared(pid, "HANABI", "p2", 4000)],
    }),
    (e) => e.code === "INTERNAL_ERROR" && e.status === 500,
  );
});

test("createAttemptWithLocks: FK 違反時も batch は rollback され部分行を残さない（原子性維持）", async () => {
  const { env, raw, pid } = freshEnv({ foreignKeys: true });
  await assert.rejects(() => createAttemptWithLocks(env, {
    operationId: "opGhost2", authUserId: "ghost-user", cartKey: "HANABI",
    buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  }));
  // attempt / item / lock いずれも残っていない
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM T_CHECKOUT_ATTEMPT WHERE OPERATION_ID='opGhost2'").get().c, 0);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK").get().c, 0);
});

/* 参考: 正常時は attempt が作られる（分類変更で正常系が壊れていないこと）*/
test("createAttemptWithLocks: 正常時は CREATING で作成される（回帰）", async () => {
  const { env, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "opOk", authUserId, cartKey: "HANABI", buyerEmail: "a@b.c", totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  assert.equal(a.STATUS, ATTEMPT_STATUS.CREATING);
});
