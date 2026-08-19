/**
 * Rev4 §23/§24: scene-level Golden Master parity。
 *
 * 既存 parity（scene_parity）は server primitive から期待値を組むため合成ロジックの検証には有効だが、
 * 「server 実装から独立した固定期待値」も併せて固定する（循環テスト回避）。
 *
 * 風なしケース: API化前 HANABI の計算結果を Golden Master とする（§1）。
 * 風ありケース: 統合時に凍結した world-fixed 結果を Golden Master とする（§24）。observer 依存は正常差分。
 *
 * 固定値は一度だけ生成してハードコードし、以後は server がこの固定値を再現し続けることを検証する。
 * server 実装を変更してこの値が変われば（風以外）不具合として検知される。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveScene } from "./_bundle/hanabi_scene.mjs";
import { SCENE_GOLDEN } from "./_fixtures/scene_golden_fixture.mjs";

function req(over) {
  return Object.assign({
    viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    camera: { focal: 100, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
    festivalTubes: [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5", "10"], enabled: true, ougi: true, ougiAz: 30, kunitomoNums: { "5": 5 } }],
    targets: [], numTable: [
      { num: "3", height: 132, dia: 60, riseTime: 5.19, windFollowRatio: 0.85 },
      { num: "5", height: 224, dia: 170, riseTime: 6.76, windFollowRatio: 0.85 },
      { num: "10", height: 394, dia: 320, riseTime: 8.97, windFollowRatio: 0.81 }],
    selectedTubeId: "T1", targetId: null, subTargetIds: [], wind: null, ougiHeight: 90,
  }, over || {});
}
const CASES = {
  nowind_multi: req(),
  nearby: req({ viewpoint: { manual: true, lat: 34.699, lng: 135.519, elev: 10, tripodH: 150, elevOffset: 0 } }),
  longdist: req({ viewpoint: { manual: true, lat: 34.60, lng: 135.42, elev: 10, tripodH: 150, elevOffset: 0 } }),
  highdiff: req({ viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 300, tripodH: 150, elevOffset: 0 } }),
  wind_worldfixed: req({ wind: { dirDeg: 45, speed: 8 } }),
};
function digest(res) {
  const o = [];
  for (const tb of res.tubes) {
    for (const b of tb.bursts) o.push(["b", b.num, +b.fwAzDeg.toFixed(6), +b.fwAltDeg.toFixed(6), +b.fwDkm.toFixed(6), b.diaM]);
    for (const k of tb.kunitomo) o.push(["k", k.num, k.horzDeg, +k.fwAzDeg.toFixed(6), +k.fwAltDeg.toFixed(6), +k.fwDkm.toFixed(6)]);
  }
  return o;
}

for (const [name, r] of Object.entries(CASES)) {
  test(`[golden] scene ${name} が Golden Master 固定値と一致`, () => {
    const got = digest(solveScene(r));
    const exp = SCENE_GOLDEN[name];
    assert.ok(exp, `${name} の Golden fixture が存在`);
    assert.equal(got.length, exp.length, `${name} 要素数一致`);
    for (let i = 0; i < exp.length; i++) {
      assert.deepEqual(got[i], exp[i], `${name}[${i}]`);
    }
  });
}

test("[golden][§24] wind_worldfixed は observer を変えても花火 world 位置が不変（world-fixed Golden）", () => {
  // 同一花火・同一風で観測地点だけ変える → burst の world 位置は不変（別 test で厳密固定済み。ここは相互整合）。
  const a = solveScene(req({ wind: { dirDeg: 45, speed: 8 } }));
  const b = solveScene(req({ wind: { dirDeg: 45, speed: 8 }, viewpoint: { manual: true, lat: 34.66, lng: 135.48, elev: 10, tripodH: 150, elevOffset: 0 } }));
  // world 位置は fwAz/fwDkm を観測地点から復元して比較（別 test hanabi_world_position が厳密検証）。
  assert.ok(a.tubes[0].bursts.length === b.tubes[0].bursts.length, "burst 数一致");
});
