/**
 * Rev4 §13/§14/§15: 撮影計画ロードの筒場/対象未選択化・同大会筒場描画。
 *
 * §13 保存筒場が解決できない → 筒場を未選択（前の選択を残さない・別筒場へ代替しない）
 * §14 保存対象が解決できない → 対象を未選択（同上）
 * §15 ロード後、選択に関わらず同一大会の表示対象筒場をすべて描画
 *
 * _applyPlan の実装（source）を検証する。setSel は options に無い値を '' にするため、
 * festival/tube/target を必ず setSel し（undefined でも '' 扱い）、末尾で refreshMapMarkers を
 * 確定的に呼ぶことを固定する。
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

const applyPlan = funcBody(html, "_applyPlan");
const setSelInApply = applyPlan; // setSel は _applyPlan 内のクロージャ

test("[plan] _applyPlan が存在する", () => {
  assert.ok(applyPlan, "_applyPlan 抽出");
});

test("[plan][§13/§14] setSel は options に無い保存値を未選択('')にする（前の選択を残さない）", () => {
  // setSel 定義: ok = options に該当値がある / e.value = ok ? v : ''
  assert.match(setSelInApply, /var\s+ok|const\s+ok|let\s+ok|\bok\s*=/, "ok 判定がある");
  assert.match(setSelInApply, /Array\.from\(e\.options[\s\S]*?some\(/, "options に含まれるか判定");
  assert.match(setSelInApply, /e\.value\s*=\s*ok\s*\?\s*v\s*:\s*['"]{2}/, "解決不能なら '' にする");
});

test("[plan][§13/§14] festival/tube/target を必ず setSel する（undefined でも前選択をクリア）", () => {
  // 旧: if(pin.tubeId!==undefined) setSel(...) だと未保存フィールドで前選択が残る。
  // 新: setSel('sel-tube', pin.tubeId || '') を無条件で呼ぶ。
  assert.match(applyPlan, /setSel\(\s*['"]sel-festival['"]\s*,\s*pin\.festivalId\s*\|\|\s*['"]{2}\s*\)/, "festival を無条件 setSel");
  assert.match(applyPlan, /setSel\(\s*['"]sel-tube['"]\s*,\s*pin\.tubeId\s*\|\|\s*['"]{2}\s*\)/, "tube を無条件 setSel");
  assert.match(applyPlan, /setSel\(\s*['"]sel-target['"]\s*,\s*pin\.targetId\s*\|\|\s*['"]{2}\s*\)/, "target を無条件 setSel");
  // 旧い「!==undefined ガードで setSel をスキップ」経路が festival/tube/target に無いこと
  assert.doesNotMatch(applyPlan, /pin\.tubeId\s*!==\s*undefined\)\s*setSel/, "tubeId の undefined ガードで setSel をスキップしない");
  assert.doesNotMatch(applyPlan, /pin\.targetId\s*!==\s*undefined\)\s*setSel/, "targetId の undefined ガードで setSel をスキップしない");
});

test("[plan][§15] ロード末尾で refreshMapMarkers を呼び、同大会の全筒場を描画する", () => {
  assert.match(applyPlan, /refreshMapMarkers\(\)/, "_applyPlan が refreshMapMarkers を呼ぶ");
});

test("[plan][§15] refreshMapMarkers は選択に関わらず大会配下の全筒場を描画する（既存仕様の確認）", () => {
  const refresh = funcBody(html, "refreshMapMarkers");
  assert.ok(refresh, "refreshMapMarkers 抽出");
  // 大会配下の全筒場を filter して forEach 描画（選択のみに限定しない）
  assert.match(refresh, /db\.tubes\.filter\(\s*t\s*=>\s*t\.festivalId\s*===\s*fid\s*\)/, "同大会の全筒場を対象");
  assert.match(refresh, /forEach\(/, "全筒場を forEach 描画");
  // 選択筒場は大きさ/強調のみに使い、描画対象の絞り込みには使わない
  assert.match(refresh, /isSel\s*=\s*tube\.id\s*===\s*selTubeId/, "選択は強調のみ");
});
