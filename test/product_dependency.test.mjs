// 商品購入依存関係の DB 化テスト（migration 0008・M_PRODUCT_DEPENDENCY）。
//
// 依存判定の正本は M_PRODUCT_DEPENDENCY（旧コード固定 PRODUCT_DEPENDENCIES は廃止）。
// 検証項目:
//   - 現行仕様の維持: HANABI_GOOGLE_EARTH は HANABI を必須（前提なしは DEPENDENCY_REQUIRED）
//   - 同一注文に前提を含めば購入可（同時購入）
//   - 有効 entitlement を所有していれば購入可
//   - 所有の正本は有効 T_USER_PRODUCT entitlement（GRANT_TYPE を問わない＝Admin 直接付与も所有扱い）
//       ★「購入履歴なし・Admin 直接付与 HANABI あり → EARTH 購入可能」
//   - 無効な entitlement（STATUS≠1 / 期限切れ / DEL_FLG=1）は所有とみなさない
//   - DB に依存定義が無い商品は依存なし（通過）
//   - ANY_OF: 同一グループに複数前提 → いずれか所有で充足
//   - ALL_OF: 別グループの前提 → すべて充足が必要
//   - 存在しない/無効な前提商品は充足せず安全側で購入不可
//   - 既存 entitlement の利用可否（isProductAvailable）には依存関係を混入させない
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  checkProductDependencies,
  isProductAvailable,
  assertNoDependencyCycle,
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
const NOW = "2026-08-09T00:00:00+09:00";
const FUTURE = "2999-12-31T00:00:00+09:00";
const PAST = "2000-01-01T00:00:00+09:00";

function freshEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync("migrations/" + f, "utf8"));
  // 販売可能にしておく（依存とは別軸だが precheck 相当の isProductAvailable が M_PRODUCT 有効性を見るため）
  db.prepare("INSERT INTO M_USER (AUTH_USER_ID,LOGIN_MAIL,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES ('u1','a@b.c',1,0,?,?)").run(NOW, NOW);
  const pid = Object.fromEntries(
    db.prepare("SELECT PRODUCT_ID, PRODUCT_CODE FROM M_PRODUCT").all().map((r) => [r.PRODUCT_CODE, r.PRODUCT_ID]),
  );
  return { env: { DB: new D1Adapter(db) }, raw: db, authUserId: "u1", pid };
}

// 有効 entitlement を付与するヘルパ（GRANT_TYPE を引数で変えられる）
function grant(raw, authUserId, productId, { grantType = 0, status = 1, start = NOW, end = FUTURE, del = 0 } = {}) {
  raw.prepare(
    `INSERT INTO T_USER_PRODUCT (AUTH_USER_ID,PRODUCT_ID,STATUS,START_DATE,END_DATE,GRANT_TYPE,DEL_FLG,CREATE_DATE,UPDATE_DATE)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(authUserId, productId, status, start, end, grantType, del, NOW, NOW);
}

/* ============ 現行仕様の維持 ============ */

test("[dep] 初期データ: HANABI_GOOGLE_EARTH は HANABI を必須（DB 定義）", () => {
  const { raw } = freshEnv();
  const rows = raw.prepare("SELECT PRODUCT_CODE, REQUIRES_CODE, DEPENDENCY_GROUP FROM M_PRODUCT_DEPENDENCY").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].PRODUCT_CODE, "HANABI_GOOGLE_EARTH");
  assert.equal(rows[0].REQUIRES_CODE, "HANABI");
  assert.equal(rows[0].DEPENDENCY_GROUP, 0);
});

test("[dep] 前提未所有・同時購入なしで EARTH 単独購入は DEPENDENCY_REQUIRED", async () => {
  const { env, authUserId } = freshEnv();
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
});

test("[dep] 同一注文に HANABI を含めば EARTH 購入可（同時購入）", async () => {
  const { env, authUserId } = freshEnv();
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["HANABI", "HANABI_GOOGLE_EARTH"]));
});

test("[dep] HANABI を有効 entitlement で所有していれば EARTH 購入可", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  grant(raw, authUserId, pid.HANABI, { grantType: 0 }); // 購入
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]));
});

test("[dep] 依存のない商品（HANABI 単独）は常に通過", async () => {
  const { env, authUserId } = freshEnv();
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["HANABI"]));
});

/* ============ ★所有の正本は有効 entitlement（GRANT_TYPE 非依存） ============ */

test("[dep] ★購入履歴なし・Admin 直接付与 HANABI（GRANT_TYPE=3）あり → EARTH 購入可能", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  // 購入履歴（T_PURCHASE / T_ORDER）は一切作らない。Admin 直接付与だけを入れる。
  grant(raw, authUserId, pid.HANABI, { grantType: 3 }); // Admin 直接付与相当
  // 購入履歴が無いことを確認
  const purchaseCount = raw.prepare("SELECT COUNT(*) AS c FROM T_PURCHASE").get().c;
  assert.equal(purchaseCount, 0, "購入履歴なしを前提にする");
  // それでも有効 entitlement があるので EARTH の依存を満たす
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]));
});

test("[dep] note 移行付与（GRANT_TYPE=1）でも HANABI 所有として EARTH 購入可", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  grant(raw, authUserId, pid.HANABI, { grantType: 1 });
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]));
});

/* ============ 無効な entitlement は所有とみなさない ============ */

test("[dep] 無効 entitlement（STATUS≠1）の HANABI では EARTH 購入不可", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  grant(raw, authUserId, pid.HANABI, { status: 2 }); // 無効
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
});

test("[dep] 期限切れ entitlement の HANABI では EARTH 購入不可", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  grant(raw, authUserId, pid.HANABI, { start: PAST, end: PAST }); // 期限切れ
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
});

test("[dep] 論理削除 entitlement（DEL_FLG=1）の HANABI では EARTH 購入不可", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  grant(raw, authUserId, pid.HANABI, { del: 1 });
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
});

/* ============ ANY_OF / ALL_OF（将来 3D_PREVIEW 相当の構造検証） ============ */

// 3D_PREVIEW を M_PRODUCT に足し、HANABI OR SUN_AND_MOON の ANY_OF 依存を ENTITLEMENT_ONLY で登録する。
function seed3dPreviewAnyOf(raw) {
  raw.prepare(
    `INSERT INTO M_PRODUCT (PRODUCT_ID, PRODUCT_CODE, PRODUCT_NAME, STATUS, SORT_NO, DEL_FLG, CREATE_DATE, UPDATE_DATE,
       PURCHASE_ENABLED, SALE_TYPE, DISPLAY_PRICE, BILLING_INTERVAL, STRIPE_PRICE_ID)
     VALUES (90, '3D_PREVIEW', '3D プレビュー', 1, 90, 0, ?, ?, 1, 'ONE_TIME', 500, NULL, NULL)`,
  ).run(NOW, NOW);
  // 同一グループ 0 に HANABI と SUN_AND_MOON → ANY_OF。SATISFY_MODE='ENTITLEMENT_ONLY'（既所有必須）。
  for (const req of ["HANABI", "SUN_AND_MOON"]) {
    raw.prepare(
      `INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE, REQUIRES_CODE, DEPENDENCY_GROUP, SATISFY_MODE, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
       VALUES ('3D_PREVIEW', ?, 0, 'ENTITLEMENT_ONLY', 1, 0, ?, ?)`,
    ).run(req, NOW, NOW);
  }
}

test("[dep] ANY_OF: 3D_PREVIEW は HANABI または SUN_AND_MOON のいずれか所有で購入可（HANABI 所有）", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  seed3dPreviewAnyOf(raw);
  grant(raw, authUserId, pid.HANABI, { grantType: 0 });
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["3D_PREVIEW"]));
});

test("[dep] ANY_OF: SUN_AND_MOON 所有でも 3D_PREVIEW 購入可", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  seed3dPreviewAnyOf(raw);
  grant(raw, authUserId, pid.SUN_AND_MOON, { grantType: 0 });
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["3D_PREVIEW"]));
});

test("[dep] ANY_OF: どちらも所有していなければ 3D_PREVIEW 購入不可", async () => {
  const { env, authUserId, raw } = freshEnv();
  seed3dPreviewAnyOf(raw);
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["3D_PREVIEW"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
});

test("[dep] ALL_OF: 別グループの前提はすべて必要（グループ間 AND）", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  // 3D_PREVIEW にグループ 0=HANABI、グループ 1=SUN_AND_MOON（別グループ＝両方必要）
  raw.prepare(
    `INSERT INTO M_PRODUCT (PRODUCT_ID, PRODUCT_CODE, PRODUCT_NAME, STATUS, SORT_NO, DEL_FLG, CREATE_DATE, UPDATE_DATE,
       PURCHASE_ENABLED, SALE_TYPE, DISPLAY_PRICE, BILLING_INTERVAL, STRIPE_PRICE_ID)
     VALUES (91, 'COMBO', 'combo', 1, 91, 0, ?, ?, 1, 'ONE_TIME', 500, NULL, NULL)`,
  ).run(NOW, NOW);
  raw.prepare("INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE,REQUIRES_CODE,DEPENDENCY_GROUP,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES ('COMBO','HANABI',0,1,0,?,?)").run(NOW, NOW);
  raw.prepare("INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE,REQUIRES_CODE,DEPENDENCY_GROUP,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES ('COMBO','SUN_AND_MOON',1,1,0,?,?)").run(NOW, NOW);
  // HANABI だけ所有 → グループ 1（SUN_AND_MOON）が未充足で拒否
  grant(raw, authUserId, pid.HANABI, { grantType: 0 });
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["COMBO"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
  // 両方所有 → 通過
  grant(raw, authUserId, pid.SUN_AND_MOON, { grantType: 0 });
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["COMBO"]));
});

test("[dep] details: ANY_OF 未充足は 1 グループに候補2つ（HANABI/SUN_AND_MOON）を返す", async () => {
  const { env, authUserId, raw } = freshEnv();
  seed3dPreviewAnyOf(raw);
  let caught = null;
  try {
    await checkProductDependencies(env, authUserId, ["3D_PREVIEW"]);
  } catch (e) { caught = e; }
  assert.ok(caught && caught.code === "DEPENDENCY_REQUIRED");
  assert.equal(caught.details.productCode, "3D_PREVIEW");
  assert.equal(caught.details.missingGroups.length, 1, "ANY_OF は 1 グループ");
  assert.deepEqual(caught.details.missingGroups[0].requiresAnyOf, ["HANABI", "SUN_AND_MOON"]);
});

test("[dep] details: ALL_OF 未充足は未充足グループのみ返す（HANABI 所有時は SUN_AND_MOON グループのみ）", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  raw.prepare(
    `INSERT INTO M_PRODUCT (PRODUCT_ID, PRODUCT_CODE, PRODUCT_NAME, STATUS, SORT_NO, DEL_FLG, CREATE_DATE, UPDATE_DATE,
       PURCHASE_ENABLED, SALE_TYPE, DISPLAY_PRICE, BILLING_INTERVAL, STRIPE_PRICE_ID)
     VALUES (92, 'COMBO2', 'combo2', 1, 92, 0, ?, ?, 1, 'ONE_TIME', 500, NULL, NULL)`,
  ).run(NOW, NOW);
  raw.prepare("INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE,REQUIRES_CODE,DEPENDENCY_GROUP,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES ('COMBO2','HANABI',0,1,0,?,?)").run(NOW, NOW);
  raw.prepare("INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE,REQUIRES_CODE,DEPENDENCY_GROUP,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES ('COMBO2','SUN_AND_MOON',1,1,0,?,?)").run(NOW, NOW);
  // HANABI だけ所有 → グループ0(HANABI)は充足、グループ1(SUN_AND_MOON)のみ未充足
  grant(raw, authUserId, pid.HANABI, { grantType: 0 });
  let caught = null;
  try {
    await checkProductDependencies(env, authUserId, ["COMBO2"]);
  } catch (e) { caught = e; }
  assert.ok(caught && caught.code === "DEPENDENCY_REQUIRED");
  assert.equal(caught.details.missingGroups.length, 1, "充足済みグループは含めない");
  assert.deepEqual(caught.details.missingGroups[0].requiresAnyOf, ["SUN_AND_MOON"]);
});

/* ============ 無効な依存定義・安全側 ============ */

test("[dep] STATUS=0 の依存定義は無効（判定に使わない）", async () => {
  const { env, authUserId, raw } = freshEnv();
  // 既存の EARTH→HANABI を無効化
  raw.prepare("UPDATE M_PRODUCT_DEPENDENCY SET STATUS=0 WHERE PRODUCT_CODE='HANABI_GOOGLE_EARTH'").run();
  // 依存定義が無効 = 依存なし扱い → 前提なしでも通過
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]));
});

test("[dep] 前提商品が無効（M_PRODUCT.STATUS=0）なら充足せず購入不可（安全側）", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  // HANABI を有効 entitlement で所有させるが、M_PRODUCT 側で HANABI を無効化
  grant(raw, authUserId, pid.HANABI, { grantType: 0 });
  raw.prepare("UPDATE M_PRODUCT SET STATUS=0 WHERE PRODUCT_CODE='HANABI'").run();
  // isProductAvailable が M_PRODUCT 無効を false 判定 → 依存充足せず拒否
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
});

test("[dep] 自己依存は DB CHECK で登録できない", () => {
  const { raw } = freshEnv();
  assert.throws(() =>
    raw.prepare("INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE,REQUIRES_CODE,DEPENDENCY_GROUP,STATUS,DEL_FLG,CREATE_DATE,UPDATE_DATE) VALUES ('HANABI','HANABI',0,1,0,?,?)").run(NOW, NOW),
  );
});

/* ============ 既存 entitlement 利用可否に依存を混入させない ============ */

test("[dep] isProductAvailable（利用可否）は依存関係を見ない（EARTH を直接付与されたユーザーは HANABI 未所有でも EARTH 利用可）", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  // HANABI は所有せず、EARTH だけ Admin 直接付与
  grant(raw, authUserId, pid.HANABI_GOOGLE_EARTH, { grantType: 3 });
  // 利用可否（entitlement）は依存を混入させない → EARTH は利用可能
  const available = await isProductAvailable(env, authUserId, "HANABI_GOOGLE_EARTH");
  assert.equal(available, true, "既存 entitlement の利用可否に購入依存を混入させない");
  // 一方、新規購入依存としては HANABI 未所有なので EARTH の再購入は依存不足（購入可否は別軸）
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["HANABI_GOOGLE_EARTH"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
});

/* ============ 実ファイル検証: 旧コード定義の廃止 ============ */

test("[dep] 旧 PRODUCT_DEPENDENCIES のコード固定定義が残っていない（DB 一本化）", () => {
  const purchaseTs = readFileSync("src/shared/purchase.ts", "utf8");
  // const PRODUCT_DEPENDENCIES = { ... } の定義が無い（コメントでの言及は可）
  assert.doesNotMatch(purchaseTs, /const PRODUCT_DEPENDENCIES\s*[:=]/);
  // 依存は DB から引く
  assert.match(purchaseTs, /FROM M_PRODUCT_DEPENDENCY/);
  assert.match(purchaseTs, /DEPENDENCY_GROUP/);
});

test("[dep] migration 0008: テーブル・制約・初期データ・JST 日時を含む", () => {
  const m = readFileSync("migrations/0008_add_product_dependency.sql", "utf8");
  const sqlLines = m.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(sqlLines, /CREATE TABLE IF NOT EXISTS M_PRODUCT_DEPENDENCY/);
  assert.match(sqlLines, /CHECK \(PRODUCT_CODE <> REQUIRES_CODE\)/);
  assert.match(sqlLines, /FOREIGN KEY \(PRODUCT_CODE\) REFERENCES M_PRODUCT/);
  assert.match(sqlLines, /FOREIGN KEY \(REQUIRES_CODE\) REFERENCES M_PRODUCT/);
  assert.match(sqlLines, /CREATE UNIQUE INDEX IF NOT EXISTS UX_PRODUCT_DEPENDENCY/);
  assert.match(sqlLines, /'HANABI_GOOGLE_EARTH', 'HANABI'/);
  assert.match(sqlLines, /strftime\('%Y-%m-%dT%H:%M:%S', 'now', '\+9 hours'\) \|\| '\+09:00'/);
  assert.doesNotMatch(sqlLines, /datetime\('now'\)/);
  // 3D_PREVIEW は初期データに含めない
  assert.doesNotMatch(sqlLines, /3D_PREVIEW/);
});

/* ============ SATISFY_MODE=ENTITLEMENT_ONLY（3D_PREVIEW 将来仕様） ============ */

test("[dep] 要件G: 3D_PREVIEW は両方所有でも購入可", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  seed3dPreviewAnyOf(raw);
  grant(raw, authUserId, pid.HANABI, { grantType: 0 });
  grant(raw, authUserId, pid.SUN_AND_MOON, { grantType: 0 });
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["3D_PREVIEW"]));
});

test("[dep] 要件I: ENTITLEMENT_ONLY は同一カートで抜けられない（HANABI未所有・HANABI+3D_PREVIEW 同時カート → NG）", async () => {
  const { env, authUserId, raw } = freshEnv();
  seed3dPreviewAnyOf(raw);
  // HANABI を所有していないが同一カートに HANABI を入れても ENTITLEMENT_ONLY では充足しない
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["HANABI", "3D_PREVIEW"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
});

test("[dep] 要件J: ENTITLEMENT_ONLY は SUN_AND_MOON+3D_PREVIEW 同時カートでも NG", async () => {
  const { env, authUserId, raw } = freshEnv();
  seed3dPreviewAnyOf(raw);
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["SUN_AND_MOON", "3D_PREVIEW"]),
    (e) => e.code === "DEPENDENCY_REQUIRED",
  );
});

test("[dep] 要件K: Admin 直接付与 HANABI・T_PURCHASE 0件 → 3D_PREVIEW(ENTITLEMENT_ONLY) 購入可", async () => {
  const { env, authUserId, raw, pid } = freshEnv();
  seed3dPreviewAnyOf(raw);
  grant(raw, authUserId, pid.HANABI, { grantType: 3 }); // Admin 直接付与
  assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM T_PURCHASE").get().c, 0, "購入履歴なし");
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["3D_PREVIEW"]));
});

test("[dep] 対比: EARTH(ENTITLEMENT_OR_CART) は同一カートで充足できる（現行挙動の維持を再確認）", async () => {
  const { env, authUserId } = freshEnv();
  // HANABI 未所有でも HANABI+EARTH 同時カートは OK（EARTH は OR_CART）
  await assert.doesNotReject(() => checkProductDependencies(env, authUserId, ["HANABI", "HANABI_GOOGLE_EARTH"]));
});

/* ============ 循環依存の検出（要件M/N/O） ============ */

// 依存グラフ用に仮商品 A/B/C を M_PRODUCT へ登録するヘルパ
function seedProducts(raw, codes) {
  let idBase = 200;
  for (const c of codes) {
    raw.prepare(
      `INSERT INTO M_PRODUCT (PRODUCT_ID, PRODUCT_CODE, PRODUCT_NAME, STATUS, SORT_NO, DEL_FLG, CREATE_DATE, UPDATE_DATE,
         PURCHASE_ENABLED, SALE_TYPE, DISPLAY_PRICE, BILLING_INTERVAL, STRIPE_PRICE_ID)
       VALUES (?, ?, ?, 1, ?, 0, ?, ?, 1, 'ONE_TIME', 100, NULL, NULL)`,
    ).run(idBase, c, c, idBase, NOW, NOW);
    idBase++;
  }
}
function addDep(raw, product, requires, { group = 0, mode = "ENTITLEMENT_OR_CART" } = {}) {
  raw.prepare(
    `INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE, REQUIRES_CODE, DEPENDENCY_GROUP, SATISFY_MODE, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
  ).run(product, requires, group, mode, NOW, NOW);
}

test("[dep] 要件M: A→B, B→A の循環は DependencyConfigError で拒否（A+B 同時カートでも抜けられない）", async () => {
  const { env, authUserId, raw } = freshEnv();
  seedProducts(raw, ["A", "B"]);
  addDep(raw, "A", "B");
  addDep(raw, "B", "A");
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["A", "B"]),
    (e) => e instanceof DependencyConfigError,
  );
});

test("[dep] 要件N: A→B→C→A の多段循環も検出して拒否", async () => {
  const { env, authUserId, raw } = freshEnv();
  seedProducts(raw, ["A", "B", "C"]);
  addDep(raw, "A", "B");
  addDep(raw, "B", "C");
  addDep(raw, "C", "A");
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["A"]),
    (e) => e instanceof DependencyConfigError,
  );
});

test("[dep] 要件O: 循環のない多段依存（A→B→C）は設定として正常", async () => {
  const { env, raw } = freshEnv();
  seedProducts(raw, ["A", "B", "C"]);
  addDep(raw, "A", "B");
  addDep(raw, "B", "C");
  await assert.doesNotReject(() => assertNoDependencyCycle(env));
});

test("[dep] assertNoDependencyCycle: 無効(STATUS=0)な循環定義は循環判定に含めない", async () => {
  const { env, raw } = freshEnv();
  seedProducts(raw, ["A", "B"]);
  addDep(raw, "A", "B");
  // B→A を STATUS=0 で登録（無効）→ 循環にならない
  raw.prepare(
    `INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE, REQUIRES_CODE, DEPENDENCY_GROUP, SATISFY_MODE, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
     VALUES ('B', 'A', 0, 'ENTITLEMENT_OR_CART', 0, 0, ?, ?)`,
  ).run(NOW, NOW);
  await assert.doesNotReject(() => assertNoDependencyCycle(env));
});

/* ============ SATISFY_MODE の制約（要件Q・混在） ============ */

test("[dep] 要件Q: SATISFY_MODE 不正値は DB CHECK で拒否", () => {
  const { raw } = freshEnv();
  assert.throws(() =>
    raw.prepare(
      `INSERT INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE, REQUIRES_CODE, DEPENDENCY_GROUP, SATISFY_MODE, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
       VALUES ('HANABI_GOOGLE_EARTH', 'SUN_AND_MOON', 1, 'FOO', 1, 0, ?, ?)`,
    ).run(NOW, NOW),
  );
});

test("[dep] 同一グループ内で SATISFY_MODE が混在する設定は DependencyConfigError で拒否", async () => {
  const { env, authUserId, raw } = freshEnv();
  seedProducts(raw, ["X"]);
  // X のグループ 0 に HANABI(OR_CART) と SUN_AND_MOON(ONLY) を混在登録
  addDep(raw, "X", "HANABI", { group: 0, mode: "ENTITLEMENT_OR_CART" });
  addDep(raw, "X", "SUN_AND_MOON", { group: 0, mode: "ENTITLEMENT_ONLY" });
  await assert.rejects(
    () => checkProductDependencies(env, authUserId, ["X"]),
    (e) => e instanceof DependencyConfigError,
  );
});

/* ============ seed 再適用安全性（要件R） ============ */

test("[dep] 要件R: migration 0008 の seed を再実行しても重複エラーにならない（INSERT OR IGNORE）", () => {
  const { raw } = freshEnv();
  const before = raw.prepare("SELECT COUNT(*) AS c FROM M_PRODUCT_DEPENDENCY WHERE PRODUCT_CODE='HANABI_GOOGLE_EARTH'").get().c;
  // 0008 の seed 相当を再実行
  assert.doesNotThrow(() =>
    raw.prepare(
      `INSERT OR IGNORE INTO M_PRODUCT_DEPENDENCY (PRODUCT_CODE, REQUIRES_CODE, DEPENDENCY_GROUP, SATISFY_MODE, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
       VALUES ('HANABI_GOOGLE_EARTH', 'HANABI', 0, 'ENTITLEMENT_OR_CART', 1, 0, ?, ?)`,
    ).run(NOW, NOW),
  );
  const after = raw.prepare("SELECT COUNT(*) AS c FROM M_PRODUCT_DEPENDENCY WHERE PRODUCT_CODE='HANABI_GOOGLE_EARTH'").get().c;
  assert.equal(after, before, "再適用しても件数が増えない");
});

test("[dep] 初期データの SATISFY_MODE は ENTITLEMENT_OR_CART（EARTH 現行仕様）", () => {
  const { raw } = freshEnv();
  const row = raw.prepare("SELECT SATISFY_MODE FROM M_PRODUCT_DEPENDENCY WHERE PRODUCT_CODE='HANABI_GOOGLE_EARTH'").get();
  assert.equal(row.SATISFY_MODE, "ENTITLEMENT_OR_CART");
});

test("[dep] migration 0008: SATISFY_MODE 列・CHECK・PRAGMA・INSERT OR IGNORE を含む", () => {
  const m = readFileSync("migrations/0008_add_product_dependency.sql", "utf8");
  const sqlLines = m.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(sqlLines, /SATISFY_MODE\s+TEXT\s+NOT NULL/);
  assert.match(sqlLines, /CHECK \(SATISFY_MODE IN \('ENTITLEMENT_ONLY', 'ENTITLEMENT_OR_CART'\)\)/);
  assert.match(sqlLines, /PRAGMA foreign_keys = ON/);
  assert.match(sqlLines, /INSERT OR IGNORE INTO M_PRODUCT_DEPENDENCY/);
  assert.match(sqlLines, /'HANABI_GOOGLE_EARTH', 'HANABI', 0, 'ENTITLEMENT_OR_CART'/);
});
