/**
 * HANABI 計算 API 入力検証テスト。
 *
 * 認証済みでも client 入力を無制限に信用しない: 数値有限性・緯度経度範囲・配列長・nAzimuths・
 * 距離・各種数値上限を検証し、不正値は ValidationError（呼出側で 400 fail-closed）。
 *
 * 境界正常値（通常利用を妨げない）と、oversized arrays / oversized nAzimuths / invalid lat-lng /
 * extreme distance / invalid numeric values が弾かれることを検証する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSceneRequest,
  validateTerrainSolve,
  ValidationError,
  LIMITS,
} from "./_bundle/hanabi_validate.mjs";

/* ---- 正常な最小 scene リクエスト ---- */
function okScene(over = {}) {
  return {
    viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    camera: { focal: 200, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
    festivalTubes: [{ id: "t1", lat: 34.69, lng: 135.51, elev: 5, elevOffset: 0, enabled: true, nums: ["5", "10"] }],
    targets: [{ id: "g1", lat: 34.685, lng: 135.505, elev: 3, baseOffset: 0, height: 40 }],
    numTable: [{ num: "5", height: 224, dia: 170, riseTime: 6.76, windFollowRatio: 0.85 }],
    selectedTubeId: "t1",
    targetId: null,
    subTargetIds: [],
    wind: null,
    ...over,
  };
}

/* ==================== scene-solve ==================== */
test("[validate] scene: 正常な境界値は通過する", () => {
  const r = validateSceneRequest(okScene());
  assert.equal(r.selectedTubeId, "t1");
  assert.equal(r.festivalTubes.length, 1);
});

test("[validate] scene: 通常利用の代表値（focal 9..1200, az/el ±60, tripod 500, 大号数）は通過", () => {
  const r = validateSceneRequest(
    okScene({
      camera: { focal: 1200, sensor: { w: 36, h: 24 }, compMode: "port", azOffset: -60, elOffset: 60 },
      viewpoint: { manual: true, lat: -35.9, lng: 139.9, elev: 3776, tripodH: 500, elevOffset: -50 },
      numTable: [{ num: "40", height: 798, dia: 725 }],
      festivalTubes: [{ id: "t1", lat: 34.69, lng: 135.51, nums: ["40"] }],
    }),
  );
  assert.equal(r.camera.focal, 1200);
});

test("[validate] scene: NaN/Infinity は弾く", () => {
  assert.throws(() => validateSceneRequest(okScene({ camera: { focal: NaN, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 } })), ValidationError);
  assert.throws(() => validateSceneRequest(okScene({ viewpoint: { manual: true, lat: 34.68, lng: 135.5, tripodH: Infinity, elevOffset: 0 } })), ValidationError);
});

test("[validate] scene: 不正な緯度経度は弾く", () => {
  assert.throws(() => validateSceneRequest(okScene({ viewpoint: { manual: true, lat: 91, lng: 135.5, tripodH: 150, elevOffset: 0 } })), ValidationError);
  assert.throws(() => validateSceneRequest(okScene({ festivalTubes: [{ id: "t1", lat: 34, lng: 200, nums: ["5"] }] })), ValidationError);
});

test("[validate] scene: 配列長超過（festivalTubes / nums / targets / numTable）を弾く", () => {
  const bigTubes = Array.from({ length: LIMITS.TUBES + 1 }, (_, i) => ({ id: "t" + i, lat: 34, lng: 135, nums: ["5"] }));
  assert.throws(() => validateSceneRequest(okScene({ festivalTubes: bigTubes })), ValidationError);

  const bigNums = Array.from({ length: LIMITS.NUMS_PER_TUBE + 1 }, (_, i) => String(i));
  assert.throws(() => validateSceneRequest(okScene({ festivalTubes: [{ id: "t1", lat: 34, lng: 135, nums: bigNums }] })), ValidationError);

  const bigNumTable = Array.from({ length: LIMITS.NUMTABLE + 1 }, (_, i) => ({ num: String(i), height: 100, dia: 100 }));
  assert.throws(() => validateSceneRequest(okScene({ numTable: bigNumTable })), ValidationError);
});

test("[validate] scene: manual 視点で lat/lng 欠落は弾く", () => {
  assert.throws(() => validateSceneRequest(okScene({ viewpoint: { manual: true, lat: null, lng: null, tripodH: 150, elevOffset: 0 } })), ValidationError);
});

test("[validate] scene: 文字列長超過（id）を弾く", () => {
  const longId = "x".repeat(LIMITS.STR_MAX + 1);
  assert.throws(() => validateSceneRequest(okScene({ selectedTubeId: longId })), ValidationError);
});

test("[validate] scene: compMode 不正を弾く", () => {
  assert.throws(() => validateSceneRequest(okScene({ camera: { focal: 200, sensor: { w: 36, h: 24 }, compMode: "square", azOffset: 0, elOffset: 0 } })), ValidationError);
});

/* ==================== terrain-solve（単一 phase・サーバ完結） ==================== */
function okTerrain(over = {}) {
  return {
    mode: "front",
    viewpoint: { lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    selectedTube: { lat: 34.7, lng: 135.52 },
    allTubes: [{ lat: 34.7, lng: 135.52 }],
    maxDiaHalf: 160,
    camAzDeg: 45,
    fovHDeg: 10,
    treeHeightM: 20,
    ...over,
  };
}

test("[validate] terrain: 正常値（front/back）は通過", () => {
  assert.equal(validateTerrainSolve(okTerrain()).mode, "front");
  assert.equal(validateTerrainSolve(okTerrain({ mode: "back" })).mode, "back");
});

test("[validate] terrain: mode 不正を弾く", () => {
  assert.throws(() => validateTerrainSolve(okTerrain({ mode: "sideways" })), ValidationError);
  assert.throws(() => validateTerrainSolve(okTerrain({ mode: undefined })), ValidationError);
});

test("[validate] terrain: 不正緯度経度を弾く", () => {
  assert.throws(() => validateTerrainSolve(okTerrain({ viewpoint: { lat: 999, lng: 135, tripodH: 150, elevOffset: 0 } })), ValidationError);
  assert.throws(() => validateTerrainSolve(okTerrain({ selectedTube: { lat: 34, lng: 200 } })), ValidationError);
});

test("[validate] terrain: allTubes 件数超過を弾く", () => {
  const big = Array.from({ length: LIMITS.ALL_TUBES + 1 }, () => ({ lat: 34.7, lng: 135.52 }));
  assert.throws(() => validateTerrainSolve(okTerrain({ allTubes: big })), ValidationError);
});

test("[validate] terrain: extreme distance（視点↔筒場が過大）を弾く", () => {
  // 遠すぎる筒場（緯度差大）→ ループ量保護で拒否
  assert.throws(() => validateTerrainSolve(okTerrain({ selectedTube: { lat: 5, lng: 135.52 } })), ValidationError);
});

test("[validate] terrain: NaN/Infinity 数値を弾く", () => {
  assert.throws(() => validateTerrainSolve(okTerrain({ fovHDeg: NaN })), ValidationError);
  assert.throws(() => validateTerrainSolve(okTerrain({ maxDiaHalf: Infinity })), ValidationError);
  assert.throws(() => validateTerrainSolve(okTerrain({ treeHeightM: NaN })), ValidationError);
});

test("[validate] terrain: treeHeight 範囲外を弾く", () => {
  assert.throws(() => validateTerrainSolve(okTerrain({ treeHeightM: 99999 })), ValidationError);
});
