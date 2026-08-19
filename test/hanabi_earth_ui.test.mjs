/**
 * HANABI Google Earth 追加機能の UI 表示制御。
 *
 * 仕様（Production スモークで確認した UX 問題の修正）:
 *   - Google Earth Web（ブラウザ）は権限不要で常時表示（HANABI 本体所有者なら誰でも）。
 *   - Google Earth Pro 用 KML ダウンロードは追加商品 HANABI_GOOGLE_EARTH 保有時のみ表示。
 *     未保有/未ログイン/通信失敗/認証統合不能は非表示（fail-closed）。
 *   - 表示制御は UI のみ。押下時の HBAuth.hasEarth() 判定・サーバ earth.ts の
 *     requireProduct(HANABI_GOOGLE_EARTH) は変更せず二重防御を維持する。
 *
 * index.html は IIFE・DOM 依存で単体 import できないため、hanabi_gmap_ui.test.mjs と同様に
 * 実ファイルへ要件を満たす実コードが在ることを直接検証する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, "../public/apps/hanabi/index.html"), "utf8");
const authJs = readFileSync(resolve(__dirname, "../public/apps/hanabi/auth-integration.js"), "utf8");

function funcBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

/* ---------- Google Earth Web（権限不要・常時表示）は変更しない ---------- */
test("[ge-web] Google Earth Web ボタンは権限判定を挟まず openGoogleEarthWeb を呼ぶ（常時表示）", () => {
  // modal 内 Web ボタンは onclick=openGoogleEarthWeb() のまま（entitlement gating を付けない）
  assert.match(html, /onclick="openGoogleEarthWeb\(\)">🌐 Google Earth Web/, "Web ボタンは無条件");
  // openGoogleEarthWeb 本体は hasEarth を参照しない（URL を開くだけ）
  const fn = funcBody(html, "openGoogleEarthWeb");
  assert.ok(fn, "openGoogleEarthWeb 抽出");
  assert.doesNotMatch(fn, /hasEarth|earth-entitlement|_geEntitled/, "Web は権限判定なし");
});

test("[ge-web] 🌍 map-btn-ge ボタン自体は権限で隠さない（Web 導線を消さない）", () => {
  // _syncGeArBtn は PC/モバイルの排他のみで、Earth 権限で map-btn-ge を隠さない
  const fn = funcBody(html, "_syncGeArBtn");
  assert.ok(fn, "_syncGeArBtn 抽出");
  assert.doesNotMatch(fn, /hasEarth|_geEntitled|earth-entitlement/, "🌍 ボタンは Earth 権限で隠さない");
  // gIsMobile による PC/モバイル排他は従来どおり
  assert.match(fn, /gIsMobile/, "PC/モバイル排他は維持");
});

/* ---------- Google Earth Pro 用 KML（HANABI_GOOGLE_EARTH 保有時のみ表示） ---------- */
test("[ge-pro] Pro KML ボタンは id を持ち既定で非表示", () => {
  assert.match(html, /id="btn-ge-pro-kml"[^>]*onclick="onKmlDownloadClick\(\)"[^>]*style="[^"]*display:none/, "既定 display:none");
});

test("[ge-pro] Pro KML ボタン表示は HBAuth.hasEarth を再利用して同期する", () => {
  const fn = funcBody(html, "_syncGeProKmlBtn");
  assert.ok(fn, "_syncGeProKmlBtn 抽出");
  assert.match(fn, /HBAuth\s*&&\s*self\.HBAuth\.hasEarth/, "既存 hasEarth を再利用");
  assert.match(fn, /btn-ge-pro-kml/, "対象は Pro ボタン");
  // true のときだけ block 表示、それ以外 none
  assert.match(fn, /ok\s*===\s*true\s*\?\s*'block'\s*:\s*'none'/, "true のみ表示");
});

test("[ge-pro][no-cache] false / 通信失敗を永久キャッシュしない（毎回 hasEarth を再確認）", () => {
  const fn = funcBody(html, "_syncGeProKmlBtn");
  // 永久キャッシュ変数 _geEntitledCache を使わない
  assert.doesNotMatch(html, /_geEntitledCache/, "false をキャッシュする変数を持たない");
  // 開くたびに hasEarth() を呼ぶ（早期 return でスキップする分岐が無い）
  assert.match(fn, /fn\(\)\.then\(/, "毎回 hasEarth() を呼ぶ");
  // 確認中はまず非表示に倒す（前回状態を持ち越さない）
  assert.match(fn, /btn\.style\.display\s*=\s*'none';[\s\S]*var fn/, "確認中は非表示に倒す");
});

test("[ge-pro][no-cache] モーダルを開くたびに再確認する（onGoogleEarthBtn が毎回 _syncGeProKmlBtn を呼ぶ）", () => {
  const fn = funcBody(html, "onGoogleEarthBtn");
  assert.match(fn, /_syncGeProKmlBtn\(\);\s*openModal\('modal-ge'\)/, "開くたびに同期");
});

test("[ge-pro][fail-closed] hasEarth 不能・通信失敗は非表示（安全側・キャッシュしない）", () => {
  const fn = funcBody(html, "_syncGeProKmlBtn");
  // 認証統合が無い場合は非表示のまま return（次回再試行）
  assert.match(fn, /if\(!fn\)\s*return;/, "fn 無しは非表示のまま");
  // catch で none（false を固定保存しない）
  assert.match(fn, /catch\(function\(\)\{[\s\S]*btn\.style\.display\s*=\s*'none'/, "通信失敗は非表示");
});

test("[ge-pro] PC モーダルを開く時に Pro ボタン表示を同期する（モバイルは Web 直行で Pro 導線なし）", () => {
  const fn = funcBody(html, "onGoogleEarthBtn");
  assert.ok(fn, "onGoogleEarthBtn 抽出");
  // モバイルは Web 直行
  assert.match(fn, /if\(gIsMobile\)\{\s*openGoogleEarthWeb\(\);/, "モバイルは Web 直行");
  // PC は Pro 表示同期 + modal
  assert.match(fn, /_syncGeProKmlBtn\(\);\s*openModal\('modal-ge'\)/, "PC は Pro 同期後に modal");
});

/* ---------- 二重防御: 押下時判定・サーバ権限は不変 ---------- */
test("[defense] 押下時 onKmlDownloadClick の hasEarth 判定・Store 誘導は維持（UI だけで置換しない）", () => {
  const fn = funcBody(html, "onKmlDownloadClick");
  assert.ok(fn, "onKmlDownloadClick 抽出");
  assert.match(fn, /HBAuth\s*&&\s*self\.HBAuth\.hasEarth/, "押下時も hasEarth 判定");
  assert.match(fn, /downloadGoogleEarthKml\(\)/, "権限ありでダウンロード");
  assert.match(fn, /appUrl\('\/store\/'\)/, "権限なしは Store 誘導");
});

test("[defense] auth-integration.js の hasEarth は earth-entitlement を叩く共通判定のまま（新規判定を作らない）", () => {
  assert.match(authJs, /function hasEarth\(\)/, "hasEarth 定義");
  assert.match(authJs, /earth-entitlement/, "サーバ判定を叩く");
  // fail-closed（未ログイン/非2xx/通信失敗→false）
  assert.match(authJs, /if\s*\(!token\)\s*return false/, "未ログインは false");
  assert.match(authJs, /if\s*\(!res\.ok\)\s*return false/, "非2xxは false");
});

/* ---------- 再確認の挙動モデル（§1-6: false/失敗を固定せず毎回再取得） ---------- */
test("[combination] Web は常時 / Pro は毎回 hasEarth を再確認して true のみ表示（挙動モデル）", async () => {
  // _syncGeProKmlBtn と同一構造の最小モデル。呼ぶたびに hasEarth() を await し、
  //   確認中は none、true のみ block、false/失敗は none（キャッシュしない）。
  let display = "none";
  let gen = 0;
  async function syncPro(hasEarth) {
    display = "none";           // 確認中は非表示に倒す
    const my = ++gen;
    try {
      const ok = await hasEarth();
      if (my !== gen) return;
      display = ok === true ? "block" : "none";
    } catch (e) {
      if (my !== gen) return;
      display = "none";         // 失敗はキャッシュせず none
    }
  }

  // 1. 初回 false → 非表示
  await syncPro(async () => false);
  assert.equal(display, "none", "初回 false → Pro 非表示");

  // 2. 次回 true（同一ページ・reload なし）→ 再取得され表示
  await syncPro(async () => true);
  assert.equal(display, "block", "Admin 付与後に再オープンで Pro 表示（false を固定しない）");

  // 3. 初回通信失敗 → 非表示
  await syncPro(async () => { throw new Error("network"); });
  assert.equal(display, "none", "通信失敗 → Pro 非表示");

  // 4. 次回成功 → 再取得され表示
  await syncPro(async () => true);
  assert.equal(display, "block", "通信失敗を固定せず、次回成功で Pro 表示");

  // 5. true → 表示
  await syncPro(async () => true);
  assert.equal(display, "block", "true → 表示");

  // 6. false → 非表示
  await syncPro(async () => false);
  assert.equal(display, "none", "false → 非表示");
});

test("[combination] 連続オープンの世代ガード: 古い解決は最新オープンを上書きしない（挙動モデル）", async () => {
  let display = "none";
  let gen = 0;
  const resolvers = {};
  function syncPro(tag) {
    display = "none";
    const my = ++gen;
    return new Promise((done) => {
      resolvers[tag] = (ok) => {
        if (my === gen) display = ok === true ? "block" : "none";
        done();
      };
    });
  }
  const pOld = syncPro("old"); // 1回目オープン（例: 権限あり）
  const pNew = syncPro("new"); // 2回目オープン（最新・例: 権限なし）
  resolvers["new"](false);     // 最新が先に解決 → 非表示
  await pNew;
  resolvers["old"](true);      // 古い解決が遅れて到達 → 破棄され block へ戻さない
  await pOld;
  assert.equal(display, "none", "古い true 解決で最新の非表示を上書きしない");
});
