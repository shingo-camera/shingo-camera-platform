/**
 * Rev4 §17-19: Googleマップ起動対象（撮影地点/筒場/対象）と PC/スマホ UI。
 *
 * §17 撮影地点→撮影地点座標 / 筒場→選択筒場座標 / 対象→選択対象座標。未選択は何もしない（代替しない）。
 * §18 PC は既存 🗺 ポップアップへ筒場・対象を追加（独立ボタンを増やさない）。
 * §19 スマホは衛星切替を独立に残し、その他とGoogleマップ3対象を集約メニューへ。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, "../public/apps/hanabi/index.html"), "utf8");

function funcBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

test("[gmap][§17] 撮影地点/筒場/対象の起動ヘルパが存在し、未選択で何もしない（代替しない）", () => {
  const openAt = funcBody(html, "_openGmapAt");
  const tube = funcBody(html, "_hanabiSelectedTube");
  const tgt = funcBody(html, "_hanabiSelectedTarget");
  assert.ok(openAt && tube && tgt, "ヘルパ抽出");
  // _openGmapAt は null/未定義座標で return（何もしない）
  assert.match(openAt, /if\(!pos[\s\S]*?return/, "座標無しは何もしない");
  assert.match(openAt, /google\.com\/maps\?q=/, "Googleマップ URL を開く");
  // 筒場/対象は未選択なら null（代替しない）
  assert.match(tube, /if\(!selId\)\s*return null|selId[\s\S]*return null/, "筒場未選択→null");
  assert.match(tgt, /if\(!tid\)\s*return null/, "対象未選択→null");
  // 撮影地点・地図中心・現在地へ代替しない（_openGmapAt に fallback 座標が無い）
  assert.doesNotMatch(openAt, /viewLat|map\.getCenter|currentLocation/, "未選択時に代替座標を使わない");
});

test("[gmap][§17] 座標は対象別（撮影地点=viewLat/lng・筒場=選択筒場・対象=選択対象）", () => {
  const view = funcBody(html, "_openViewGmap");
  const tube = funcBody(html, "_hanabiSelectedTube");
  const tgt = funcBody(html, "_hanabiSelectedTarget");
  assert.match(view, /viewLat!==null\s*&&\s*viewLng!==null/, "撮影地点は viewLat/viewLng");
  assert.match(tube, /db\.tubes\.find\(/, "筒場は選択筒場を db から解決");
  assert.match(tgt, /db\.targets\.find\(/, "対象は選択対象を db から解決");
});

test("[gmap][§18] PC 🗺 ポップアップに筒場・対象の Googleマップを追加（独立ボタンを増やさない）", () => {
  // map-link-pop 内に筒場/対象ボタンがある
  assert.match(html, /id="map-btn-gmap-tube"[\s\S]*?_openTubeGmap\(\)/, "筒場ボタン");
  assert.match(html, /id="map-btn-gmap-target"[\s\S]*?_openTargetGmap\(\)/, "対象ボタン");
  // 撮影地点は既存の map-btn-gmap（ラベルを撮影地点に）
  assert.match(html, /id="map-btn-gmap"[\s\S]*?Googleマップ（撮影地点）/, "撮影地点ラベル");
});

test("[gmap][§19] スマホ集約メニューがあり、衛星切替は独立（メニュー外）", () => {
  // 集約メニュー（☰）とシート
  assert.match(html, /id="hb-map-menu-btn"/, "☰ メニューボタン");
  assert.match(html, /id="hb-map-menu-sheet"/, "メニューシート");
  // メニューに Googleマップ 3 対象
  assert.match(html, /id="hb-mm-gmap-view"/, "撮影地点");
  assert.match(html, /id="hb-mm-gmap-tube"/, "筒場");
  assert.match(html, /id="hb-mm-gmap-target"/, "対象");
  // スマホで個別 map-btns を隠し（集約）、衛星切替は残す
  assert.match(html, /#map-btns\{\s*display:none\s*!important/, "スマホで個別ボタン群を非表示");
  // 衛星切替（Leaflet MapCtrl）はメニューに入れず独立（🛰 を集約メニュー項目にしない）
  const sheet = html.slice(html.indexOf('id="hb-map-menu-sheet"'), html.indexOf('id="hb-map-menu-sheet"') + 2000);
  assert.doesNotMatch(sheet, /衛星|🛰/, "衛星切替はメニューに入れない（独立維持）");
});

test("[gmap][§20] Windy は変更しない（メニューは既存 btn-windy へ委譲）", () => {
  const w = funcBody(html, "_hbWindy");
  assert.match(w, /getElementById\(['"]btn-windy['"]\)[\s\S]*\.click\(\)/, "既存 btn-windy を click 委譲");
});

test("[gmap][§19実機] スマホで ≡ 統合済みの旧地図ボタンを非表示・衛星切替は残す", () => {
  // Leaflet 動的コントロールに安定 id が付与されている（推測位置ではなく id で隠す）
  assert.match(html, /btn\.id\s*=\s*'hb-ctrl-sat'/, "衛星切替に安定 id");
  assert.match(html, /btn\.id\s*=\s*'hb-ctrl-loc'/, "現在地に安定 id");
  assert.match(html, /btn\.id\s*=\s*'hb-ctrl-clip'/, "ペーストに安定 id");
  // スマホ CSS で 現在地/ペースト/撮影計画 を非表示（衛星は対象外）
  const mobileHide = html.match(/#hb-ctrl-loc,\s*#hb-ctrl-clip,\s*#pin-btns\{\s*display:none\s*!important/);
  assert.ok(mobileHide, "現在地・ペースト・撮影計画をスマホで非表示");
  // 衛星切替（#hb-ctrl-sat）は非表示リスト（#hb-ctrl-loc, #hb-ctrl-clip, #pin-btns）に含めない
  assert.doesNotMatch(html, /#hb-ctrl-sat[^{}\n]*,[^{}\n]*display:none/, "衛星切替を非表示セレクタに含めない");
  assert.doesNotMatch(html, /#hb-ctrl-loc,\s*#hb-ctrl-clip,\s*#pin-btns,\s*#hb-ctrl-sat/, "衛星を非表示グループに入れない");
  // これらの非表示は mobile media query 内にある
  const mq = html.slice(html.indexOf("@media(max-width:767px)"));
  assert.ok(mq.indexOf("#hb-ctrl-loc, #hb-ctrl-clip, #pin-btns") >= 0, "非表示はスマホ media query 内");
});

test("[gmap][§19実機] メニューの現在地/ペーストは非表示ボタンへ click 委譲（機能維持）", () => {
  const loc = funcBody(html, "_hbLoc");
  const clip = funcBody(html, "_hbClip");
  assert.match(loc, /getElementById\(['"]hb-ctrl-loc['"]\)[\s\S]*\.click\(\)/, "現在地を委譲");
  assert.match(clip, /getElementById\(['"]hb-ctrl-clip['"]\)[\s\S]*\.click\(\)/, "ペーストを委譲");
});
