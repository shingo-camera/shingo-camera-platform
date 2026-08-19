/**
 * Rev4 スマホUI修正:
 *  ① 撮影地点情報「取得中…」が確定表示へ戻る共通ライフサイクル。
 *     移動モード解除・三脚高さ変更・標高オフセット変更のいずれでも updateViewLabel で確定させる。
 *  ② 保存データ呼び出し失敗時に以前の選択を残さず「未選択」へ（表示だけでなく内部状態も）。
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
  if (start < 0) { const a = src.indexOf(`async function ${name}(`); if (a < 0) return null; return sliceFn(src, a); }
  return sliceFn(src, start);
}
function sliceFn(src, start) {
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

/* ---------- ① 「取得中…」→確定表示の共通ライフサイクル ---------- */
test("[view-label①] 移動モード解除（exitMoveMode）で viewMarker 復帰後にラベルを確定表示へ更新", () => {
  const fn = funcBody(html, "exitMoveMode");
  assert.ok(fn, "exitMoveMode 抽出");
  // viewMarker を addTo した直後に updateViewLabel を呼ぶ
  assert.match(fn, /viewMarker\.addTo\(map\);[\s\S]*updateViewLabel\(\)/, "復帰後に updateViewLabel");
});
test("[view-label①] 三脚高さ変更（shiftTripod）で updateViewLabel を呼ぶ", () => {
  const fn = funcBody(html, "shiftTripod");
  assert.match(fn, /updateViewLabel\(\)/, "shiftTripod が updateViewLabel");
});
test("[view-label①] 標高オフセット変更（shiftElevOffset）で updateViewLabel を呼ぶ", () => {
  const fn = funcBody(html, "shiftElevOffset");
  assert.match(fn, /updateViewLabel\(\)/, "shiftElevOffset が updateViewLabel");
});
test("[view-label①] 数値パッド確定（tripod/elev OK）でも updateViewLabel を呼ぶ", () => {
  const fn = funcBody(html, "hkInput");
  // tripod OK と elev OK の双方の確定経路に updateViewLabel
  const okCount = (fn.match(/updateViewLabel\(\)/g) || []).length;
  assert.ok(okCount >= 2, "tripod/elev の OK 経路に updateViewLabel（2箇所以上）");
});
test("[view-label①] updateViewLabel はラベル未存在時は安全に no-op（stale/off-DOM 対応）", () => {
  const fn = funcBody(html, "updateViewLabel");
  assert.match(fn, /const lbl = document\.getElementById\('vmarker-label'\);\s*if\(!lbl\) return/, "ラベル未存在で return");
});

/* ---------- ② 呼び出し失敗時は未選択へ（内部状態もクリア） ---------- */
test("[load-fail②] _applyPlan は festival/tube/target を解決不能時に '' へ（前選択を残さない）", () => {
  const fn = funcBody(html, "_applyPlan");
  assert.ok(fn, "_applyPlan 抽出");
  // setSel は options に無い値を '' にし change を発火（内部状態も更新）
  assert.match(fn, /e\.value\s*=\s*ok\s*\?\s*v\s*:\s*['"]{2}/, "解決不能は ''");
  assert.match(fn, /dispatchEvent\(new Event\('change'\)\)/, "change 発火で内部状態も更新");
  assert.match(fn, /setSel\('sel-tube',\s*pin\.tubeId\s*\|\|\s*''\)/, "tube を無条件 setSel");
  assert.match(fn, /setSel\('sel-target',\s*pin\.targetId\s*\|\|\s*''\)/, "target を無条件 setSel");
});
test("[load-fail②] multiTargetState を失敗時 null にする（表示だけでなく内部状態もクリア）", () => {
  const fn = funcBody(html, "_applyPlan");
  // 旧: 無条件 multiTargetState = pin.multiTarget（stale が残る）を廃止
  assert.doesNotMatch(fn, /multiTargetState\s*=\s*pin\.multiTarget;/, "無条件復元を残さない");
  // 新: 対象が MULTI かつ main が現存する場合のみ復元、さもなくば null
  assert.match(fn, /_mtValid\s*=\s*\(_tgVal\s*===\s*MULTI_TARGET_VALUE\)/, "MULTI 選択時のみ");
  assert.match(fn, /db\.targets\.some\(t=>t\.id===_mt\.main\)/, "main が現存する対象か検証");
  assert.match(fn, /multiTargetState\s*=\s*_mtValid\s*\?\s*_mt\s*:\s*null/, "失敗時は null");
});
test("[load-fail②] 正常時の復元は維持（valid なら multiTarget を復元）", () => {
  const fn = funcBody(html, "_applyPlan");
  assert.match(fn, /_mtValid\s*\?\s*_mt\s*:\s*null/, "valid 時は復元・invalid 時 null");
});

/* ② 挙動: multiTarget 復元の valid 判定ロジック（最小 harness） */
test("[load-fail②][挙動] main が現存しなければ multiTargetState=null、現存かつMULTIなら復元", () => {
  const MULTI = "__multi__";
  function resolveMulti(tgVal, mt, targets) {
    const valid = (tgVal === MULTI) && mt && mt.main && targets.some(t => t.id === mt.main);
    return valid ? mt : null;
  }
  const targets = [{ id: "t1" }, { id: "t2" }];
  // main 現存 + MULTI → 復元
  assert.deepEqual(resolveMulti(MULTI, { main: "t1", sub: ["t2"] }, targets), { main: "t1", sub: ["t2"] });
  // main 削除済み → null
  assert.equal(resolveMulti(MULTI, { main: "tX", sub: [] }, targets), null);
  // 対象が '' に落ちている（MULTI でない）→ null
  assert.equal(resolveMulti("", { main: "t1" }, targets), null);
  // multiTarget 自体が無い → null
  assert.equal(resolveMulti(MULTI, null, targets), null);
});
