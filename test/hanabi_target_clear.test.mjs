/**
 * Rev4: 対象未選択時の stale state 一掃。
 *
 * 原因: getEffectiveTargetId() は pcVal||mobVal を返すため、PC 側 sel-target を '' にしても
 *   mob-sel-target に古い対象ID が残ると effective targetId が stale になり、青丸・Google Map（対象）・
 *   編集が古い対象を参照した。onTargetChange が PC→mob を同期していなかった（mob→PC のみ同期）。
 * 修正: onTargetChange で PC/mob の両 select を常に同値へ揃える（未選択含む）。
 *   さらに複数選択の main が現存しない場合 getEffectiveTargetId は '' を返す（dangling を effective にしない）。
 *   計算結果は不変（dangling ID も '' も server では「対象なし」＝同一 scene）。
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

/* ---------- source: 未選択遷移の共通クリア/同期 ---------- */
test("[target-clear] onTargetChange が PC/mob の対象 select を同値へ揃える（未選択含む）", () => {
  const fn = funcBody(html, "onTargetChange");
  assert.ok(fn, "onTargetChange 抽出");
  assert.match(fn, /mob-sel-target/, "mob 側を参照");
  assert.match(fn, /mobSel\.value\s*!==\s*raw[\s\S]*mobSel\.value\s*=\s*raw/, "mob を PC(raw) に揃える");
});
test("[target-clear] 単一対象クリア時に multiTargetState=null（内部状態クリア）", () => {
  const fn = funcBody(html, "onTargetChange");
  assert.match(fn, /multiTargetState\s*=\s*null/, "MULTI 以外で multiTargetState をクリア");
});
test("[target-clear] 編集ボタンは PC/mob 両方 effective target 無しで無効化", () => {
  const fn = funcBody(html, "onTargetChange");
  assert.match(fn, /getElementById\('btn-edit-target'\)\.disabled\s*=\s*!tid/, "PC 編集無効化");
  assert.match(fn, /mob-btn-edit-target[\s\S]*disabled\s*=\s*!tid/, "mob 編集無効化");
});

/* ---------- source: getEffectiveTargetId の dangling 排除 ---------- */
test("[target-eff] getEffectiveTargetId は MULTI の main が現存しなければ '' を返す", () => {
  const fn = funcBody(html, "getEffectiveTargetId");
  assert.match(fn, /db\.targets\.some\(t=>t\.id===mainId\)/, "main の現存を検証");
  assert.match(fn, /\?\s*mainId\s*:\s*''/, "現存すれば mainId・さもなくば ''");
});

/* ---------- 挙動: pcVal||mobVal 同期後は未選択が一元化される ---------- */
test("[target-eff][挙動] PC 未選択・mob 同期後は effective が '' になる", () => {
  // getEffectiveTargetId の単一対象ロジック（同期後は pc===mob===''）
  function eff(pcVal, mobVal, MULTI, multiState, targets) {
    const raw = pcVal || mobVal;
    if (raw === MULTI) {
      const mainId = (multiState && multiState.main) ? multiState.main : "";
      if (!mainId) return "";
      return targets.some(t => t.id === mainId) ? mainId : "";
    }
    return raw;
  }
  const MULTI = "__multi__";
  const targets = [{ id: "t1" }];
  // 同期後: PC も mob も '' → effective ''
  assert.equal(eff("", "", MULTI, null, targets), "");
  // 未同期の旧バグ再現（mob に古い値）: pcVal||mobVal で stale が返っていた
  assert.equal(eff("", "t1", MULTI, null, targets), "t1"); // ← 同期しないと stale（バグ）
  // 正常単一選択は不変
  assert.equal(eff("t1", "t1", MULTI, null, targets), "t1");
  // MULTI main 現存 → 復元
  assert.equal(eff(MULTI, MULTI, MULTI, { main: "t1" }, targets), "t1");
  // MULTI main 削除済み → ''（dangling を返さない）
  assert.equal(eff(MULTI, MULTI, MULTI, { main: "tX" }, targets), "");
});

/* ---------- source: 青丸/GoogleMap/編集が effective target 経由（stale を見ない） ---------- */
test("[target-clear] 青丸は refreshMapMarkers が getEffectiveTargetId で描画（未選択で描かない）", () => {
  const fn = funcBody(html, "refreshMapMarkers");
  assert.match(fn, /if\(targetMarker\)\{map\.removeLayer\(targetMarker\);targetMarker=null;\}/, "既存 targetMarker を毎回削除");
  assert.match(fn, /const tid = getEffectiveTargetId\(\)/, "effective で判定");
  assert.match(fn, /if\(tid\)\{[\s\S]*db\.targets\.find/, "tid ありのときだけ対象を探して描画");
});
test("[target-clear] Google Map（対象）は effective target の座標のみ（未選択で null）", () => {
  const fn = funcBody(html, "_hanabiSelectedTarget");
  assert.match(fn, /const tid = getEffectiveTargetId\(\)/, "effective 経由");
  assert.match(fn, /if\(!tid\) return null/, "未選択で null（Google Map 無効）");
});
test("[target-clear] 編集は effective target のみ開く（未選択/不存在で開かない）", () => {
  const fn = funcBody(html, "openEditTarget");
  assert.match(fn, /const tid = getEffectiveTargetId\(\)/, "effective 経由");
  assert.match(fn, /if\(!tid\) return/, "未選択で開かない");
  assert.match(fn, /db\.targets\.find\(x=>x\.id===tid\)[\s\S]*if\(!tg\) return/, "不存在で開かない");
});

/* ---------- 正常系は不変 ---------- */
test("[target-normal] 正常な単一選択・複数選択の effective は従来どおり", () => {
  const fn = funcBody(html, "getEffectiveTargetId");
  // 単一: raw をそのまま返す
  assert.match(fn, /return raw;/, "単一選択は raw を返す");
  // 複数: main 現存で main を返す
  assert.match(fn, /return\s*\(db\.targets\.some\(t=>t\.id===mainId\)\)\s*\?\s*mainId\s*:\s*'';/, "複数は main 現存で返す");
});
