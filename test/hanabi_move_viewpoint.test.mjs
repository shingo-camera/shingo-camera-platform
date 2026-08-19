/**
 * Rev4 §16: HANABI 移動モードに撮影地点を追加。
 *
 * 撮影地点マーカー（key='view:'）を移動モードで表示・ドラッグ可能にし、確定時は
 * 既存の撮影地点変更処理（onViewPick 経由・viewManual=true・地形破棄・標高再取得）へ接続する。
 * これにより移動モード経由でも計算結果は通常の撮影地点設定と一致する（server scene-solve は同一入力）。
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

const build = funcBody(html, "buildMoveMarkers");
const commit = funcBody(html, "commitMoveMode");

test("[move] buildMoveMarkers が撮影地点マーカー（view:）を追加する", () => {
  assert.ok(build, "buildMoveMarkers 抽出");
  assert.match(build, /['"]view:['"]/, "view: キーのマーカーがある");
  assert.match(build, /viewLat!==null\s*&&\s*viewLng!==null/, "撮影地点が設定済みの時のみ表示");
  // ドラッグ可能（startMoveDrag に接続）
  assert.match(build, /'view:'[\s\S]*?startMoveDrag/, "view: マーカーが startMoveDrag に接続");
});

test("[move][§16] commitMoveMode が view: を既存の撮影地点変更処理へ接続する", () => {
  assert.ok(commit, "commitMoveMode 抽出");
  assert.match(commit, /k===\s*['"]view:['"]/, "view: キーを処理");
  // 通常の撮影地点変更と同一状態遷移
  assert.match(commit, /viewLat\s*=\s*lat;\s*viewLng\s*=\s*lng;\s*viewManual\s*=\s*true/, "viewManual=true で撮影地点更新");
  assert.match(commit, /_currentViewPin\s*=\s*null/, "ピン由来を解除");
  assert.match(commit, /gTerrainProfile\s*=\s*null/, "地形プロファイルを破棄");
  // 確定後に onViewPick（通常経路）を通す
  assert.match(commit, /onViewPick\(\)/, "onViewPick で通常経路の標高取得・再計算");
});

test("[move][§16] 撮影地点は tube/target と独立に扱う（DB 座標を書かない）", () => {
  // view: は db.tubes/db.targets を更新しない（撮影地点は db ではなく viewLat/viewLng 状態）
  const viewBranch = commit.split("k==='view:'")[1] || commit.split('k==="view:"')[1] || "";
  assert.doesNotMatch(viewBranch.split("}")[0] || "", /db\.tubes|db\.targets/, "view: 分岐で db 座標を書かない");
});
