/**
 * 依存エラー文言生成の E2E テスト
 *
 * サーバー（checkProductDependencies が投げる DependencyRequiredError.details）から
 * フロント（site.js の dependencyMessage）までを繋ぎ、
 * 「M_PRODUCT + M_PRODUCT_DEPENDENCY の登録だけで、ユーザー向け依存案内が成立する」ことを検証する。
 *
 * 必須検証（指示）:
 * 1. EARTH → HANABI 単一依存の表示
 * 2. 3D_PREVIEW → HANABI OR SUN_AND_MOON の ANY_OF 表示
 * 3. ENTITLEMENT_ONLY では「事前購入が必要」と分かる表示
 * 4. 複数グループ ALL_OF の表示
 * 5. 商品コードをそのままユーザー向け文言へ出していないこと
 *
 * フロントの dependencyMessage / productName は site.js の実コードから抽出して評価する
 * （テスト用にロジックを複製せず、実装のドリフトを防ぐ）。商品名は PRODUCT_NAME を注入する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { checkProductDependencies } from "./_bundle/purchase_logic.mjs";

/* ---- site.js から productName + dependencyMessage を抽出して評価する ---- */
// saleInfoByCode（商品名 lookup）を注入し、site.js の実関数を復元する。
function loadFrontMessageFns(saleInfoByCode) {
  const src = readFileSync("public/assets/site.js", "utf8");
  function extract(name) {
    const start = src.indexOf("function " + name + "(");
    if (start < 0) throw new Error("not found: " + name);
    // 対応する閉じ括弧まで brace 数で切り出す。
    let i = src.indexOf("{", start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced braces: " + name);
  }
  const productNameSrc = extract("productName");
  const dependencyMessageSrc = extract("dependencyMessage");
  // saleInfoByCode をクロージャに閉じ込めて両関数を復元する。
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "saleInfoByCode",
    productNameSrc + "\n" + dependencyMessageSrc + "\n return { productName: productName, dependencyMessage: dependencyMessage };",
  );
  return factory(saleInfoByCode);
}

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
  db.prepare(
    `INSERT INTO M_USER (AUTH_USER_ID, LOGIN_MAIL, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
     VALUES (?, ?, 1, 0, ?, ?)`,
  ).run("user-1", "user-1@example.com", NOW, NOW);
  return { env: { DB: new D1Adapter(db) }, raw: db };
}
function pid(raw, code) { return raw.prepare("SELECT PRODUCT_ID FROM M_PRODUCT WHERE PRODUCT_CODE=?").get(code).PRODUCT_ID; }
function grant(raw, code) {
  raw.prepare(
    `INSERT INTO T_USER_PRODUCT (AUTH_USER_ID, PRODUCT_ID, STATUS, START_DATE, END_DATE, GRANT_TYPE, DEL_FLG, CREATE_DATE, UPDATE_DATE)
     VALUES ('user-1', ?, 1, ?, ?, 0, 0, ?, ?)`,
  ).run(pid(raw, code), NOW, FOREVER, NOW, NOW);
}
function addProduct(raw, id, code, name) {
  raw.prepare(
    `INSERT INTO M_PRODUCT (PRODUCT_ID, PRODUCT_CODE, PRODUCT_NAME, STATUS, SORT_NO, DEL_FLG, CREATE_DATE, UPDATE_DATE,
       PURCHASE_ENABLED, SALE_TYPE, DISPLAY_PRICE, BILLING_INTERVAL, STRIPE_PRICE_ID)
     VALUES (?, ?, ?, 1, ?, 0, ?, ?, 1, 'ONE_TIME', 500, NULL, NULL)`,
  ).run(id, code, name, id, NOW, NOW);
}
function addDep(raw, code, requires, group, mode) {
  raw.prepare(
    `INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE, REQUIRES_CODE, DEPENDENCY_GROUP, SATISFY_MODE, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
  ).run(code, requires, group, mode, NOW, NOW);
}

// 実 DB の PRODUCT_NAME を saleInfoByCode（フロントの /api/products 相当）に写す。
function saleInfoFromDb(raw) {
  const rows = raw.prepare("SELECT PRODUCT_CODE AS code, PRODUCT_NAME AS name FROM M_PRODUCT").all();
  const map = {};
  for (const r of rows) map[r.code] = { name: r.name };
  return map;
}

// checkProductDependencies を実行し、投げられた DependencyRequiredError.details を返す。
async function getDetails(env, codes) {
  try {
    await checkProductDependencies(env, "user-1", codes);
    return null; // 依存 OK
  } catch (e) {
    if (e && e.code === "DEPENDENCY_REQUIRED") return e.details;
    throw e;
  }
}

test("[dep-msg] 要件1: EARTH → HANABI 単一依存の表示（PRODUCT_NAME 使用）", async () => {
  const { env, raw } = freshEnv();
  const details = await getDetails(env, ["HANABI_GOOGLE_EARTH"]);
  assert.ok(details, "DEPENDENCY_REQUIRED の details");
  const { dependencyMessage } = loadFrontMessageFns(saleInfoFromDb(raw));
  const msg = dependencyMessage(details);
  // 実 PRODUCT_NAME: 「HANABI PLANNER Google Earth追加機能」「HANABI PLANNER」
  assert.match(msg, /HANABI PLANNER Google Earth追加機能を購入するには/);
  assert.match(msg, /HANABI PLANNER/);
  // EARTH→HANABI は ENTITLEMENT_OR_CART なので「一緒に選択」案内が出る
  assert.match(msg, /一緒に選択/);
});

test("[dep-msg] 要件2: 3D_PREVIEW → HANABI OR SUN_AND_MOON の ANY_OF 表示", async () => {
  const { env, raw } = freshEnv();
  addProduct(raw, 90, "3D_PREVIEW", "3D PREVIEW");
  addDep(raw, "3D_PREVIEW", "HANABI", 0, "ENTITLEMENT_ONLY");
  addDep(raw, "3D_PREVIEW", "SUN_AND_MOON", 0, "ENTITLEMENT_ONLY");
  const details = await getDetails(env, ["3D_PREVIEW"]);
  assert.ok(details);
  const { dependencyMessage } = loadFrontMessageFns(saleInfoFromDb(raw));
  const msg = dependencyMessage(details);
  assert.match(msg, /3D PREVIEWを購入するには/);
  // ANY_OF: 「A または B のいずれか」
  assert.match(msg, /HANABI PLANNER または SUN AND MOON PLANNER のいずれか/);
});

test("[dep-msg] 要件3: ENTITLEMENT_ONLY は「事前に購入している必要があります」と表示（同時カート誤解なし）", async () => {
  const { env, raw } = freshEnv();
  addProduct(raw, 90, "3D_PREVIEW", "3D PREVIEW");
  addDep(raw, "3D_PREVIEW", "HANABI", 0, "ENTITLEMENT_ONLY");
  addDep(raw, "3D_PREVIEW", "SUN_AND_MOON", 0, "ENTITLEMENT_ONLY");
  const details = await getDetails(env, ["3D_PREVIEW"]);
  const { dependencyMessage } = loadFrontMessageFns(saleInfoFromDb(raw));
  const msg = dependencyMessage(details);
  assert.match(msg, /事前に購入している必要があります/);
  // 「一緒に選択」等の同時カートで充足できる誤解を与える表現を出さない
  assert.doesNotMatch(msg, /一緒に選択/);
});

test("[dep-msg] 要件4: 複数グループ ALL_OF の表示（各グループ条件が分かる）", async () => {
  const { env, raw } = freshEnv();
  // 商品X: グループ0=(A OR B) ENTITLEMENT_OR_CART, グループ1=C ENTITLEMENT_OR_CART
  addProduct(raw, 90, "X", "商品X");
  addProduct(raw, 91, "A", "商品A");
  addProduct(raw, 92, "B", "商品B");
  addProduct(raw, 93, "C", "商品C");
  addDep(raw, "X", "A", 0, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "B", 0, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "C", 1, "ENTITLEMENT_OR_CART");
  const details = await getDetails(env, ["X"]);
  assert.ok(details);
  assert.equal(details.missingGroups.length, 2, "2 グループ（ALL_OF）");
  const { dependencyMessage } = loadFrontMessageFns(saleInfoFromDb(raw));
  const msg = dependencyMessage(details);
  // 「A または B のいずれか、および 商品C」の形
  assert.match(msg, /商品A または 商品B のいずれか/);
  assert.match(msg, /および商品C/);
});

test("[dep-msg] 要件5: 商品コードをそのままユーザー向け文言へ出していない", async () => {
  const { env, raw } = freshEnv();
  addProduct(raw, 90, "3D_PREVIEW", "3D PREVIEW");
  addDep(raw, "3D_PREVIEW", "HANABI", 0, "ENTITLEMENT_ONLY");
  addDep(raw, "3D_PREVIEW", "SUN_AND_MOON", 0, "ENTITLEMENT_ONLY");
  const details = await getDetails(env, ["3D_PREVIEW"]);
  const { dependencyMessage } = loadFrontMessageFns(saleInfoFromDb(raw));
  const msg = dependencyMessage(details);
  // 生の商品コードは出さない（PRODUCT_NAME へ変換済み）
  assert.doesNotMatch(msg, /HANABI_GOOGLE_EARTH/);
  assert.doesNotMatch(msg, /SUN_AND_MOON/);
  assert.doesNotMatch(msg, /3D_PREVIEW/);
  assert.doesNotMatch(msg, /\bHANABI\b(?! PLANNER)/); // "HANABI" コード単体は出さない（"HANABI PLANNER" はOK）
});

test("[dep-msg] 将来商品追加: M_PRODUCT + M_PRODUCT_DEPENDENCY の登録だけで案内が成立（コード改修不要）", async () => {
  const { env, raw } = freshEnv();
  // 全く新しい商品 Z が W を必須にする依存を、DB 登録だけで追加。
  addProduct(raw, 95, "Z", "商品Z");
  addProduct(raw, 96, "W", "商品W");
  addDep(raw, "Z", "W", 0, "ENTITLEMENT_OR_CART");
  const details = await getDetails(env, ["Z"]);
  assert.ok(details, "新商品でも DEPENDENCY_REQUIRED を返す");
  const { dependencyMessage } = loadFrontMessageFns(saleInfoFromDb(raw));
  const msg = dependencyMessage(details);
  // フロント・サーバーとも商品固有ハードコードなしで、新商品の案内が PRODUCT_NAME で成立する
  assert.match(msg, /商品Zを購入するには/);
  assert.match(msg, /商品W/);
});

test("[dep-msg] 補正1: 混在 SATISFY_MODE の ALL_OF（OR_CART グループと ONLY グループを個別表現）", async () => {
  const { env, raw } = freshEnv();
  // 商品X: group0=(A OR B) ENTITLEMENT_OR_CART, group1=C ENTITLEMENT_ONLY
  addProduct(raw, 90, "X", "商品X");
  addProduct(raw, 91, "A", "商品A");
  addProduct(raw, 92, "B", "商品B");
  addProduct(raw, 93, "C", "商品C");
  addDep(raw, "X", "A", 0, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "B", 0, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "C", 1, "ENTITLEMENT_ONLY");
  const details = await getDetails(env, ["X"]);
  assert.ok(details);
  assert.equal(details.missingGroups.length, 2);
  // details にグループ別 satisfyMode が保持されている
  const modesByFirstReq = {};
  details.missingGroups.forEach((g) => { modesByFirstReq[g.requiresAnyOf[0]] = g.satisfyMode; });
  assert.equal(modesByFirstReq["A"], "ENTITLEMENT_OR_CART");
  assert.equal(modesByFirstReq["C"], "ENTITLEMENT_ONLY");

  const { dependencyMessage } = loadFrontMessageFns(saleInfoFromDb(raw));
  const msg = dependencyMessage(details);
  // OR_CART グループ（A/B）は「一緒に選択」案内、ONLY グループ（C）は「事前に購入している必要があります」を個別に表現
  assert.match(msg, /商品A または 商品B のいずれかが必要です/);
  assert.match(msg, /一緒に選択/);
  assert.match(msg, /商品Cを事前に購入している必要があります/);
  // ONLY グループを「同時選択でよい」と誤解させないこと（C を一緒に選択と言わない）
  assert.doesNotMatch(msg, /商品C[^。]*一緒に選択/);
});

test("[dep-msg] 補正1b: 混在 ALL_OF で ONLY グループが複数でも個別表現される", async () => {
  const { env, raw } = freshEnv();
  addProduct(raw, 90, "X", "商品X");
  addProduct(raw, 91, "A", "商品A");
  addProduct(raw, 92, "C", "商品C");
  addProduct(raw, 93, "D", "商品D");
  addDep(raw, "X", "A", 0, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "C", 1, "ENTITLEMENT_ONLY");
  addDep(raw, "X", "D", 2, "ENTITLEMENT_ONLY");
  const details = await getDetails(env, ["X"]);
  const { dependencyMessage } = loadFrontMessageFns(saleInfoFromDb(raw));
  const msg = dependencyMessage(details);
  assert.match(msg, /商品Aが必要です/);
  // ONLY 2グループは「C、およびD を事前に購入している必要があります」
  assert.match(msg, /商品C、および商品Dを事前に購入している必要があります/);
});

test("[dep-msg] 補正2: PRODUCT_NAME 欠落時は商品コードを露出させず汎用文言へフォールバック", async () => {
  const { env, raw } = freshEnv();
  const details = await getDetails(env, ["HANABI_GOOGLE_EARTH"]);
  assert.ok(details);
  // saleInfoByCode を空にする（/api/products 未取得・DB 名欠落を模す）
  const { dependencyMessage } = loadFrontMessageFns({});
  const msg = dependencyMessage(details);
  // 汎用文言へフォールバック
  assert.equal(msg, "この商品を購入するには、前提となる商品が必要です。選び直してください。");
  // 商品コードが露出しない
  assert.doesNotMatch(msg, /HANABI_GOOGLE_EARTH/);
  assert.doesNotMatch(msg, /HANABI/);
  assert.doesNotMatch(msg, /SUN_AND_MOON/);
  assert.doesNotMatch(msg, /3D_PREVIEW/);
});

test("[dep-msg] 補正2b: 前提商品の一部のみ PRODUCT_NAME 欠落でもコードを露出させない", async () => {
  const { env, raw } = freshEnv();
  addProduct(raw, 90, "3D_PREVIEW", "3D PREVIEW");
  addDep(raw, "3D_PREVIEW", "HANABI", 0, "ENTITLEMENT_ONLY");
  addDep(raw, "3D_PREVIEW", "SUN_AND_MOON", 0, "ENTITLEMENT_ONLY");
  const details = await getDetails(env, ["3D_PREVIEW"]);
  // 対象商品名はあるが、前提候補 SUN_AND_MOON の名前だけ欠落させる
  const partial = { "3D_PREVIEW": { name: "3D PREVIEW" }, "HANABI": { name: "HANABI PLANNER" } };
  const { dependencyMessage } = loadFrontMessageFns(partial);
  const msg = dependencyMessage(details);
  // 候補名が1つでも欠ければ汎用へ（コード露出を避ける）
  assert.equal(msg, "この商品を購入するには、前提となる商品が必要です。選び直してください。");
  assert.doesNotMatch(msg, /SUN_AND_MOON/);
  assert.doesNotMatch(msg, /HANABI(?! PLANNER)/);
});

test("[dep-msg] 補正2c: 任意の商品コードが PRODUCT_NAME 欠落時にユーザー向け文言へ出ない", async () => {
  const { env, raw } = freshEnv();
  addProduct(raw, 95, "FOO_BAR_PRODUCT", "任意商品");
  addProduct(raw, 96, "BAZ_REQUIRED", "前提任意商品");
  addDep(raw, "FOO_BAR_PRODUCT", "BAZ_REQUIRED", 0, "ENTITLEMENT_OR_CART");
  const details = await getDetails(env, ["FOO_BAR_PRODUCT"]);
  const { dependencyMessage } = loadFrontMessageFns({}); // 名前ゼロ
  const msg = dependencyMessage(details);
  assert.doesNotMatch(msg, /FOO_BAR_PRODUCT/);
  assert.doesNotMatch(msg, /BAZ_REQUIRED/);
});
