// DB ロジックテスト（node:sqlite を D1 インターフェースにラップして実関数を検証）
// 対象: createAttemptWithLocks（lock PK 競合 batch rollback / 3 商品原子性）,
//       rebuildCreateParams（Price/email snapshot 再現）, detectDuplicatePaidProductIds,
//       recordPaymentEvent（event.id 冪等）, attempt 状態遷移（cancel/expire/paid）,
//       attemptHoldsAllLocks。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  createAttemptWithLocks,
  getAttemptByOperationId,
  getAttemptItems,
  attemptHoldsAllLocks,
  rebuildCreateParams,
  detectDuplicatePaidProductIds,
  recordPaymentEvent,
  cancelAttempt,
  expireAttempt,
  markAttemptPaid,
  buildPreparedItems,
  ATTEMPT_STATUS,
  PAYMENT_EVENT_TYPE,
} from "./_bundle/purchase_logic.mjs";

/* ---- node:sqlite を D1Database インターフェースへラップするアダプタ ---- */
class D1Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new D1Stmt(this.db, this.sql, args);
  }
  async first() {
    const s = this.db.prepare(this.sql);
    const row = s.get(...this.args);
    return row ?? null;
  }
  async all() {
    const s = this.db.prepare(this.sql);
    return { results: s.all(...this.args) };
  }
  async run() {
    const s = this.db.prepare(this.sql);
    const r = s.run(...this.args);
    return { success: true, meta: r };
  }
}
class D1Adapter {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new D1Stmt(this.db, sql);
  }
  async batch(stmts) {
    // D1 の batch セマンティクス: 暗黙トランザクションで順次実行、1 文でも失敗で全 rollback。
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const st of stmts) {
        const s = this.db.prepare(st.sql);
        out.push(s.run(...st.args));
      }
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

const MIGRATIONS = [
  "0001_initial_schema.sql",
  "0002_fix_jst_datetime.sql",
  "0003_add_access_log_interval_setting.sql",
  "0004_add_warning_threshold_settings.sql",
  "0005_add_t_order_and_purchase_order_id.sql",
  "0006_add_checkout_attempt_lifecycle.sql",
];

function freshEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync("migrations/" + f, "utf8"));
  // M_USER が無ければ 1 件用意
  const u = db.prepare("SELECT AUTH_USER_ID FROM M_USER LIMIT 1").get();
  const now = "2026-08-09T00:00:00+09:00";
  if (!u) {
    db.prepare(
      "INSERT INTO M_USER (AUTH_USER_ID,LOGIN_MAIL,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,?,?,?,?)",
    ).run("u1", "a@b.c", 1, 0, now, now);
  }
  const authUserId = db.prepare("SELECT AUTH_USER_ID FROM M_USER LIMIT 1").get().AUTH_USER_ID;
  const prod = db.prepare("SELECT PRODUCT_ID, PRODUCT_CODE FROM M_PRODUCT ORDER BY SORT_NO").all();
  const pid = Object.fromEntries(prod.map((r) => [r.PRODUCT_CODE, r.PRODUCT_ID]));
  return { env: { DB: new D1Adapter(db) }, raw: db, authUserId, pid };
}

function prepared(pid, code, priceId, amount) {
  return {
    product: { PRODUCT_ID: pid[code], PRODUCT_CODE: code, PRODUCT_NAME: code, STATUS: 1, SORT_NO: 1, DEL_FLG: 0 },
    priceId,
    amount,
  };
}

/* ---- createAttemptWithLocks: 正常 ---- */
test("createAttemptWithLocks: 新規 attempt + item + lock を作成", async () => {
  const { env, authUserId, pid } = freshEnv();
  const items = [
    prepared(pid, "SUN_AND_MOON", "price_sam", 13000),
    prepared(pid, "HANABI", "price_hanabi", 4000),
  ];
  const attempt = await createAttemptWithLocks(env, {
    operationId: "op-1",
    authUserId,
    cartKey: "HANABI|SUN_AND_MOON",
    buyerEmail: "a@b.c",
    totalAmount: 0,
    items,
  });
  assert.equal(attempt.STATUS, ATTEMPT_STATUS.CREATING);
  const savedItems = await getAttemptItems(env, attempt.ATTEMPT_ID);
  assert.equal(savedItems.length, 2);
  assert.ok(await attemptHoldsAllLocks(env, attempt.ATTEMPT_ID, [pid.SUN_AND_MOON, pid.HANABI]));
});

/* ---- lock PK 競合で batch 全 rollback（部分ロックなし）---- */
test("createAttemptWithLocks: lock 競合で敗者は完全 rollback（部分状態なし）", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  // A: SUN + HANABI を取得
  await createAttemptWithLocks(env, {
    operationId: "opA",
    authUserId,
    cartKey: "HANABI|SUN_AND_MOON",
    buyerEmail: "a@b.c",
    totalAmount: 0,
    items: [prepared(pid, "SUN_AND_MOON", "p1", 13000), prepared(pid, "HANABI", "p2", 4000)],
  });
  // B: HANABI を含む別 cart（競合 → ALREADY_IN_PROGRESS）
  await assert.rejects(
    () =>
      createAttemptWithLocks(env, {
        operationId: "opB",
        authUserId,
        cartKey: "HANABI",
        buyerEmail: "a@b.c",
        totalAmount: 0,
        items: [prepared(pid, "HANABI", "p2", 4000)],
      }),
    (e) => e.code === "ALREADY_IN_PROGRESS",
  );
  // B の attempt / item が残っていないこと（rollback）
  const bAttempt = raw.prepare("SELECT COUNT(*) c FROM T_CHECKOUT_ATTEMPT WHERE OPERATION_ID='opB'").get().c;
  assert.equal(bAttempt, 0);
  const bItem = raw
    .prepare(
      "SELECT COUNT(*) c FROM T_CHECKOUT_ATTEMPT_ITEM ai JOIN T_CHECKOUT_ATTEMPT a ON a.ATTEMPT_ID=ai.ATTEMPT_ID WHERE a.OPERATION_ID='opB'",
    )
    .get().c;
  assert.equal(bItem, 0);
  // lock は A の 2 件のみ（部分ロックなし）
  const locks = raw.prepare("SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK").get().c;
  assert.equal(locks, 2);
});

/* ---- 3 商品の lock 原子性（1 商品だけ競合しても全 rollback）---- */
test("createAttemptWithLocks: 3 商品中 1 商品競合で 3 lock とも作られない", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  // 先に HANABI だけ別 attempt が保持
  await createAttemptWithLocks(env, {
    operationId: "opX",
    authUserId,
    cartKey: "HANABI",
    buyerEmail: "a@b.c",
    totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  const before = raw.prepare("SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK").get().c; // 1
  // 3 商品（SUN+HANABI+EARTH）を要求 → HANABI で競合 → 全 rollback
  await assert.rejects(() =>
    createAttemptWithLocks(env, {
      operationId: "op3",
      authUserId,
      cartKey: "HANABI|HANABI_GOOGLE_EARTH|SUN_AND_MOON",
      buyerEmail: "a@b.c",
      totalAmount: 0,
      items: [
        prepared(pid, "SUN_AND_MOON", "p1", 13000),
        prepared(pid, "HANABI", "p2", 4000),
        prepared(pid, "HANABI_GOOGLE_EARTH", "p3", 10000),
      ],
    }),
  );
  const after = raw.prepare("SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK").get().c;
  assert.equal(after, before); // 増えていない（SUN/EARTH の lock も作られていない）
});

/* ---- rebuildCreateParams: Price/email snapshot 再現 ---- */
test("rebuildCreateParams: DB snapshot から create パラメータを完全再現", async () => {
  const { env, authUserId, pid } = freshEnv();
  const attempt = await createAttemptWithLocks(env, {
    operationId: "op-rebuild",
    authUserId,
    cartKey: "HANABI|SUN_AND_MOON",
    buyerEmail: "snapshot@example.com",
    totalAmount: 0,
    items: [
      prepared(pid, "SUN_AND_MOON", "price_sam_v1", 13000),
      prepared(pid, "HANABI", "price_hanabi_v1", 4000),
    ],
  });
  const params = await rebuildCreateParams(env, attempt, "https://example.com");
  // email は snapshot 値（実行時 auth.email ではない）
  assert.equal(params.customerEmail, "snapshot@example.com");
  // line_items は保存済み Price ID（Price 変更後でも初回値を再現）
  assert.deepEqual(
    params.lineItems.map((l) => l.price),
    ["price_sam_v1", "price_hanabi_v1"],
  );
  assert.ok(params.lineItems.every((l) => l.quantity === 1));
  // metadata
  assert.equal(params.metadata.auth_user_id, authUserId);
  assert.equal(params.metadata.product_codes, "SUN_AND_MOON,HANABI");
  // client_reference_id = operationId
  assert.equal(params.clientReferenceId, "op-rebuild");
  // idempotencyKey は server 生成 namespace
  assert.ok(params.idempotencyKey.startsWith("checkout:" + authUserId + ":op-rebuild"));
  // success_url は Stripe テンプレート、cancel_url は operationId
  assert.ok(params.successUrl.includes("{CHECKOUT_SESSION_ID}"));
  assert.ok(params.cancelUrl.includes("operation_id=op-rebuild"));
  assert.ok(!params.cancelUrl.includes("CHECKOUT_SESSION_ID"));
});

/* ---- attempt 状態遷移 + lock 解放 ---- */
test("cancelAttempt: CANCELLED にし lock を解放", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-c",
    authUserId,
    cartKey: "HANABI",
    buyerEmail: "a@b.c",
    totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await cancelAttempt(env, a.ATTEMPT_ID);
  const row = await getAttemptByOperationId(env, "op-c");
  assert.equal(row.STATUS, ATTEMPT_STATUS.CANCELLED);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK WHERE ATTEMPT_ID=?").get(a.ATTEMPT_ID).c, 0);
});

test("expireAttempt: EXPIRED にし lock を解放", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-e",
    authUserId,
    cartKey: "HANABI",
    buyerEmail: "a@b.c",
    totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await expireAttempt(env, a.ATTEMPT_ID);
  assert.equal((await getAttemptByOperationId(env, "op-e")).STATUS, ATTEMPT_STATUS.EXPIRED);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK WHERE ATTEMPT_ID=?").get(a.ATTEMPT_ID).c, 0);
});

test("markAttemptPaid: PAID にし lock を解放（再購入可能に）", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const a = await createAttemptWithLocks(env, {
    operationId: "op-p",
    authUserId,
    cartKey: "HANABI",
    buyerEmail: "a@b.c",
    totalAmount: 0,
    items: [prepared(pid, "HANABI", "p2", 4000)],
  });
  await markAttemptPaid(env, a.ATTEMPT_ID);
  assert.equal((await getAttemptByOperationId(env, "op-p")).STATUS, ATTEMPT_STATUS.PAID);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK WHERE ATTEMPT_ID=?").get(a.ATTEMPT_ID).c, 0);
});

/* ---- duplicate paid 検出 ---- */
test("detectDuplicatePaidProductIds: 別注文で paid 済み商品を検出", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const now = "2026-08-09T00:00:00+09:00";
  // 別 Session の T_ORDER + paid T_PURCHASE（HANABI）を用意
  raw
    .prepare(
      "INSERT INTO T_ORDER (AUTH_USER_ID,PURCHASE_SOURCE,EXTERNAL_ORDER_ID,ORDER_DATE,TOTAL_AMOUNT,PAYMENT_STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,?,?,?,?,0,?,?)",
    )
    .run(authUserId, 0, "cs_other", now, 4000, 1, now, now);
  const orderId = raw.prepare("SELECT ORDER_ID FROM T_ORDER WHERE EXTERNAL_ORDER_ID='cs_other'").get().ORDER_ID;
  raw
    .prepare(
      "INSERT INTO T_PURCHASE (AUTH_USER_ID,PRODUCT_ID,ORDER_ID,PURCHASE_DATE,AMOUNT,PAYMENT_STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE,PURCHASE_SOURCE) VALUES (?,?,?,?,?,?,0,?,?,0)",
    )
    .run(authUserId, pid.HANABI, orderId, now, 4000, 1, now, now);

  // 現 Session cs_current で HANABI を fulfill しようとすると重複検出
  const dup = await detectDuplicatePaidProductIds(env, authUserId, [pid.HANABI, pid.SUN_AND_MOON], "cs_current");
  assert.deepEqual(dup, [pid.HANABI]);
});

test("detectDuplicatePaidProductIds: 同一 Session は除外（自分の注文は重複でない）", async () => {
  const { env, raw, authUserId, pid } = freshEnv();
  const now = "2026-08-09T00:00:00+09:00";
  raw
    .prepare(
      "INSERT INTO T_ORDER (AUTH_USER_ID,PURCHASE_SOURCE,EXTERNAL_ORDER_ID,ORDER_DATE,TOTAL_AMOUNT,PAYMENT_STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,?,?,?,?,0,?,?)",
    )
    .run(authUserId, 0, "cs_self", now, 4000, 1, now, now);
  const orderId = raw.prepare("SELECT ORDER_ID FROM T_ORDER WHERE EXTERNAL_ORDER_ID='cs_self'").get().ORDER_ID;
  raw
    .prepare(
      "INSERT INTO T_PURCHASE (AUTH_USER_ID,PRODUCT_ID,ORDER_ID,PURCHASE_DATE,AMOUNT,PAYMENT_STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE,PURCHASE_SOURCE) VALUES (?,?,?,?,?,?,0,?,?,0)",
    )
    .run(authUserId, pid.HANABI, orderId, now, 4000, 1, now, now);
  // 同じ Session を渡すと自分の注文は除外され重複なし
  const dup = await detectDuplicatePaidProductIds(env, authUserId, [pid.HANABI], "cs_self");
  assert.deepEqual(dup, []);
});

/* ---- recordPaymentEvent: event.id 冪等 ---- */
test("recordPaymentEvent: 同一 event.id は二重記録しない（冪等）", async () => {
  const { env, raw, authUserId } = freshEnv();
  const ev = {
    eventType: PAYMENT_EVENT_TYPE.REFUND,
    authUserId,
    stripeObjectId: "re_1",
    stripeEventId: "evt_dup",
    amount: 4000,
    status: "succeeded",
    detail: "charge.refunded",
  };
  await recordPaymentEvent(env, ev);
  await recordPaymentEvent(env, ev); // 再送
  const c = raw.prepare("SELECT COUNT(*) c FROM T_PAYMENT_EVENT WHERE STRIPE_EVENT_ID='evt_dup'").get().c;
  assert.equal(c, 1);
});

test("recordPaymentEvent: event.id が異なれば別記録（dispute）", async () => {
  const { env, raw, authUserId } = freshEnv();
  await recordPaymentEvent(env, {
    eventType: PAYMENT_EVENT_TYPE.DISPUTE,
    authUserId,
    stripeObjectId: "dp_1",
    stripeEventId: "evt_a",
    detail: "charge.dispute.created",
  });
  await recordPaymentEvent(env, {
    eventType: PAYMENT_EVENT_TYPE.DISPUTE,
    authUserId,
    stripeObjectId: "dp_1",
    stripeEventId: "evt_b",
    detail: "charge.dispute.updated",
  });
  const c = raw.prepare("SELECT COUNT(*) c FROM T_PAYMENT_EVENT WHERE EVENT_TYPE=?").get(PAYMENT_EVENT_TYPE.DISPUTE).c;
  assert.equal(c, 2);
});

/* ---- buildPreparedItems ---- */
test("buildPreparedItems: Price 未解決は PRODUCT_NOT_SELLABLE", () => {
  const products = [{ PRODUCT_ID: 2, PRODUCT_CODE: "HANABI", PRODUCT_NAME: "H", STATUS: 1, SORT_NO: 1, DEL_FLG: 0 }];
  const priceMap = new Map(); // 空
  assert.throws(() => buildPreparedItems(products, priceMap), (e) => e.code === "PRODUCT_NOT_SELLABLE");
});
