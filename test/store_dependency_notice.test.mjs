/**
 * Store カード依存案内の M_PRODUCT_DEPENDENCY 正本一本化テスト
 *
 * サーバー（getAllProductDependencyGroups = /api/products の dependencies）から
 * フロント（site.js の dependencyNotice / productName）までを繋ぎ、
 * 「M_PRODUCT + M_PRODUCT_DEPENDENCY の登録だけで Store カードの依存案内が成立する」ことを検証する。
 *
 * 必須検証（指示）:
 * - 新商品追加時、DB 登録だけで Store カード依存案内が成立（site-config 修正不要）
 * - ANY_OF なら「A または B のいずれか が必要」
 * - PRODUCT_NAME を使用し、商品コードをユーザー向け表示へ出さない
 * - PRODUCT_NAME / 依存情報が取れない場合は依存案内を出さない（コード非露出）
 * - site-config の dependsOn 参照が 0 件（固定依存の残骸なし）
 *
 * フロントの dependencyNotice / productName は site.js の実コードから抽出して評価する
 * （テスト用にロジックを複製せず、実装のドリフトを防ぐ）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { getAllProductDependencyGroups } from "./_bundle/purchase_logic.mjs";

/* ---- site.js から productName + dependencyNotice を抽出して評価する ---- */
function loadFrontNoticeFns(saleInfoByCode) {
  const src = readFileSync("public/assets/site.js", "utf8");
  function extract(name) {
    const start = src.indexOf("function " + name + "(");
    if (start < 0) throw new Error("not found: " + name);
    let i = src.indexOf("{", start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced braces: " + name);
  }
  const factory = new Function(
    "saleInfoByCode",
    extract("productName") + "\n" + extract("dependencyNotice") +
      "\n return { productName: productName, dependencyNotice: dependencyNotice };",
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

function freshEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync("migrations/" + f, "utf8"));
  return { env: { DB: new D1Adapter(db) }, raw: db };
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
function saleInfoFromDb(raw, depsByCode) {
  const rows = raw.prepare("SELECT PRODUCT_CODE AS code, PRODUCT_NAME AS name FROM M_PRODUCT").all();
  const map = {};
  for (const r of rows) map[r.code] = { name: r.name, dependencies: depsByCode[r.code] || [] };
  return map;
}

test("[store-dep] EARTH の依存案内が M_PRODUCT_DEPENDENCY 正本で成立（PRODUCT_NAME 使用）", async () => {
  const { env, raw } = freshEnv();
  const deps = await getAllProductDependencyGroups(env);
  // 初期データ: HANABI_GOOGLE_EARTH → HANABI（ENTITLEMENT_OR_CART）
  assert.ok(deps["HANABI_GOOGLE_EARTH"], "EARTH に依存グループがある");
  const sale = saleInfoFromDb(raw, deps);
  const { dependencyNotice } = loadFrontNoticeFns(sale);
  const notice = dependencyNotice(deps["HANABI_GOOGLE_EARTH"]);
  assert.match(notice, /ご購入には HANABI PLANNERが必要です/);
});

test("[store-dep] 将来商品 3D_PREVIEW → HANABI OR SUN_AND_MOON の ANY_OF が DB 登録だけで案内成立", async () => {
  const { env, raw } = freshEnv();
  addProduct(raw, 90, "3D_PREVIEW", "3D PREVIEW");
  addDep(raw, "3D_PREVIEW", "HANABI", 0, "ENTITLEMENT_ONLY");
  addDep(raw, "3D_PREVIEW", "SUN_AND_MOON", 0, "ENTITLEMENT_ONLY");
  const deps = await getAllProductDependencyGroups(env);
  assert.equal(deps["3D_PREVIEW"].length, 1, "同一グループ ANY_OF");
  assert.deepEqual(deps["3D_PREVIEW"][0].requiresAnyOf, ["HANABI", "SUN_AND_MOON"]);
  const sale = saleInfoFromDb(raw, deps);
  const { dependencyNotice } = loadFrontNoticeFns(sale);
  const notice = dependencyNotice(deps["3D_PREVIEW"]);
  // ANY_OF: 「A または B のいずれかが必要」
  assert.match(notice, /ご購入には HANABI PLANNER または SUN AND MOON PLANNER のいずれかが必要です/);
});

test("[store-dep] 全く新しい商品 Z→W を DB 登録しただけで Store 依存案内が成立（コード改修不要）", async () => {
  const { env, raw } = freshEnv();
  addProduct(raw, 95, "Z", "商品Z");
  addProduct(raw, 96, "W", "商品W");
  addDep(raw, "Z", "W", 0, "ENTITLEMENT_OR_CART");
  const deps = await getAllProductDependencyGroups(env);
  const sale = saleInfoFromDb(raw, deps);
  const { dependencyNotice } = loadFrontNoticeFns(sale);
  const notice = dependencyNotice(deps["Z"]);
  assert.match(notice, /ご購入には 商品Wが必要です/);
});

test("[store-dep] 複数グループ ALL_OF の依存案内", async () => {
  const { env, raw } = freshEnv();
  addProduct(raw, 90, "X", "商品X");
  addProduct(raw, 91, "A", "商品A");
  addProduct(raw, 92, "B", "商品B");
  addProduct(raw, 93, "C", "商品C");
  addDep(raw, "X", "A", 0, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "B", 0, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "C", 1, "ENTITLEMENT_OR_CART");
  const deps = await getAllProductDependencyGroups(env);
  assert.equal(deps["X"].length, 2, "2 グループ ALL_OF");
  const sale = saleInfoFromDb(raw, deps);
  const { dependencyNotice } = loadFrontNoticeFns(sale);
  const notice = dependencyNotice(deps["X"]);
  assert.match(notice, /商品A または 商品B のいずれか、および商品Cが必要です/);
});

test("[store-dep] 依存なし商品は依存案内を出さない（空文字）", async () => {
  const { env, raw } = freshEnv();
  const deps = await getAllProductDependencyGroups(env);
  const sale = saleInfoFromDb(raw, deps);
  const { dependencyNotice } = loadFrontNoticeFns(sale);
  // HANABI は依存なし
  assert.equal(dependencyNotice(deps["HANABI"] || []), "");
});

test("[store-dep] PRODUCT_NAME 欠落時は依存案内を出さず商品コードを露出しない", async () => {
  const { env, raw } = freshEnv();
  const deps = await getAllProductDependencyGroups(env);
  // saleInfoByCode を空にして名前を取れなくする
  const { dependencyNotice } = loadFrontNoticeFns({});
  const notice = dependencyNotice(deps["HANABI_GOOGLE_EARTH"]);
  assert.equal(notice, "", "名前が取れなければ依存案内を出さない");
  assert.doesNotMatch(notice, /HANABI/);
  assert.doesNotMatch(notice, /SUN_AND_MOON/);
});

test("[store-dep] site-config の dependsOn 参照が 0 件（固定依存の残骸なし）", () => {
  const siteJs = readFileSync("public/assets/site.js", "utf8");
  const siteConfig = readFileSync("public/assets/site-config.js", "utf8");
  // コード参照（meta.dependsOn / .dependsOn を読む / dependsOn: 定義）が無いこと。
  // コメント（// … dependsOn … 説明）は許容する。
  const codeRefRe = /(meta\.dependsOn|CFG\.products\[[^\]]*dependsOn|dependsOn\s*:)/;
  assert.doesNotMatch(siteJs, codeRefRe, "site.js に dependsOn のコード参照がない");
  assert.doesNotMatch(siteConfig, /dependsOn\s*:/, "site-config.js に dependsOn 定義がない");
});

test("[store-dep] Store カードは M_PRODUCT_DEPENDENCY を正本にする（getAllProductDependencyGroups が /api/products 経由で配信）", () => {
  // products.ts が dependencies を /api/products に載せていること（正本一本化の担保）。
  const productsTs = readFileSync("src/routes/products.ts", "utf8");
  assert.match(productsTs, /getAllProductDependencyGroups/);
  assert.match(productsTs, /dependencies/);
});

test("[store-dep] グループ表示順が決定的（DEPENDENCY_GROUP 昇順・同一マスタなら同一文言順）", async () => {
  // 複数グループ・複数候補を、DB へ挿入順を入れ替えても常に同じ順序で返す。
  const { env, raw } = freshEnv();
  addProduct(raw, 90, "X", "商品X");
  addProduct(raw, 91, "A", "商品A");
  addProduct(raw, 92, "B", "商品B");
  addProduct(raw, 93, "C", "商品C");
  addProduct(raw, 94, "D", "商品D");
  // わざと group1 を先に、group0 の候補も B→A の逆順で挿入する。
  addDep(raw, "X", "D", 1, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "C", 1, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "B", 0, "ENTITLEMENT_OR_CART");
  addDep(raw, "X", "A", 0, "ENTITLEMENT_OR_CART");

  const deps = await getAllProductDependencyGroups(env);
  // グループは DEPENDENCY_GROUP 昇順（group0 が先）、候補は決定的（sort）で C/D も昇順
  assert.equal(deps["X"].length, 2);
  assert.deepEqual(deps["X"][0].requiresAnyOf, ["A", "B"]); // group0
  assert.deepEqual(deps["X"][1].requiresAnyOf, ["C", "D"]); // group1

  const sale = saleInfoFromDb(raw, deps);
  const { dependencyNotice } = loadFrontNoticeFns(sale);
  const notice = dependencyNotice(deps["X"]);
  // group0(A/B) が先、group1(C/D) が後で決定的に並ぶ
  assert.equal(
    notice,
    "ご購入には 商品A または 商品B のいずれか、および商品C または 商品D のいずれかが必要です。",
  );
});

test("[store-dep] 挿入順を変えても同じ文言（決定性の再現）", async () => {
  // 別インスタンスで、逆順に挿入しても同じ deps 順・同じ文言になる。
  function buildAndNotice(insertOrder) {
    const { env, raw } = freshEnv();
    addProduct(raw, 90, "X", "商品X");
    addProduct(raw, 91, "A", "商品A");
    addProduct(raw, 92, "B", "商品B");
    addProduct(raw, 93, "C", "商品C");
    for (const [req, grp] of insertOrder) addDep(raw, "X", req, grp, "ENTITLEMENT_OR_CART");
    return { env, raw };
  }
  const order1 = [["A", 0], ["B", 0], ["C", 1]];
  const order2 = [["C", 1], ["B", 0], ["A", 0]];
  const r1 = buildAndNotice(order1);
  const r2 = buildAndNotice(order2);
  const d1 = await getAllProductDependencyGroups(r1.env);
  const d2 = await getAllProductDependencyGroups(r2.env);
  assert.deepEqual(d1["X"], d2["X"], "挿入順に依存せず同じグループ構造");
  const n1 = loadFrontNoticeFns(saleInfoFromDb(r1.raw, d1)).dependencyNotice(d1["X"]);
  const n2 = loadFrontNoticeFns(saleInfoFromDb(r2.raw, d2)).dependencyNotice(d2["X"]);
  assert.equal(n1, n2, "挿入順に依存せず同じ文言");
});
