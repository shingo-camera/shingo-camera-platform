/**
 * Rev4 性能改善の回帰固定: camera/framing-only 操作で不要な scene request を発火しない。
 *
 * 根本原因（実測）: scene-solve の結果は camera（focal/sensor/compMode/azOffset/elOffset）に
 * 依存しない（server scene.ts は camera を計算に使わない。framing は client 側で適用）。
 * にもかかわらず scene key に camera が含まれていたため、上下左右・拡大縮小・焦点距離など
 * framing のみの操作で key が変わり、同一の scene 結果を返すだけの /scene-solve が再発火していた。
 *
 * 修正: _sceneKey は camera を除外して JSON 化する。計算結果は不変（camera は結果に影響しない）。
 * この test は「camera だけ異なる 2 payload の key が一致し、それ以外が異なれば key も異なる」ことを固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, "../public/apps/hanabi/index.html"), "utf8");

function funcSrc(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

const sceneKeySrc = funcSrc(html, "_sceneKey");
// eslint-disable-next-line no-new-func
const _sceneKey = new Function(sceneKeySrc + "\nreturn _sceneKey;")();

const basePayload = {
  viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
  camera: { focal: 50, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
  festivalTubes: [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, nums: ["5"], enabled: true }],
  targets: [], numTable: [{ num: "5", height: 224, dia: 170, riseTime: 6.76, windFollowRatio: 0.85 }],
  selectedTubeId: "T1", targetId: null, subTargetIds: [], wind: null, ougiHeight: 90,
};

test("[perf] _sceneKey が存在し関数として評価できる", () => {
  assert.ok(sceneKeySrc, "_sceneKey 抽出");
  assert.equal(typeof _sceneKey, "function");
});

test("[perf] camera だけ異なる payload は同一 scene key（framing-only は再計算しない）", () => {
  const focalChanged = { ...basePayload, camera: { ...basePayload.camera, focal: 400 } };
  const azOffChanged = { ...basePayload, camera: { ...basePayload.camera, azOffset: 5 } };   // 左右
  const elOffChanged = { ...basePayload, camera: { ...basePayload.camera, elOffset: -3 } };  // 上下
  const compChanged = { ...basePayload, camera: { ...basePayload.camera, compMode: "port" } }; // 縦横
  const sensorChanged = { ...basePayload, camera: { ...basePayload.camera, sensor: { w: 23.5, h: 15.6 } } }; // 拡大縮小/センサ
  const k = _sceneKey(basePayload);
  assert.equal(_sceneKey(focalChanged), k, "焦点距離変更で key 不変");
  assert.equal(_sceneKey(azOffChanged), k, "左右(azOffset)変更で key 不変");
  assert.equal(_sceneKey(elOffChanged), k, "上下(elOffset)変更で key 不変");
  assert.equal(_sceneKey(compChanged), k, "compMode 変更で key 不変");
  assert.equal(_sceneKey(sensorChanged), k, "sensor 変更で key 不変");
});

test("[perf] scene 結果に影響する入力が変われば key も変わる（cache 誤用しない）", () => {
  const k = _sceneKey(basePayload);
  // viewpoint（撮影地点）
  assert.notEqual(_sceneKey({ ...basePayload, viewpoint: { ...basePayload.viewpoint, lat: 34.69 } }), k, "撮影地点変更で key 変化");
  // 筒場
  assert.notEqual(_sceneKey({ ...basePayload, festivalTubes: [{ ...basePayload.festivalTubes[0], lat: 34.71 }] }), k, "筒場変更で key 変化");
  // 選択筒場
  assert.notEqual(_sceneKey({ ...basePayload, selectedTubeId: "T2" }), k, "選択筒場変更で key 変化");
  // 風
  assert.notEqual(_sceneKey({ ...basePayload, wind: { dirDeg: 45, speed: 8 } }), k, "風変更で key 変化");
  // 対象
  assert.notEqual(_sceneKey({ ...basePayload, targetId: "G1" }), k, "対象変更で key 変化");
  // numTable（花火諸元）
  assert.notEqual(_sceneKey({ ...basePayload, numTable: [{ ...basePayload.numTable[0], height: 300 }] }), k, "号数諸元変更で key 変化");
  // ougiHeight
  assert.notEqual(_sceneKey({ ...basePayload, ougiHeight: 120 }), k, "扇高さ変更で key 変化");
});

test("[perf] null payload は null key", () => {
  assert.equal(_sceneKey(null), null);
});
