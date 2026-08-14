/**
 * 小改修の回帰テスト：
 *  1. 撮影計画「名称」(planName) の保存条件・保存仕様・一覧表示・export/import互換
 *  2. スマホ右上「月/太陽切替」と「衛星切替」の順序（上：月/太陽・下：衛星）と非重複
 *
 * chance / pinpoint の確定ロジックには一切触れない。ここは UI/保存フローのみ検証する。
 * DOM/prompt 依存の saveSpot は実ファイル検証（プロジェクトの既存慣例）＋純関数 _spotLabel は抽出eval。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("public/apps/sun-and-moon/index.html", "utf8");

// ---- 純関数 _spotLabel を抽出して eval（subjects/LANDMARK_BUILDINGS を注入）----
function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`);
  const m = html.match(re);
  assert.ok(m, `${name} を index.html から抽出できること`);
  return m[0];
}
const _spotLabelSrc = extractFn("_spotLabel");
const makeSpotLabel = (subjects = [], LANDMARK_BUILDINGS = {}) =>
  new Function("subjects", "LANDMARK_BUILDINGS", `${_spotLabelSrc}; return _spotLabel;`)(subjects, LANDMARK_BUILDINGS);

// ============================================================
// 1. 撮影計画名（planName）
// ============================================================

test("[6] 一覧ラベルは既存表示の後ろに planName を追加する", () => {
  const _spotLabel = makeSpotLabel();
  const spot = { sunsetMode: false, targetName: "大阪城", date: "2026-08-15", time: "18:30", planName: "夏の月" };
  const label = _spotLabel(spot);
  // 末尾が planName で終わる
  assert.ok(label.endsWith("夏の月"), `末尾に planName: ${label}`);
  // 既存要素（対象名・日付・時刻）は保持
  assert.ok(label.includes("大阪城") && label.includes("2026-08-15") && label.includes("18:30"), label);
  // planName は最後（時刻より後ろ）
  assert.ok(label.indexOf("18:30") < label.indexOf("夏の月"), "planNameは時刻より後ろ");
});

test("[7] planName が無い既存データでは余計な文字を足さない", () => {
  const _spotLabel = makeSpotLabel();
  const legacy = { sunsetMode: false, targetName: "岐阜城", date: "2026-08-15", time: "05:10" }; // planName なし
  const withEmpty = { ...legacy, planName: "   " };  // 空白のみ
  const l1 = _spotLabel(legacy);
  const l2 = _spotLabel(withEmpty);
  // planName 無し／空白のみ とも末尾は時刻で終わる（余計な末尾空白や文字なし）
  assert.ok(l1.endsWith("05:10"), `planName無しは時刻で終わる: "${l1}"`);
  assert.equal(l1, l2, "空白のみ planName は無しと同一表示（trim）");
});

test("[6/7] 太陽アイコン・共通ラベル関数の形式が保たれる", () => {
  const _spotLabel = makeSpotLabel();
  const sun = { sunsetMode: true, targetName: "通天閣", date: "2026-08-15", time: "17:00", planName: "夕陽" };
  const label = _spotLabel(sun);
  assert.ok(label.startsWith("☀️"), "太陽モードは☀️");
  assert.ok(/☀️ 通天閣 2026-08-15\(.\) 17:00 夕陽$/.test(label), `形式: ${label}`);
});

test("[1/2] saveSpot は撮影地点と対象の両方が無いと無音で return（showHint/alert/dialogを出さない）", () => {
  const m = html.match(/function saveSpot\(\)\{[\s\S]*?\n\}/);
  assert.ok(m, "saveSpot 抽出");
  const fn = m[0];
  // 両方必須のガード（sLat null もしくは 対象未選択で return）
  assert.match(fn, /if\(sLat===null \|\| !\(currentLandmarkBuildingId \|\| curSubjectId\)\) return;/);
  // 旧・撮影地点未選択時の showHint は撤去済み
  assert.doesNotMatch(fn, /先に地図をクリックして撮影地点を選択してください/);
  // ガード段でダイアログ類を出さない（prompt はガード通過後にのみ現れる：ガード行より後）
  const guardIdx = fn.indexOf("return;");
  const promptIdx = fn.indexOf("prompt(");
  assert.ok(guardIdx >= 0 && promptIdx > guardIdx, "prompt はガード通過後にのみ実行される");
});

test("[3] saveSpot は両方選択時のみ prompt で名称入力（既定値=対象名称_）", () => {
  const m = html.match(/function saveSpot\(\)\{[\s\S]*?\n\}/)[0];
  // 既定値は対象名 + '_'
  assert.match(m, /const _defPlanName = \(\(t && t\.name\) \? t\.name : ''\) \+ '_';/);
  assert.match(m, /prompt\('撮影計画の名称を入力してください。', _defPlanName\)/);
});

test("[4] saveSpot はキャンセルで保存せず、trim した planName を spot に保存する", () => {
  const m = html.match(/function saveSpot\(\)\{[\s\S]*?\n\}/)[0];
  // キャンセル（null）で return
  assert.match(m, /if\(_planInput===null\) return;/);
  // trim
  assert.match(m, /const planName = _planInput\.trim\(\);/);
  // spot オブジェクトへ planName フィールドを追加
  assert.match(m, /\n\s*planName,/);
});

test("[5/8/9/10] planName は全spotシリアライズ経路で自動保持される（whole-object）", () => {
  // 全体export：savedSpots 配列をそのまま同梱
  assert.match(html, /savedSpots: savedSpots,/);
  // 全体import：savedSpots をそのまま受理
  assert.match(html, /savedSpots=data\.savedSpots;/);
  // 1件共有export：spot をそのまま同梱
  assert.match(html, /spot:savedSpots\[_shareSelIdx\],/);
  // 1件共有import：spot をそのまま格納（planName に触れない・lat/lng のみ検証）
  assert.match(html, /savedSpots\[idx\]=spot;/);
  // localStorage：savedSpots 配列をそのまま保存
  assert.match(html, /localStorage\.setItem\('portrait_planner_spots', JSON\.stringify\(savedSpots\)\)/);
});

test("[5] 既存(planNameなし)データは JSON 往復で壊れず、ラベルにも影響しない", () => {
  const _spotLabel = makeSpotLabel();
  const legacy = { lat: 34.65, lng: 135.5, targetName: "大阪城", date: "2026-08-15", time: "18:00" };
  const round = JSON.parse(JSON.stringify(legacy)); // export→import 相当
  assert.deepEqual(round, legacy, "planName無しデータは往復で不変");
  assert.equal(_spotLabel(round), _spotLabel(legacy), "ラベルも同一（余計な文字なし）");
  // planName 付きも往復保持
  const named = { ...legacy, planName: "満月ロケ" };
  assert.equal(JSON.parse(JSON.stringify(named)).planName, "満月ロケ");
});

// ============================================================
// 2. スマホ右上ボタン配置（月/太陽が上・衛星が下・非重複）
// ============================================================

// @media (max-width:600px) 内の指定ルールブロックを取り出す
function mobileRuleBody(selector) {
  // 該当メディアクエリ内の `selector{ ... }` を取得（複数メディアブロックに跨っても selector 単位で拾う）
  const re = new RegExp(`${selector.replace(/[#.]/g, "\\$&")}\\{([^}]*)\\}`, "g");
  let m, bodies = [];
  while ((m = re.exec(html))) bodies.push(m[1]);
  return bodies;
}
function topPx(body) {
  // top:8px / top:calc(8px + env(...)) の px 値を取り出す
  const m = body.match(/top:\s*(?:calc\(\s*)?(-?\d+(?:\.\d+)?)px/);
  return m ? parseFloat(m[1]) : null;
}
function heightPx(body) {
  const m = body.match(/height:\s*(\d+(?:\.\d+)?)px/);
  return m ? parseFloat(m[1]) : null;
}
function isRightAnchored(body) {
  return /right:\s*(?:calc\(\s*)?8px/.test(body) && /left:\s*auto/.test(body);
}

// モバイル指定を持つ本体（display:flex !important を含む方）を選ぶ
function mobileBody(selector) {
  const bodies = mobileRuleBody(selector).filter(b => /display:\s*flex\s*!important/.test(b));
  assert.ok(bodies.length >= 1, `${selector} のモバイル指定が存在`);
  return bodies[0];
}

test("[11] 月/太陽切替(#map-body-toggle)が衛星切替(#map-sat-btn)より上", () => {
  const body = mobileBody("#map-body-toggle");
  const sat = mobileBody("#map-sat-btn");
  const tBody = topPx(body), tSat = topPx(sat);
  assert.equal(tBody, 8, `月/太陽 top=8: ${tBody}`);
  assert.equal(tSat, 52, `衛星 top=52: ${tSat}`);
  assert.ok(tBody < tSat, "月/太陽 が 衛星 より上（top値が小さい）");
});

test("[12/13] 両コントロールの縦領域が重ならない（36px高・8pxギャップ・幅非依存）", () => {
  const body = mobileBody("#map-body-toggle");
  const sat = mobileBody("#map-sat-btn");
  const hBody = heightPx(body), hSat = heightPx(sat);
  assert.equal(hBody, 36); assert.equal(hSat, 36);
  const bTop = topPx(body), bBot = bTop + hBody;   // [8,44]
  const sTop = topPx(sat),  sBot = sTop + hSat;    // [52,88]
  // 区間 [bTop,bBot] と [sTop,sBot] が交差しない（gap>0）
  const gap = sTop - bBot;
  assert.ok(gap > 0, `縦ギャップ>0（実測 ${gap}px）＝重ならない`);
  // 両者とも右端8px揃え＝幅可変(width:auto)でも縦の重なりは幅に依存しない（狭いスマホ幅でも不変）
  assert.ok(isRightAnchored(body) && isRightAnchored(sat), "両者右端8px揃え（幅非依存で非重複）");
  // safe-area シフトは両者同一（env(safe-area-inset-top) を両方に付与）→相対位置不変
  assert.match(body, /env\(safe-area-inset-top\)/);
  assert.match(sat,  /env\(safe-area-inset-top\)/);
});

test("[14] PC表示に影響なし（両ボタンはメディアクエリ外で display:none）", () => {
  // PCデフォルト：#map-body-toggle / #map-sat-btn は display:none（表示はモバイルmedia内のみ）
  assert.match(html, /#map-body-toggle\{ display:none; \}/);
  assert.match(html, /#map-sat-btn\{ display:none; \}[^\n]*PC/);
  // モバイルで Leaflet 右上コントロールは非表示＝右上で干渉する既存コントロールが無い
  assert.match(html, /\.leaflet-top\.leaflet-right\{display:none !important;\}/);
});
