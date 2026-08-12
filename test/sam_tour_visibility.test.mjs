/**
 * SUN AND MOON 発売前最終調整 項目10/13: Tour1/Tour2 の表示状態排他の検証。
 *
 * 方針:
 * 1) 実ファイル(index.html)の KML 生成テンプレートから、各 Update(開始/終了)が設定する
 *    visibility を検証する（実装が仕様の Change を含むことの担保）。
 * 2) その Change 列で状態機械を回し、要求された10シーケンスすべてで
 *    「Tour1系とTour2系が同時表示にならない」ことを検証する。
 *    中断 = 終了 Update を適用せずに次の開始 Update を適用（ロールバック非依存の検証）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("public/apps/sun-and-moon/index.html", "utf8");

// ---- 1) 実ファイルから各 Update の設定値を検証 ----
function block(reStart) {
  const i = html.search(reStart);
  assert.ok(i >= 0, `block not found: ${reStart}`);
  const seg = html.slice(i, i + 1400);
  const end = seg.indexOf("</gx:AnimatedUpdate>");
  assert.ok(end > 0);
  return seg.slice(0, end);
}

// Tour1 開始（#time_style を設定する開始 Update。項目10-1）
const t1Start = block(/<Placemark targetId="time_label"><styleUrl>#time_style<\/styleUrl><\/Placemark>\s*\n\s*<Placemark targetId="body_placemark"><visibility>1/);
// Tour2 開始（#time_style_t2 を設定。項目10-2）
const t2Start = block(/<Placemark targetId="time_label"><styleUrl>#time_style_t2<\/styleUrl>/);
// Tour1 終了（t1枠 OFF のみの Update）
const t1End = block(/<Change>\s*\n\s*<ScreenOverlay targetId="fov_frame_t1"><visibility>0<\/visibility><\/ScreenOverlay>\s*\n\s*<\/Change>/);
// Tour2 終了（style を #time_style に戻す Update）
const t2EndIdx = html.lastIndexOf('<Placemark targetId="time_label"><styleUrl>#time_style</styleUrl></Placemark>');
const t2End = html.slice(t2EndIdx, t2EndIdx + 900).split("</gx:AnimatedUpdate>")[0];

function setsOf(seg) {
  const out = {};
  const re = /targetId="(body_placemark|body_placemark_t2|fov_frame_t1|fov_frame_t2)"><visibility>([01])/g;
  let m;
  while ((m = re.exec(seg))) out[m[1]] = Number(m[2]);
  return out;
}
const S = { t1Start: setsOf(t1Start), t2Start: setsOf(t2Start), t1End: setsOf(t1End), t2End: setsOf(t2End) };

test("[Tour排他] Tour1開始Updateが自状態を明示構築する（10-1）", () => {
  assert.equal(S.t1Start.body_placemark, 1, "body ON");
  assert.equal(S.t1Start.body_placemark_t2, 0, "body_t2 OFF");
  assert.equal(S.t1Start.fov_frame_t2, 0, "t2枠 OFF");
  assert.equal(S.t1Start.fov_frame_t1, 1, "t1枠 ON（枠表示条件下のテンプレート）");
});

test("[Tour排他] Tour2開始Updateが相手系を明示OFFする（10-2）", () => {
  assert.equal(S.t2Start.body_placemark, 0, "body OFF");
  assert.equal(S.t2Start.body_placemark_t2, 1, "body_t2 ON");
  assert.equal(S.t2Start.fov_frame_t1, 0, "t1枠 OFF");
  assert.equal(S.t2Start.fov_frame_t2, 1, "t2枠 ON");
});

test("[Tour排他] 終了Updateは通常状態へ復元する（10-3）", () => {
  assert.equal(S.t1End.fov_frame_t1, 0, "t1終了: t1枠 OFF");
  assert.equal(S.t2End.body_placemark, 1, "t2終了: body ON");
  assert.equal(S.t2End.body_placemark_t2, 0, "t2終了: body_t2 OFF");
  assert.equal(S.t2End.fov_frame_t2, 0, "t2終了: t2枠 OFF");
});

// ---- 2) 状態機械で10シーケンスを検証（中断=終了Update非適用） ----
const INITIAL = { body_placemark: 1, body_placemark_t2: 0, fov_frame_t1: 0, fov_frame_t2: 0 };
const apply = (st, change) => ({ ...st, ...change });
const okDuringT1 = (st) => st.body_placemark === 1 && st.body_placemark_t2 === 0 && st.fov_frame_t2 === 0;
const okDuringT2 = (st) => st.body_placemark === 0 && st.body_placemark_t2 === 1 && st.fov_frame_t1 === 0;
const noDouble = (st) => !(st.body_placemark === 1 && st.body_placemark_t2 === 1) && !(st.fov_frame_t1 === 1 && st.fov_frame_t2 === 1);
const isNormal = (st) => st.body_placemark === 1 && st.body_placemark_t2 === 0 && st.fov_frame_t1 === 0 && st.fov_frame_t2 === 0;

test("[Tour排他] 10シーケンスの状態遷移で同時表示が発生しない（10-4/13）", () => {
  // 1. 初期状態
  let st = { ...INITIAL };
  assert.ok(isNormal(st) && noDouble(st), "初期");
  // 2. Tour1開始 → 3. Tour1終了
  st = apply({ ...INITIAL }, S.t1Start);
  assert.ok(okDuringT1(st) && noDouble(st), "T1再生中");
  st = apply(st, S.t1End);
  assert.ok(isNormal(st), "T1終了後は通常状態");
  // 4. Tour2開始 → 5. Tour2終了
  st = apply({ ...INITIAL }, S.t2Start);
  assert.ok(okDuringT2(st) && noDouble(st), "T2再生中");
  st = apply(st, S.t2End);
  assert.ok(isNormal(st), "T2終了後は通常状態");
  // 6. Tour1 → Tour2（完走遷移）
  st = apply(apply(apply({ ...INITIAL }, S.t1Start), S.t1End), S.t2Start);
  assert.ok(okDuringT2(st) && noDouble(st), "T1完走→T2");
  // 7. Tour2 → Tour1（完走遷移）
  st = apply(apply(apply({ ...INITIAL }, S.t2Start), S.t2End), S.t1Start);
  assert.ok(okDuringT1(st) && noDouble(st), "T2完走→T1");
  // 8. Tour1中断 → Tour2（終了Update非適用＝ロールバック非依存）
  st = apply(apply({ ...INITIAL }, S.t1Start), S.t2Start);
  assert.ok(okDuringT2(st) && noDouble(st), "T1中断→T2");
  // 9. Tour2中断 → Tour1
  st = apply(apply({ ...INITIAL }, S.t2Start), S.t1Start);
  assert.ok(okDuringT1(st) && noDouble(st), "T2中断→T1");
  // 10. Tour1 → Tour2 → Tour1（連続・中断混在でも収束）
  st = apply(apply(apply({ ...INITIAL }, S.t1Start), S.t2Start), S.t1Start);
  assert.ok(okDuringT1(st) && noDouble(st), "T1→T2→T1");
  // 同一Tour連続再生（冪等）
  st = apply(apply({ ...INITIAL }, S.t1Start), S.t1Start);
  assert.ok(okDuringT1(st), "T1連続");
  st = apply(apply({ ...INITIAL }, S.t2Start), S.t2Start);
  assert.ok(okDuringT2(st), "T2連続");
});

// ---- 3) Camera・天体・枠の対応（項目11）: 各TourのFlyTo Cameraと使用オブジェクトの組 ----
test("[Tour整合] Tour1=撮影地点Camera+positions / Tour2=virt Camera+positions_t2 の組で混在しない（11）", () => {
  // Tour1 の FlyTo Camera は撮影地点
  assert.match(html, /<Camera>\s*\n\s*<longitude>\$\{sLng\}<\/longitude>\s*\n\s*<latitude>\$\{sLat\}<\/latitude>/);
  // Tour2 の FlyTo Camera は仮想カメラ
  assert.match(html, /<longitude>\$\{virtLng\.toFixed\(7\)\}<\/longitude>\s*\n\s*<latitude>\$\{virtLat\.toFixed\(7\)\}/);
  // Tour1系オブジェクトは positions（撮影地点基準）のみ、Tour2系は positions_t2（virt基準）のみを参照
  assert.match(html, /targetId="body_loc">\s*\n\s*<longitude>\$\{p\.lng\.toFixed\(7\)\}/);
  assert.match(html, /targetId="body_loc_t2">\s*\n\s*<longitude>\$\{positions_t2\[i\]\.lng\.toFixed\(7\)\}/);
  assert.ok(!/targetId="body_loc">\s*\n\s*<longitude>\$\{positions_t2/.test(html), "t1天体にvirt座標が混入しない");
  assert.ok(!/targetId="body_loc_t2">\s*\n\s*<longitude>\$\{p\.lng/.test(html), "t2天体に撮影地点座標が混入しない");
  // 枠: t1枠は fovSize*_t1、t2枠は fovSize*_t2 を参照
  assert.match(html, /id="fov_frame_t1"[\s\S]{0,600}\$\{fovSizeX_t1\.toFixed\(4\)\}/);
  assert.match(html, /id="fov_frame_t2"[\s\S]{0,600}\$\{fovSizeX_t2\.toFixed\(4\)\}/);
});
