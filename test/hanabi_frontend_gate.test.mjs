/**
 * HANABI フロント統合の「実ファイル検証」テスト（ドリフト防止）。
 *
 * public/apps/hanabi/index.html は IIFE・DOM 依存で単体 import できないため、
 * SAM の sam_presale_fixes / frontend_fixes と同方針で、最終成果物の実ファイルに
 * 「旧独自パスワードゲートが撤去され、Platform entitlement ゲートへ置換されている」ことを
 * ファイル内容そのもので検証する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("public/apps/hanabi/index.html", "utf8");
const authJs = readFileSync("public/apps/hanabi/auth-integration.js", "utf8");
const siteConfig = readFileSync("public/assets/site-config.js", "utf8");
const productPage = readFileSync("public/products/hanabi/index.html", "utf8");

/* ---- 1. 旧 Netlify パスワードゲートの撤去 ---- */
test("[実ファイル] 旧 Netlify パスワードゲートのライブコードが撤去されている", () => {
  // /.netlify/functions/check-password の呼び出しコードが存在しない（コメント言及は許容するが fetch は不可）。
  assert.doesNotMatch(html, /fetch\(\s*['"]\/\.netlify\/functions\/check-password/, "check-password への fetch が残っていない");
  // 旧メインゲート要素・関数が存在しない
  assert.doesNotMatch(html, /id=["']pw-overlay["']/, "#pw-overlay が撤去されている");
  assert.doesNotMatch(html, /function checkPW\b/, "checkPW 関数が撤去されている");
  assert.doesNotMatch(html, /function checkGepPW\b/, "checkGepPW 関数が撤去されている");
  assert.doesNotMatch(html, /id=["']modal-gep-auth["']/, "#modal-gep-auth モーダルが撤去されている");
  // 旧認証ハッシュ保存キーの読み書きライブコードが無い（コメント内の言及は除外して判定）。
  assert.doesNotMatch(html, /localStorage\.(setItem|getItem|removeItem)\(\s*['"]hanabiAuthHash/, "hanabiAuthHash の読み書きが無い");
  assert.doesNotMatch(html, /localStorage\.(setItem|getItem|removeItem)\(\s*['"]hanabiGepAuthHash/, "hanabiGepAuthHash の読み書きが無い");
});

/* ---- 2. Platform 認証ゲートの追加 ---- */
test("[実ファイル] Platform 認証ゲート（hb-auth-gate + auth-integration）が組み込まれている", () => {
  // 未認証フラッシュ防止の同期ゲート
  assert.match(html, /html\.hb-auth-gate\s+body\{visibility:hidden/, "hb-auth-gate の CSS が存在");
  assert.match(html, /classList\.add\(["']hb-auth-gate["']\)/, "hb-auth-gate クラスを同期付与");
  // Supabase クライアントと auth-integration.js を読み込む
  assert.match(html, /<script src=["']\/assets\/vendor\/supabase\.js["']><\/script>/, "supabase.js を読み込む");
  assert.match(html, /<script src=["']\/apps\/hanabi\/auth-integration\.js["']><\/script>/, "auth-integration.js を読み込む");
});

/* ---- 3. GEP ダウンロードが entitlement 判定へ置換されている ---- */
test("[実ファイル] Google Earth ダウンロードは HBAuth.hasEarth 判定を使う", () => {
  // onKmlDownloadClick が hasEarth を参照する（パスワードモーダルを開かない）
  const m = html.match(/function onKmlDownloadClick\(\)\{[\s\S]*?\n\}/);
  assert.ok(m, "onKmlDownloadClick が存在");
  const fn = m[0];
  assert.match(fn, /HBAuth[\s\S]*hasEarth/, "hasEarth を参照する");
  assert.match(fn, /downloadGoogleEarthKml\(\)/, "権限ありで実ダウンロードを呼ぶ");
  assert.doesNotMatch(fn, /openModal\(['"]modal-gep-auth['"]\)/, "旧パスワードモーダルを開かない");
  // 実ダウンロード関数自体は保全されている
  assert.match(html, /function downloadGoogleEarthKml\(\)/, "downloadGoogleEarthKml は保全されている");
});

/* ---- 4. 撮影計算・データ層の主要関数が保全されている ---- */
test("[実ファイル] 撮影計算・データ層の主要関数が保全されている", () => {
  for (const fn of [
    "exportData", "importData", "saveDB", "loadPins", "savePins",
    "downloadGoogleEarthKml", "refreshMapMarkers", "buildNumTableModal",
  ]) {
    assert.match(html, new RegExp("function " + fn + "\\("), fn + " が存在する");
  }
});

/* ---- 5. auth-integration.js の契約 ---- */
test("[実ファイル] auth-integration.js が HANABI 用の契約を満たす", () => {
  assert.match(authJs, /\/api\/apps\/hanabi\//, "HANABI 用 API ベースを使う");
  assert.match(authJs, /app-start/, "app-start を叩く");
  assert.match(authJs, /earth-entitlement/, "earth-entitlement を叩く");
  assert.match(authJs, /window\.HBAuth\s*=/, "HBAuth を公開する");
  assert.match(authJs, /hasEarth/, "hasEarth を提供する");
  // 未ログイン→login / 権限なし→商品詳細
  assert.match(authJs, /\/login\//, "未ログインは login へ誘導");
  assert.match(authJs, /\/products\/hanabi\//, "権限なしは商品詳細へ誘導");
  // 旧独自ゲートの痕跡が無い（コメント言及は許容するが fetch 呼び出しは不可）
  assert.doesNotMatch(authJs, /fetch\(\s*['"]\/\.netlify\/functions\/check-password/, "check-password を fetch しない");
});

/* ---- 6. site-config の appUrl 統合 ---- */
test("[実ファイル] site-config の HANABI.appUrl が /apps/hanabi/ に設定されている", () => {
  // HANABI ブロック内の appUrl が /apps/hanabi/（null ではない）
  const block = siteConfig.match(/HANABI:\s*\{[\s\S]*?\},/);
  assert.ok(block, "HANABI 商品ブロックが存在");
  assert.match(block[0], /appUrl:\s*["']\/apps\/hanabi\/["']/, "appUrl が /apps/hanabi/");
  assert.doesNotMatch(block[0], /appUrl:\s*null/, "appUrl が null のままでない");
});

/* ---- 7. 商品詳細ページ（誘導先）の存在 ---- */
test("[実ファイル] products/hanabi 詳細ページが誘導先として成立している", () => {
  assert.match(productPage, /data-page=["']product-hanabi["']/, "data-page=product-hanabi");
  assert.match(productPage, /data-app-icon=["']HANABI["']/, "HANABI アイコン枠");
  assert.match(productPage, /href=["']\/store\//, "STORE への導線");
  assert.match(productPage, /href=["']\/apps\/hanabi\//, "アプリへの導線");
});
