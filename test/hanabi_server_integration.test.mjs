/**
 * HANABI サーバ統合の「実ファイル契約」テスト。
 *
 * app-start / earth-entitlement は requireUser（Supabase JWT 実検証）を経由するため、
 * 既存テスト同様に完全な auth フローを JWT 無しで実行できない（既存 sam_* も同様に
 * entitlement フローそのものは実行検証していない）。
 * そこで統合契約を、実装ファイルの内容そのもので検証する:
 *  - 4 route（app-start / earth-entitlement / scene-solve / terrain-solve）が
 *    正しい HTTP method / path で index.ts に登録されている。
 *  - 既存 requireProduct を正しい商品コードで呼ぶ（新しい認可機構を作っていない）。
 *  - earth-entitlement の応答マッピング（PRODUCT_NOT_GRANTED → 200 hasEarth:false、
 *    権限あり → hasEarth:true、その他 AuthError は passthrough）が存在する。
 *  - app-start は APP_START ログ（recordAppStartAccess）を1回記録する。
 *  - 汎用 HANABI ルーター（/api/apps/hanabi/{name} 形式の startsWith ルーティング）を新設していない
 *    ＝ 個別 route を明示登録する方式であること。
 *  - migration / wrangler / 商品体系を新規に作っていない（HANABI 系は既存定義を使用）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexTs = readFileSync("src/index.ts", "utf8");
const appStartTs = readFileSync("src/apps/hanabi/app_start.ts", "utf8");
const earthTs = readFileSync("src/apps/hanabi/earth.ts", "utf8");

/* ---- 1. ルート登録（4 route） ---- */
test("[実ファイル] index.ts に HANABI 4 route が正しい method/path で登録されている", () => {
  assert.match(indexTs, /import\s*\{\s*handleHanabiAppStart\s*\}\s*from\s*["']\.\/apps\/hanabi\/app_start["']/, "app_start を import");
  assert.match(indexTs, /import\s*\{\s*handleHanabiEarthEntitlement\s*\}\s*from\s*["']\.\/apps\/hanabi\/earth["']/, "earth を import");
  assert.match(indexTs, /import\s*\{\s*handleHanabiSceneSolve,\s*handleHanabiTerrainSolve\s*\}\s*from\s*["']\.\/apps\/hanabi\/compute["']/, "compute を import");
  // POST /api/apps/hanabi/app-start
  assert.match(
    indexTs,
    /method === "POST" && pathname === "\/api\/apps\/hanabi\/app-start"[\s\S]*?handleHanabiAppStart\(request, env\)/,
    "POST app-start → handleHanabiAppStart",
  );
  // GET /api/apps/hanabi/earth-entitlement
  assert.match(
    indexTs,
    /method === "GET" && pathname === "\/api\/apps\/hanabi\/earth-entitlement"[\s\S]*?handleHanabiEarthEntitlement\(request, env\)/,
    "GET earth-entitlement → handleHanabiEarthEntitlement",
  );
  // POST /api/apps/hanabi/scene-solve
  assert.match(
    indexTs,
    /method === "POST" && pathname === "\/api\/apps\/hanabi\/scene-solve"[\s\S]*?handleHanabiSceneSolve\(request, env\)/,
    "POST scene-solve → handleHanabiSceneSolve",
  );
  // POST /api/apps/hanabi/terrain-solve
  assert.match(
    indexTs,
    /method === "POST" && pathname === "\/api\/apps\/hanabi\/terrain-solve"[\s\S]*?handleHanabiTerrainSolve\(request, env\)/,
    "POST terrain-solve → handleHanabiTerrainSolve",
  );
});

/* ---- 2. app-start は既存 requireProduct(HANABI) と APP_START ログを使う ---- */
test("[実ファイル] app_start は requireProduct(HANABI) と recordAppStartAccess を使う", () => {
  assert.match(appStartTs, /from\s*["']\.\.\/\.\.\/shared\/entitlement["']/, "共通 entitlement を import（新設しない）");
  assert.match(appStartTs, /requireProduct\(request, env, HANABI\)/, "requireProduct(HANABI) を呼ぶ");
  assert.match(appStartTs, /const HANABI = "HANABI"/, "商品コードは HANABI");
  assert.match(appStartTs, /recordAppStartAccess\(/, "APP_START アクセスログを記録する");
  // 新しい認証・JWT 検証を自前で実装していない
  assert.doesNotMatch(appStartTs, /jwtVerify|jose|createRemoteJWKSet/, "自前 JWT 検証を作らない");
});

/* ---- 3. earth-entitlement の応答マッピング ---- */
test("[実ファイル] earth は requireProduct(HANABI_GOOGLE_EARTH) を使い応答を正しくマップする", () => {
  assert.match(earthTs, /const HANABI_GOOGLE_EARTH = "HANABI_GOOGLE_EARTH"/, "商品コードは HANABI_GOOGLE_EARTH");
  assert.match(earthTs, /requireProduct\(request, env, HANABI_GOOGLE_EARTH\)/, "requireProduct(HANABI_GOOGLE_EARTH) を呼ぶ");
  // 権限あり → hasEarth:true
  assert.match(earthTs, /jsonOk\(\{\s*hasEarth:\s*true\s*\}\)/, "権限あり → hasEarth:true");
  // PRODUCT_NOT_GRANTED → 200 hasEarth:false（エラーにしない）
  assert.match(earthTs, /PRODUCT_NOT_GRANTED/, "未所有コードを判定する");
  assert.match(earthTs, /jsonOk\(\{\s*hasEarth:\s*false\s*\}\)/, "未所有 → hasEarth:false（200）");
  // その他 AuthError（401/USER_SUSPENDED/404）は passthrough
  assert.match(earthTs, /jsonError\(e\.code, e\.message, e\.status\)/, "その他 AuthError はそのまま返す");
  // 独自の Earth 権利判定を作っていない（listMeProducts の再実装等をしない）
  assert.doesNotMatch(earthTs, /T_USER_PRODUCT|SELECT /i, "独自の権利 SQL を書かない（requireProduct 再利用）");
});

/* ---- 4. compute（scene-solve/terrain-solve）が HANABI entitlement で保護されている ---- */
test("[実ファイル] compute は requireProduct(HANABI) で保護され fail-closed である", () => {
  const computeTs = readFileSync("src/apps/hanabi/compute.ts", "utf8");
  assert.match(computeTs, /requireProduct\(request, env, HANABI\)/, "requireProduct(HANABI) を通す");
  assert.match(computeTs, /const HANABI = "HANABI"/, "商品コードは HANABI");
  // 未認可は結果を返さずエラー（denied を先に return = fail-closed）
  assert.match(computeTs, /if \(denied\) return denied/, "未認可時は fail-closed");
  // 自前 JWT 検証を作らない
  assert.doesNotMatch(computeTs, /jwtVerify|jose|createRemoteJWKSet/, "自前 JWT 検証を作らない");
});

/* ---- 5. 汎用 HANABI ルーターを新設していない（個別 route 明示登録） ---- */
test("[実ファイル] 汎用 HANABI ルーター（startsWith 方式）を新設していない", () => {
  // SAM のような /api/apps/hanabi/{name} を startsWith で一括ディスパッチする汎用ルータは作らず、
  // app-start / earth-entitlement / scene-solve / terrain-solve を個別 route として明示登録する方式であること。
  assert.doesNotMatch(
    indexTs,
    /pathname\.startsWith\("\/api\/apps\/hanabi\/"\)/,
    "汎用 startsWith ルータを新設しない（個別 route 明示登録）",
  );
  // 明示登録された HANABI route が 4 本存在すること（method/path 一致は test 1 で検証済み）。
  const hanabiRoutes = (indexTs.match(/pathname === "\/api\/apps\/hanabi\/[a-z-]+"/g) || []);
  assert.equal(hanabiRoutes.length, 4, "HANABI の明示 route は4本（app-start/earth-entitlement/scene-solve/terrain-solve）");
});
