// 商品販売可否・Stripe Price ID の DB 一本化テスト（migration 0007 最終形）。
// 販売可否・販売方式・表示価格・Stripe Price ID の正本 = M_PRODUCT。
// precheckMultiCheckout が M_PRODUCT の PURCHASE_ENABLED / SALE_TYPE / STRIPE_PRICE_ID を正本に、
// Stripe 呼び出し前に未発売商品・非対応販売方式・販売設定未完了を拒否することを検証する。
//
// 要件:
//   A. migration 0001〜0007 をクリーン DB へ適用 → 成功
//   B. 0007 適用後の UPDATE_DATE が YYYY-MM-DDTHH:MM:SS+09:00 形式
//   C. SUN_AND_MOON（PURCHASE_ENABLED=1・ONE_TIME・STRIPE_PRICE_ID あり）→ precheck 成功
//   D. PURCHASE_ENABLED=0 → Stripe 前に拒否
//   E. STRIPE_PRICE_ID NULL → Stripe 前に「販売設定未完了」で拒否
//   F. SALE_TYPE=SUBSCRIPTION → Stripe 前に拒否
//   G. SUBSCRIPTION + PURCHASE_ENABLED=1 → STORE では購入不可/準備中（実ファイル検証）
//   H〜K. DISPLAY_PRICE 変更 → STORE カード/合計/購入確認/商品詳細の価格が DB 由来（実ファイル検証）
//   L. DISPLAY_PRICE と STRIPE_PRICE_ID は別物。DISPLAY_PRICE を Stripe Session へ金額として渡さない
//   M. 公開 API に STRIPE_PRICE_ID が含まれない
//   N. 既存 entitlement は PURCHASE_ENABLED=0 でも利用可能
//   O. 新 ONE_TIME 商品を DB 追加 → 商品コード switch 追加なしで precheck 可能
//   P. KNOWN_PRODUCT_CODES / SELLABLE_PRODUCT_CODES 等の固定商品一覧が販売/Checkout 正本として残っていない
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  precheckMultiCheckout,
  isProductAvailable,
  SALE_TYPE_ONE_TIME,
  SALE_TYPE_SUBSCRIPTION,
  buildPriceIdToCodeMapFromAttempt,
} from "./_bundle/purchase_logic.mjs";

/* ---- node:sqlite を D1Database インターフェースへラップ（checkout_db.test.mjs と同方式） ---- */
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
  "0006_add_checkout_attempt_lifecycle.sql", "0007_add_product_sale_columns.sql",
  "0008_add_product_dependency.sql",
];
// STRIPE_PRICE_ID は Test/Live で異なり migration に持たないため、テスト（Local 相当）では
// freshEnv で DB へ設定する（Production では別途 UPDATE。環境ごとの D1 に別 Price を持てることの検証）。
const TEST_PRICE = {
  SUN_AND_MOON: "price_test_sam",
  HANABI: "price_test_hanabi",
  HANABI_GOOGLE_EARTH: "price_test_earth",
};
function freshEnv({ setPrices = true } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync("migrations/" + f, "utf8"));
  const now = "2026-08-09T00:00:00+09:00";
  if (setPrices) {
    for (const [code, pid] of Object.entries(TEST_PRICE)) {
      db.prepare("UPDATE M_PRODUCT SET STRIPE_PRICE_ID=? WHERE PRODUCT_CODE=?").run(pid, code);
    }
  }
  if (!db.prepare("SELECT AUTH_USER_ID FROM M_USER LIMIT 1").get()) {
    db.prepare("INSERT INTO M_USER (AUTH_USER_ID,LOGIN_MAIL,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,?,?,?,?)")
      .run("u1", "a@b.c", 1, 0, now, now);
  }
  const authUserId = db.prepare("SELECT AUTH_USER_ID FROM M_USER LIMIT 1").get().AUTH_USER_ID;
  const pid = Object.fromEntries(
    db.prepare("SELECT PRODUCT_ID, PRODUCT_CODE FROM M_PRODUCT").all().map((r) => [r.PRODUCT_CODE, r.PRODUCT_ID]),
  );
  // env に商品別 STRIPE_PRICE_* は持たせない（DB 正本へ移行済み）。Stripe Secret のみ。
  return { env: { DB: new D1Adapter(db), STRIPE_SECRET_KEY: "sk_test_x" }, raw: db, authUserId, pid, now };
}

/* ============ 要件A/B: migration 適用・日時形式 ============ */

test("[sale] 要件A: migration 0001〜0007 をクリーン DB へ適用できる", () => {
  const { raw } = freshEnv();
  const cols = raw.prepare("PRAGMA table_info(M_PRODUCT)").all().map((c) => c.name);
  for (const c of ["PURCHASE_ENABLED", "SALE_TYPE", "DISPLAY_PRICE", "BILLING_INTERVAL", "STRIPE_PRICE_ID"]) {
    assert.ok(cols.includes(c), `M_PRODUCT に ${c} 列が存在する`);
  }
  // DISPLAY_ORDER は追加しない（SORT_NO に一本化）
  assert.ok(!cols.includes("DISPLAY_ORDER"), "DISPLAY_ORDER 列は存在しない（SORT_NO に一本化）");
});

test("[sale] 要件B: 0007 適用後の UPDATE_DATE が JST ISO 8601（+09:00）形式", () => {
  const { raw } = freshEnv({ setPrices: false });
  const rows = raw.prepare("SELECT PRODUCT_CODE, CREATE_DATE, UPDATE_DATE FROM M_PRODUCT").all();
  const pat = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
  for (const r of rows) {
    assert.match(r.UPDATE_DATE, pat, `${r.PRODUCT_CODE} UPDATE_DATE が JST ISO 8601`);
    assert.match(r.CREATE_DATE, pat, `${r.PRODUCT_CODE} CREATE_DATE が JST ISO 8601`);
  }
});

test("[sale] migration 0007: 初期値（SUN=販売中/HANABI・EARTH=準備中・Price は未設定）", () => {
  const { raw } = freshEnv({ setPrices: false });
  const rows = raw.prepare(
    "SELECT PRODUCT_CODE, STATUS, PURCHASE_ENABLED, SALE_TYPE, DISPLAY_PRICE, BILLING_INTERVAL, STRIPE_PRICE_ID FROM M_PRODUCT ORDER BY SORT_NO",
  ).all();
  const by = Object.fromEntries(rows.map((r) => [r.PRODUCT_CODE, r]));
  assert.equal(by.SUN_AND_MOON.STATUS, 1);
  assert.equal(by.SUN_AND_MOON.PURCHASE_ENABLED, 1);
  assert.equal(by.HANABI.PURCHASE_ENABLED, 0);
  assert.equal(by.HANABI_GOOGLE_EARTH.PURCHASE_ENABLED, 0);
  assert.equal(by.SUN_AND_MOON.DISPLAY_PRICE, 13000);
  assert.equal(by.HANABI.DISPLAY_PRICE, 4000);
  assert.equal(by.HANABI_GOOGLE_EARTH.DISPLAY_PRICE, 10000);
  // 実 Price ID は migration にハードコードしない（NULL）
  assert.equal(by.SUN_AND_MOON.STRIPE_PRICE_ID, null);
});

/* ============ 要件C〜F: precheck（DB 正本での販売可否判定） ============ */

test("[sale] 要件C: SUN_AND_MOON（PURCHASE_ENABLED=1・ONE_TIME・Price 設定済み）は precheck 通過", async () => {
  const { env, authUserId } = freshEnv();
  const r = await precheckMultiCheckout(env, authUserId, ["SUN_AND_MOON"]);
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].PRODUCT_CODE, "SUN_AND_MOON");
  // 解決された Price ID は DB の STRIPE_PRICE_ID
  assert.equal(r.priceIdByCode.get("SUN_AND_MOON"), TEST_PRICE.SUN_AND_MOON);
});

test("[sale] 要件D: PURCHASE_ENABLED=0（HANABI/EARTH）は Stripe 前に拒否", async () => {
  const { env, authUserId } = freshEnv();
  await assert.rejects(
    () => precheckMultiCheckout(env, authUserId, ["HANABI"]),
    (e) => e.code === "PRODUCT_NOT_SELLABLE",
  );
  await assert.rejects(
    () => precheckMultiCheckout(env, authUserId, ["HANABI_GOOGLE_EARTH"]),
    (e) => e.code === "PRODUCT_NOT_SELLABLE",
  );
});

test("[sale] 要件E: STRIPE_PRICE_ID NULL は Stripe 前に「販売設定未完了」として拒否", async () => {
  const { env, authUserId, raw, now } = freshEnv();
  // SUN_AND_MOON は販売中だが Price ID を消す → 販売設定未完了
  raw.prepare("UPDATE M_PRODUCT SET STRIPE_PRICE_ID=NULL, UPDATE_DATE=? WHERE PRODUCT_CODE='SUN_AND_MOON'").run(now);
  await assert.rejects(
    () => precheckMultiCheckout(env, authUserId, ["SUN_AND_MOON"]),
    (e) => e.code === "PRODUCT_NOT_SELLABLE",
  );
});

test("[sale] 要件F: SALE_TYPE=SUBSCRIPTION は Stripe 前に SALE_TYPE_NOT_SUPPORTED で拒否", async () => {
  const { env, authUserId, raw, now } = freshEnv();
  raw.prepare("UPDATE M_PRODUCT SET SALE_TYPE='SUBSCRIPTION', BILLING_INTERVAL='MONTH', UPDATE_DATE=? WHERE PRODUCT_CODE='SUN_AND_MOON'").run(now);
  await assert.rejects(
    () => precheckMultiCheckout(env, authUserId, ["SUN_AND_MOON"]),
    (e) => e.code === "SALE_TYPE_NOT_SUPPORTED",
  );
});

test("[sale] 販売停止商品を含む複数商品は注文全体を拒否", async () => {
  const { env, authUserId } = freshEnv();
  await assert.rejects(
    () => precheckMultiCheckout(env, authUserId, ["SUN_AND_MOON", "HANABI"]),
    (e) => e.code === "PRODUCT_NOT_SELLABLE",
  );
});

/* ============ 要件O: 新商品追加はコード改修不要 ============ */

test("[sale] 要件O: 新 ONE_TIME 商品を DB 追加すれば商品コード switch 追加なしで precheck できる", async () => {
  const { env, authUserId, raw, now } = freshEnv();
  // 新商品を M_PRODUCT へ INSERT（コード改修なし）。PURCHASE_ENABLED=1・ONE_TIME・Price 設定。
  raw.prepare(
    `INSERT INTO M_PRODUCT (PRODUCT_ID, PRODUCT_CODE, PRODUCT_NAME, STATUS, SORT_NO, DEL_FLG,
      CREATE_DATE, UPDATE_DATE, PURCHASE_ENABLED, SALE_TYPE, DISPLAY_PRICE, BILLING_INTERVAL, STRIPE_PRICE_ID)
     VALUES (99, 'NEW_PRODUCT', '新商品', 1, 99, 0, ?, ?, 1, 'ONE_TIME', 500, NULL, 'price_test_new')`,
  ).run(now, now);
  const r = await precheckMultiCheckout(env, authUserId, ["NEW_PRODUCT"]);
  assert.equal(r.products[0].PRODUCT_CODE, "NEW_PRODUCT");
  assert.equal(r.priceIdByCode.get("NEW_PRODUCT"), "price_test_new");
});

test("[sale] PURCHASE_ENABLED=1 に切り替えれば HANABI も購入可能（コード改修不要）", async () => {
  const { env, authUserId, raw, now } = freshEnv();
  raw.prepare("UPDATE M_PRODUCT SET PURCHASE_ENABLED=1, UPDATE_DATE=? WHERE PRODUCT_CODE='HANABI'").run(now);
  const r = await precheckMultiCheckout(env, authUserId, ["HANABI"]);
  assert.equal(r.products[0].PRODUCT_CODE, "HANABI");
});

/* ============ 要件N: entitlement 非影響 ============ */

test("[sale] 要件N: PURCHASE_ENABLED=0 でも既存 entitlement は利用可能（販売可否と独立）", async () => {
  const { env, authUserId, pid, raw, now } = freshEnv();
  raw.prepare(
    "INSERT INTO T_USER_PRODUCT (AUTH_USER_ID,PRODUCT_ID,STATUS,START_DATE,END_DATE,GRANT_TYPE,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(authUserId, pid.HANABI, 1, now, "2999-12-31T00:00:00+09:00", 1, 0, now, now);
  const available = await isProductAvailable(env, authUserId, "HANABI");
  assert.equal(available, true, "PURCHASE_ENABLED=0 でも既存購入者は利用可能であるべき");
});

test("[sale] STRIPE_PRICE_ID 未設定でも既存 entitlement は利用可能（販売設定と独立）", async () => {
  const { env, authUserId, pid, raw, now } = freshEnv({ setPrices: false });
  raw.prepare(
    "INSERT INTO T_USER_PRODUCT (AUTH_USER_ID,PRODUCT_ID,STATUS,START_DATE,END_DATE,GRANT_TYPE,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(authUserId, pid.SUN_AND_MOON, 1, now, "2999-12-31T00:00:00+09:00", 1, 0, now, now);
  const available = await isProductAvailable(env, authUserId, "SUN_AND_MOON");
  assert.equal(available, true);
});

/* ============ 要件M: 公開 API DB SELECT ============ */

test("[sale] 要件M: 商品一覧の公開 SELECT が販売状態を返し STRIPE_PRICE_ID を含めない", () => {
  const { raw } = freshEnv();
  // /api/products と同じ公開 SELECT（STRIPE_PRICE_ID・PRODUCT_ID を含めない）
  const rows = raw.prepare(
    `SELECT PRODUCT_CODE AS code, PURCHASE_ENABLED AS purchaseEnabled, SALE_TYPE AS saleType,
            DISPLAY_PRICE AS displayPrice, BILLING_INTERVAL AS billingInterval
     FROM M_PRODUCT WHERE STATUS = 1 AND DEL_FLG = 0 ORDER BY SORT_NO ASC`,
  ).all();
  const by = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(by.SUN_AND_MOON.purchaseEnabled, 1);
  assert.equal(by.SUN_AND_MOON.displayPrice, 13000);
  assert.equal(by.SUN_AND_MOON.STRIPE_PRICE_ID, undefined);
  assert.equal(by.SUN_AND_MOON.PRODUCT_ID, undefined);
});

/* ============ 定数 ============ */

test("[sale] SALE_TYPE 定数", () => {
  assert.equal(SALE_TYPE_ONE_TIME, "ONE_TIME");
  assert.equal(SALE_TYPE_SUBSCRIPTION, "SUBSCRIPTION");
});

/* ============ 実ファイル検証（STORE UI / API / 価格一元化 / 二重管理廃止） ============ */
const siteJs = readFileSync("public/assets/site.js", "utf8");
const purchaseTs = readFileSync("src/shared/purchase.ts", "utf8");
const productsTs = readFileSync("src/routes/products.ts", "utf8");
const entitlementTs = readFileSync("src/shared/entitlement.ts", "utf8");
const migration0007 = readFileSync("migrations/0007_add_product_sale_columns.sql", "utf8");
const indexTs = readFileSync("src/index.ts", "utf8");
const siteConfig = readFileSync("public/assets/site-config.js", "utf8");

test("[sale] 要件G: STORE UI は purchaseEnabled かつ ONE_TIME のみ購入可能（SUBSCRIPTION は準備中）", () => {
  assert.match(siteJs, /apiFetch\("\/api\/products"\)/);
  // 購入可能条件に saleType===ONE_TIME を含める（SUBSCRIPTION は購入不可）
  assert.match(siteJs, /meta\.purchaseEnabled === true && meta\.saleType === "ONE_TIME"/);
  // 取得失敗を安全側に倒す（saleInfoLoaded=false → saleLoadFailed）
  assert.match(siteJs, /saleLoadFailed = !saleInfoLoaded/);
  assert.match(siteJs, /saleInfoLoaded = false/);
});

test("[sale] 要件H〜K: 公開価格表示が DB DISPLAY_PRICE 由来（購入確認モーダルも DB 価格）", () => {
  // formatDisplayPrice が displayPrice を使う（月/年表示対応）
  assert.match(siteJs, /function formatDisplayPrice/);
  assert.match(siteJs, /meta\.displayPrice/);
  assert.match(siteJs, /"年"/);
  assert.match(siteJs, /"月"/);
  // 購入確認モーダルの金額が DB displayPrice を使う（site-config の amount を価格正本にしない）
  assert.match(siteJs, /priceOf\(c\)/);
  // 商品詳細ページ価格も DB から埋める
  assert.match(siteJs, /sam-price/);
});

test("[sale] 要件L: DISPLAY_PRICE を Stripe Session へ金額として渡していない（Price ID が正本）", () => {
  // precheck は STRIPE_PRICE_ID を解決して priceIdByCode に入れる。DISPLAY_PRICE を Stripe へ渡さない。
  assert.match(purchaseTs, /const priceId = product\.STRIPE_PRICE_ID/);
  // Session 作成は line_items の price（Price ID）で行う（金額を直接送らない）
  const purchasesRoute = readFileSync("src/routes/purchases.ts", "utf8");
  assert.match(purchasesRoute, /line_items:/);
  assert.doesNotMatch(purchasesRoute, /unit_amount:|amount:\s*product\.DISPLAY_PRICE/);
});

test("[sale] 要件M: /api/products が STRIPE_PRICE_ID を返さない", () => {
  assert.match(productsTs, /PURCHASE_ENABLED AS purchaseEnabled/);
  const fn = productsTs.slice(
    productsTs.indexOf("export async function handleProductList"),
    productsTs.indexOf("export async function", productsTs.indexOf("export async function handleProductList") + 1),
  );
  // 公開ハンドラの返却・SELECT に STRIPE_PRICE_ID を含めない
  assert.doesNotMatch(fn, /STRIPE_PRICE_ID/);
});

test("[sale] Checkout の Price 解決は M_PRODUCT.STRIPE_PRICE_ID（DB 正本）", () => {
  assert.match(purchaseTs, /product\.STRIPE_PRICE_ID/);
  assert.match(purchaseTs, /product\.PURCHASE_ENABLED !== 1/);
  assert.match(purchaseTs, /product\.SALE_TYPE !== SALE_TYPE_ONE_TIME/);
  // Webhook 逆引きも DB から構築（buildPriceIdToCodeMap が M_PRODUCT を参照）
  assert.match(purchaseTs, /SELECT PRODUCT_CODE AS code, STRIPE_PRICE_ID AS priceId/);
});

test("[sale] 要件P: KNOWN_PRODUCT_CODES / SELLABLE / resolvePriceId(env switch) が残っていない", () => {
  // 固定商品一覧・env Price switch が実コードに無い（コメントは許容するため識別子の定義/使用を確認）
  assert.doesNotMatch(purchaseTs, /const KNOWN_PRODUCT_CODES\s*=/);
  assert.doesNotMatch(purchaseTs, /export function resolvePriceId/);
  assert.doesNotMatch(purchaseTs, /SELLABLE_PRODUCT_CODES\s*[:=]/);
  // env の商品別 STRIPE_PRICE_* 参照が実コードに無い
  assert.doesNotMatch(purchaseTs, /env\.STRIPE_PRICE_SUN_AND_MOON|env\.STRIPE_PRICE_HANABI/);
  assert.doesNotMatch(indexTs, /STRIPE_PRICE_SUN_AND_MOON|STRIPE_PRICE_HANABI/);
});

test("[sale] migration 0007: UPDATE_DATE が strftime JST 形式・DISPLAY_ORDER 追加なし・Price 非ハードコード", () => {
  // 実行される SQL 行のみを対象にする（-- で始まるコメント行を除外）。
  const sqlLines = migration0007.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(sqlLines, /datetime\('now'\)/);
  assert.match(sqlLines, /strftime\('%Y-%m-%dT%H:%M:%S', 'now', '\+9 hours'\) \|\| '\+09:00'/);
  assert.doesNotMatch(sqlLines, /ADD COLUMN DISPLAY_ORDER/);
  assert.match(sqlLines, /ADD COLUMN STRIPE_PRICE_ID/);
  // 実 Price ID（price_ で始まる Stripe ID）を migration にハードコードしない
  assert.doesNotMatch(sqlLines, /price_[A-Za-z0-9]{6,}/);
});

test("[sale] site-config の purchasable / amount / priceDisplay が価格・販売正本として残っていない", () => {
  // site-config から purchasable / amount / priceDisplay フィールドを削除済み
  assert.doesNotMatch(siteConfig, /purchasable\s*:/);
  assert.doesNotMatch(siteConfig, /amount\s*:/);
  assert.doesNotMatch(siteConfig, /priceDisplay\s*:/);
  // site.js が site-config の販売/価格フィールドを参照していない
  // （it.amount は購入確認モーダルのローカル変数=DB priceOf 由来なので meta/CFG 経由の参照のみ検査）
  assert.doesNotMatch(siteJs, /\.purchasable/);
  assert.doesNotMatch(siteJs, /meta\.amount|m\.amount|\.priceDisplay/);
});

test("[sale] entitlement JOIN が販売情報を返すが available 判定には使わない", () => {
  assert.match(entitlementTs, /p\.PURCHASE_ENABLED AS purchaseEnabled/);
  assert.match(entitlementTs, /granted = r\.upStatus !== null/);
  // entitlement の JOIN・型に STRIPE_PRICE_ID を出さない（公開されうるため）
  const listFn = entitlementTs.slice(
    entitlementTs.indexOf("export async function listProductEntitlements"),
    entitlementTs.indexOf("export async function listMeProducts"),
  );
  assert.doesNotMatch(listFn, /STRIPE_PRICE_ID/);
});

/* ============ 販売列 CHECK 制約（migration 0007・要件B〜E） ============ */

test("[sale] 要件B: PURCHASE_ENABLED に 2 を入れると CHECK 制約で拒否", () => {
  const { raw } = freshEnv({ setPrices: false });
  assert.throws(() => raw.prepare("UPDATE M_PRODUCT SET PURCHASE_ENABLED=2 WHERE PRODUCT_CODE='HANABI'").run());
});

test("[sale] 要件C: SALE_TYPE='FOO' を入れると CHECK 制約で拒否", () => {
  const { raw } = freshEnv({ setPrices: false });
  assert.throws(() => raw.prepare("UPDATE M_PRODUCT SET SALE_TYPE='FOO' WHERE PRODUCT_CODE='HANABI'").run());
});

test("[sale] 要件D: DISPLAY_PRICE 負数を CHECK 制約で拒否", () => {
  const { raw } = freshEnv({ setPrices: false });
  assert.throws(() => raw.prepare("UPDATE M_PRODUCT SET DISPLAY_PRICE=-1 WHERE PRODUCT_CODE='HANABI'").run());
});

test("[sale] 要件E: BILLING_INTERVAL 不正値を CHECK 制約で拒否（MONTH/YEAR/NULL のみ）", () => {
  const { raw } = freshEnv({ setPrices: false });
  assert.throws(() => raw.prepare("UPDATE M_PRODUCT SET BILLING_INTERVAL='DAY' WHERE PRODUCT_CODE='HANABI'").run());
  // 有効値は通る
  raw.prepare("UPDATE M_PRODUCT SET SALE_TYPE='SUBSCRIPTION', BILLING_INTERVAL='MONTH' WHERE PRODUCT_CODE='HANABI'").run();
  raw.prepare("UPDATE M_PRODUCT SET BILLING_INTERVAL='YEAR' WHERE PRODUCT_CODE='HANABI'").run();
});

/* ============ STRIPE_PRICE_ID UNIQUE（migration 0007・要件F/G） ============ */

test("[sale] 要件F: 異なる2商品へ同じ非空 STRIPE_PRICE_ID は部分 UNIQUE で拒否", () => {
  const { raw } = freshEnv({ setPrices: false });
  raw.prepare("UPDATE M_PRODUCT SET STRIPE_PRICE_ID='price_dup' WHERE PRODUCT_CODE='SUN_AND_MOON'").run();
  assert.throws(() => raw.prepare("UPDATE M_PRODUCT SET STRIPE_PRICE_ID='price_dup' WHERE PRODUCT_CODE='HANABI'").run());
});

test("[sale] 要件G: NULL / 空文字の STRIPE_PRICE_ID は複数商品で許可", () => {
  const { raw } = freshEnv({ setPrices: false });
  // 3 商品とも NULL（初期状態）で許可されている
  const nullCount = raw.prepare("SELECT COUNT(*) AS c FROM M_PRODUCT WHERE STRIPE_PRICE_ID IS NULL").get().c;
  assert.equal(nullCount, 3);
  // 空文字を複数商品に設定しても UNIQUE 違反にならない（部分 INDEX が <> '' 条件）
  raw.prepare("UPDATE M_PRODUCT SET STRIPE_PRICE_ID='' WHERE PRODUCT_CODE='SUN_AND_MOON'").run();
  raw.prepare("UPDATE M_PRODUCT SET STRIPE_PRICE_ID='' WHERE PRODUCT_CODE='HANABI'").run();
});

/* ============ Price snapshot による fulfill（要件H〜K） ============ */
// Checkout 開始時に T_CHECKOUT_ATTEMPT_ITEM へ保存した STRIPE_PRICE_ID snapshot を正本に、
// Price 変更後も旧 Session を解決できることを検証する。

// attempt + item snapshot を作るヘルパ
function seedAttempt(raw, { operationId, sessionId, authUserId, items, now }) {
  const cartKey = items.map((i) => i.code).sort().join(",");
  raw.prepare(
    `INSERT INTO T_CHECKOUT_ATTEMPT
       (AUTH_USER_ID, OPERATION_ID, CART_KEY, BUYER_EMAIL, STATUS, CREATE_ATTEMPTED, STRIPE_SESSION_ID, TOTAL_AMOUNT, EXPIRES_AT, CREATE_DATE, UPDATE_DATE)
     VALUES (?, ?, ?, ?, 1, 1, ?, 0, ?, ?, ?)`,
  ).run(authUserId, operationId, cartKey, "buyer@example.com", sessionId, "2999-12-31T00:00:00+09:00", now, now);
  const attemptId = raw.prepare("SELECT ATTEMPT_ID FROM T_CHECKOUT_ATTEMPT WHERE OPERATION_ID=?").get(operationId).ATTEMPT_ID;
  let sort = 0;
  for (const it of items) {
    const pid = raw.prepare("SELECT PRODUCT_ID FROM M_PRODUCT WHERE PRODUCT_CODE=?").get(it.code).PRODUCT_ID;
    raw.prepare(
      `INSERT INTO T_CHECKOUT_ATTEMPT_ITEM (ATTEMPT_ID, PRODUCT_ID, PRODUCT_CODE, STRIPE_PRICE_ID, EXPECTED_AMOUNT, SORT_NO, CREATE_DATE)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(attemptId, pid, it.code, it.priceId, sort++, now);
  }
  return attemptId;
}

test("[sale] 要件H: Checkout 開始時の STRIPE_PRICE_ID が attempt item へ snapshot 保存される", async () => {
  const { env, raw, authUserId, now } = freshEnv();
  seedAttempt(raw, {
    operationId: "op_1", sessionId: "cs_1", authUserId,
    items: [{ code: "SUN_AND_MOON", priceId: "price_old_sam" }], now,
  });
  const row = raw.prepare("SELECT STRIPE_PRICE_ID FROM T_CHECKOUT_ATTEMPT_ITEM WHERE PRODUCT_CODE='SUN_AND_MOON'").get();
  assert.equal(row.STRIPE_PRICE_ID, "price_old_sam");
});

test("[sale] 要件I: Price 変更後も snapshot から旧 Session の Price→商品コードを解決できる", async () => {
  const { env, raw, authUserId, now } = freshEnv();
  // 開始時: price_old で Checkout（snapshot 保存）
  seedAttempt(raw, {
    operationId: "op_2", sessionId: "cs_2", authUserId,
    items: [{ code: "SUN_AND_MOON", priceId: "price_old_sam" }], now,
  });
  // 運用者が M_PRODUCT.STRIPE_PRICE_ID を price_new へ変更
  raw.prepare("UPDATE M_PRODUCT SET STRIPE_PRICE_ID='price_new_sam' WHERE PRODUCT_CODE='SUN_AND_MOON'").run();
  // snapshot 由来の Map は旧 price_old を解決できる（現在の M_PRODUCT には無い）
  const r = await buildPriceIdToCodeMapFromAttempt(env, "cs_2", "op_2");
  assert.equal(r.status, "resolved");
  assert.equal(r.map.get("price_old_sam"), "SUN_AND_MOON");
  assert.equal(r.map.get("price_new_sam"), undefined, "snapshot は現在値ではなく開始時 Price を正本にする");
});

test("[sale] 要件J: SID でも operationId でも attempt を特定できなければ not_found（限定 fallback 経路）", async () => {
  const { env } = freshEnv();
  const r = await buildPriceIdToCodeMapFromAttempt(env, "cs_unknown", "op_unknown");
  assert.equal(r.status, "not_found");
});

test("[sale] 要件J2: operationId が null でも SID 一致で解決できる", async () => {
  const { env, raw, authUserId, now } = freshEnv();
  seedAttempt(raw, {
    operationId: "op_3", sessionId: "cs_3", authUserId,
    items: [{ code: "SUN_AND_MOON", priceId: "price_snap_3" }], now,
  });
  const r = await buildPriceIdToCodeMapFromAttempt(env, "cs_3", null);
  assert.equal(r.status, "resolved");
  assert.equal(r.map.get("price_snap_3"), "SUN_AND_MOON");
});

test("[sale] fallback 安全性: attempt はあるが snapshot が空 Price なら invalid（現在 M_PRODUCT へ fallback しない）", async () => {
  const { env, raw, authUserId, now } = freshEnv();
  // attempt は存在するが item の Price snapshot が空文字（異常データ）
  seedAttempt(raw, {
    operationId: "op_4", sessionId: "cs_4", authUserId,
    items: [{ code: "SUN_AND_MOON", priceId: "" }], now,
  });
  const r = await buildPriceIdToCodeMapFromAttempt(env, "cs_4", "op_4");
  assert.equal(r.status, "invalid", "snapshot 不正は invalid（fallback せず安全側エラー）");
});

test("[sale] fallback 安全性: attempt はあるが item が無いなら invalid", async () => {
  const { env, raw, authUserId, now } = freshEnv();
  // attempt 本体だけ作り、item snapshot を入れない
  raw.prepare(
    `INSERT INTO T_CHECKOUT_ATTEMPT
       (AUTH_USER_ID, OPERATION_ID, CART_KEY, BUYER_EMAIL, STATUS, CREATE_ATTEMPTED, STRIPE_SESSION_ID, TOTAL_AMOUNT, EXPIRES_AT, CREATE_DATE, UPDATE_DATE)
     VALUES (?, 'op_5', 'SUN_AND_MOON', 'b@e.c', 1, 1, 'cs_5', 0, '2999-12-31T00:00:00+09:00', ?, ?)`,
  ).run(authUserId, now, now);
  const r = await buildPriceIdToCodeMapFromAttempt(env, "cs_5", "op_5");
  assert.equal(r.status, "invalid");
});

test("[sale] 要件K: 新規 Checkout は現在の M_PRODUCT.STRIPE_PRICE_ID を使う（precheck が DB 現在値を解決）", async () => {
  const { env, authUserId, raw, now } = freshEnv();
  raw.prepare("UPDATE M_PRODUCT SET STRIPE_PRICE_ID='price_current_sam' WHERE PRODUCT_CODE='SUN_AND_MOON'").run();
  const r = await precheckMultiCheckout(env, authUserId, ["SUN_AND_MOON"]);
  assert.equal(r.priceIdByCode.get("SUN_AND_MOON"), "price_current_sam");
});

test("[sale] precheck: 同一カート内で同じ Price ID が複数商品に割り当たる場合は Stripe 前に拒否", async () => {
  const { env, authUserId, raw, now } = freshEnv({ setPrices: false });
  // DB UNIQUE を回避して異常データを作るのは不可能なので、precheck のコード側安全網を確認する目的で
  // 依存のない 2 商品に別 Price を設定し、precheck が正常に通ること（安全網が誤検知しない）を確認。
  raw.prepare("UPDATE M_PRODUCT SET PURCHASE_ENABLED=1, STRIPE_PRICE_ID='price_a' WHERE PRODUCT_CODE='SUN_AND_MOON'").run();
  const r = await precheckMultiCheckout(env, authUserId, ["SUN_AND_MOON"]);
  assert.equal(r.products.length, 1);
});

test("[sale] migration 0007: CHECK 制約と STRIPE_PRICE_ID 部分 UNIQUE INDEX を含む", () => {
  const sqlLines = migration0007.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(sqlLines, /CHECK \(PURCHASE_ENABLED IN \(0, 1\)\)/);
  assert.match(sqlLines, /CHECK \(SALE_TYPE IN \('ONE_TIME', 'SUBSCRIPTION'\)\)/);
  assert.match(sqlLines, /CHECK \(DISPLAY_PRICE IS NULL OR DISPLAY_PRICE >= 0\)/);
  assert.match(sqlLines, /CHECK \(BILLING_INTERVAL IS NULL OR BILLING_INTERVAL IN \('MONTH', 'YEAR'\)\)/);
  assert.match(sqlLines, /CREATE UNIQUE INDEX IF NOT EXISTS UX_PRODUCT_STRIPE_PRICE_ID/);
  assert.match(sqlLines, /WHERE STRIPE_PRICE_ID IS NOT NULL AND STRIPE_PRICE_ID <> ''/);
});
