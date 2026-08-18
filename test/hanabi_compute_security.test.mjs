/**
 * HANABI 中核 API のセキュリティ・fail-closed・保護構造テスト。
 *
 * requireProduct は Supabase JWT 実検証を通すため完全な auth フローを JWT 無しで実行できない
 * （既存 sam_* も同様）。ここでは実装ファイルの契約を検証する:
 *  - scene-solve / terrain-solve が requireProduct(HANABI) を通す（未ログイン/未所有を拒否）。
 *  - 独自係数・独自式そのものを応答に含めない（結果値のみ返す）。
 *  - client（auth-integration.js）が fail-closed（通信失敗で本体を表示しない）。
 *  - public asset（index.html）に、今回サーバ化した独自係数/独自式を新規複製していない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexTs = readFileSync("src/index.ts", "utf8");
const computeTs = readFileSync("src/apps/hanabi/compute.ts", "utf8");
const sceneTs = readFileSync("src/apps/hanabi/core/scene.ts", "utf8");
const calcTs = readFileSync("src/apps/hanabi/core/hanabi_calc.ts", "utf8");
const authJs = readFileSync("public/apps/hanabi/auth-integration.js", "utf8");
const html = readFileSync("public/apps/hanabi/index.html", "utf8");

/* ---- 1. ルート登録 ---- */
test("[hanabi-sec] scene-solve / terrain-solve が index.ts に登録されている", () => {
  assert.match(indexTs, /pathname === "\/api\/apps\/hanabi\/scene-solve"[\s\S]*?handleHanabiSceneSolve/);
  assert.match(indexTs, /pathname === "\/api\/apps\/hanabi\/terrain-solve"[\s\S]*?handleHanabiTerrainSolve/);
});

/* ---- 2. HANABI entitlement 保護 ---- */
test("[hanabi-sec] compute は requireProduct(HANABI) を通す（新認可を作らない）", () => {
  assert.match(computeTs, /requireProduct\(request, env, HANABI\)/);
  assert.match(computeTs, /const HANABI = "HANABI"/);
  // 未認可時は結果を返さずエラー（fail-closed）。denied を先に返す構造。
  assert.match(computeTs, /if \(denied\) return denied/);
  // 自前 JWT 検証を作らない
  assert.doesNotMatch(computeTs, /jwtVerify|jose|createRemoteJWKSet/);
});

/* ---- 3. 独自係数・独自式を応答に含めない ---- */
test("[hanabi-sec] scene 応答に独自係数（riseTime/windFollowRatio）を含めない", () => {
  // 応答型 BurstResult / TubeResult に riseTime/windFollowRatio を持たせない。
  const burst = sceneTs.match(/export interface BurstResult \{[\s\S]*?\}/)[0];
  assert.doesNotMatch(burst, /riseTime|windFollowRatio/, "バースト結果に内部係数を含めない");
  // scene 応答は角度・距離・径などの結果値のみ。
  assert.match(burst, /fwAzDeg|fwAltDeg|fwDkm|diaM/);
});

/* ---- 4. 独自定数はサーバ core に集約（非公開コメント） ---- */
test("[hanabi-sec] 独自定数（k=0.13 / WIND_ALT_FACTOR / seed）はサーバ core に存在する", () => {
  assert.match(calcTs, /K_TERRESTRIAL_REFRACTION\s*=\s*0\.13/);
  assert.match(calcTs, /WIND_ALT_FACTOR\s*=\s*10\s*\/\s*7/);
  assert.match(calcTs, /NUM_TABLE_SEED/);
  // seed に内部パラメータが含まれる（サーバ側のみ）
  assert.match(calcTs, /riseTime:\s*4\.29/);
});

/* ---- 5. client fail-closed（通信失敗で本体を出さない） ---- */
test("[hanabi-sec] auth-integration は fail-closed（通信失敗で revealApp しない）", () => {
  // guardAppStart は通信失敗で "ERROR" を返し、boot はそれで showAuthError（reveal しない）。
  assert.match(authJs, /return "ERROR"/, "通信失敗は ERROR（本体表示 true を返さない）");
  assert.match(authJs, /showAuthError/, "fail-closed エラー表示を持つ");
  // 旧 fail-open（通信失敗で return true / catch で revealApp）が無い。
  const guard = authJs.match(/async function guardAppStart[\s\S]*?\n  \}/);
  assert.ok(guard);
  assert.doesNotMatch(guard[0], /通信失敗時はブロックせず本体表示/, "旧 fail-open コメントが無い");
  // boot の catch が revealApp を呼ばない（showAuthError のみ）。
  const boot = authJs.match(/function boot\(\)[\s\S]*?\n  \}/);
  assert.ok(boot);
  assert.doesNotMatch(boot[0], /catch[\s\S]*revealApp/, "想定外エラーで revealApp しない");
});

/* ---- 6. public に独自式・独自定数を新規複製していない ---- */
test("[hanabi-sec] 今回サーバ化した独自定数を public へ新規複製していない", () => {
  // K_TERRESTRIAL_REFRACTION / WIND_ALT_FACTOR という命名の定数を public に持ち込んでいない。
  assert.doesNotMatch(html, /K_TERRESTRIAL_REFRACTION/);
  assert.doesNotMatch(html, /NUM_TABLE_SEED/);
  // 注記: elAng / calcWindOffset / DEFAULT_NUM_TABLE の**既存** client 実装は次工程で除去予定。
  // 本テストは「今回の追加で新たに複製していない」ことを担保する（既存除去は次工程テストで扱う）。
});
