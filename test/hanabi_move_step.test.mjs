/**
 * Rev4: 移動モードの微調整量。撮影地点(view:)を被写体(tg:)と同じ 0.2m にする。
 *   筒場(tube:)を含む選択は 1m（従来どおり）。PC(keydown)・スマホ(mobMoveStep)で同一。
 *   commit/cancel・座標確定・scene/terrain/Golden は不変（step 値のみ変更）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, "../public/apps/hanabi/index.html"), "utf8");

// step 決定ロジック（実コードと同一構造）: 筒場を含めば 1m、含まなければ 0.2m
function stepFor(keys) {
  const hasTube = keys.some(k => k.startsWith("tube:"));
  return hasTube ? 1 : 0.2;
}

test("[step] 撮影地点(view:)のみ → 0.2m", () => {
  assert.equal(stepFor(["view:"]), 0.2);
});
test("[step] 被写体(tg:)のみ → 0.2m（従来仕様を維持）", () => {
  assert.equal(stepFor(["tg:abc"]), 0.2);
});
test("[step] 撮影地点＋対象 → 0.2m（筒場を含まない）", () => {
  assert.equal(stepFor(["view:", "tg:abc"]), 0.2);
});
test("[step] 筒場(tube:)を含む → 1m（従来どおり）", () => {
  assert.equal(stepFor(["tube:x"]), 1);
  assert.equal(stepFor(["tube:x", "tg:y"]), 1);
  assert.equal(stepFor(["tube:x", "view:"]), 1);
});
test("[step] 連続5回で約1m（撮影地点 0.2m×5）", () => {
  const s = stepFor(["view:"]);
  assert.ok(Math.abs(s * 5 - 1.0) < 1e-9, "0.2m×5=1.0m");
});

/* 実コード（PC keydown・スマホ mobMoveStep 両方）に新ロジックが入っていること */
test("[step] PC/スマホ両方に hasTube 判定と 0.2m が入っている", () => {
  const occurrences = [...html.matchAll(/const\s+hasTube\s*=\s*\[\.\.\._moveSelected\]\.some\(k=>k\.startsWith\('tube:'\)\);\s*const\s+stepM\s*=\s*hasTube\s*\?\s*1\s*:\s*0\.2;/g)];
  assert.equal(occurrences.length, 2, "PC・スマホの2箇所に同一ロジック");
});
test("[step] 旧ロジック（allTargets ? 0.2 : 1）が残っていない", () => {
  assert.doesNotMatch(html, /allTargets\s*\?\s*0\.2\s*:\s*1/, "旧 step 分岐は除去");
});
test("[step] 座標式は不変（dlat=stepM/111111・dlng は緯度補正）", () => {
  assert.match(html, /const\s+dlat\s*=\s*stepM\/111111;/, "dlat 式不変");
  assert.match(html, /const\s+dlng\s*=\s*stepM\/\(111111\*Math\.cos\(avgLat\*Math\.PI\/180\)\);/, "dlng 式不変");
});
