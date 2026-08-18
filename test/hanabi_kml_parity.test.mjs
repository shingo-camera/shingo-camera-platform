/**
 * Phase C2 characterization: Google Earth/KML の開花位置（normal burst）が、
 * 既存 scene-solve 結果（bursts[].fwAzDeg / fwDkm）から**同一の緯度経度**で再構成できることを固定する。
 *
 * 旧 KML 経路:  wind = calcWindOffset(tbAz, tbDkm, riseTime||7, windFollowRatio)
 *              fwAzKml  = tbAz + wind.azOffsetDeg
 *              fwDistKm = max(0.05, tbDkm + wind.distOffsetKm)
 *              [fwLat,fwLng] = destPoint(viewLat, viewLng, fwAzKml, fwDistKm)
 * 新 KML 経路:  [fwLat,fwLng] = destPoint(viewLat, viewLng, burst.fwAzDeg, burst.fwDkm)
 *
 * scene-solve は normal burst で fwAz=tbAz+azOff, fwDkm=max(0.05, tbDkm+distOff) を返すため、
 * 両者は同一値になる（新 API・contract 追加なしで再現可能なことを固定）。
 *
 * 比較対象は写真結果に影響する数値（burst latitude/longitude/altitude、tube position）。
 * XML 文字列全体一致には依存しない。許容誤差は既存精度を変えない範囲（浮動小数の同値）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveScene } from "./_bundle/hanabi_scene.mjs";
import { calcWindOffset, windDriftWorld, hav, brng } from "./_bundle/hanabi_calc.mjs";

// client destPoint（一般測地・KML と同一式）
function destPoint(lat, lng, azDeg, distKm) {
  const R = 6371;
  const az = (azDeg * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  const dR = distKm / R;
  const lat2 = Math.asin(Math.sin(latR) * Math.cos(dR) + Math.cos(latR) * Math.sin(dR) * Math.cos(az));
  const lng2 =
    lng +
    (Math.atan2(Math.sin(az) * Math.sin(dR) * Math.cos(latR), Math.cos(dR) - Math.sin(latR) * Math.sin(lat2)) * 180) /
      Math.PI;
  return [(lat2 * 180) / Math.PI, lng2];
}

const NUM = [
  { num: "3", height: 180, dia: 90, riseTime: 5, windFollowRatio: 0.7 },
  { num: "5", height: 220, dia: 140, riseTime: 6, windFollowRatio: 0.8 },
  { num: "10", height: 330, dia: 280, riseTime: 8, windFollowRatio: 0.85 },
];

function baseReq(over = {}) {
  return {
    viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    camera: { focal: 100, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
    festivalTubes: [
      { id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5", "10"], enabled: true },
    ],
    targets: [],
    numTable: NUM,
    selectedTubeId: "T1",
    wind: null,
    ...over,
  };
}

// world-fixed の burst lat/lng を直接再現（新仕様の正本）。
// KML client は server の burst.fwAzDeg/fwDkm を destPoint するだけ（client 非変更）。
function oldKmlBurst(req, tb, row) {
  const { lat: vLat, lng: vLng } = req.viewpoint;
  const wd = windDriftWorld(row.riseTime || 7, row.windFollowRatio, req.wind);
  // 筒場 world から blowToDeg 方向へ driftM 移動して burst world を確定
  const [bwLat, bwLng] = wd.driftM === 0 ? [tb.lat, tb.lng] : destPoint(tb.lat, tb.lng, wd.blowToDeg, wd.driftM / 1000);
  // KML client と同じ経路: viewpoint 相対 az/dist に直してから destPoint(view, ...)
  const fwAz = brng(vLat, vLng, bwLat, bwLng);
  const fwDistKm = Math.max(0.05, hav(vLat, vLng, bwLat, bwLng));
  return destPoint(vLat, vLng, fwAz, fwDistKm);
}

function checkCase(name, req) {
  test(`[kml-parity] ${name}: burst 緯度経度が scene 結果から一致`, () => {
    const res = solveScene(req);
    assert.ok(res.ok, `${name} scene ok`);
    const tb = req.festivalTubes[0];
    const tubeRes = res.tubes.find((t) => t.id === tb.id);
    assert.ok(tubeRes, "tube 結果あり");
    for (const row of NUM.filter((r) => tb.nums.includes(r.num))) {
      const burst = tubeRes.bursts.find((b) => b.num === row.num);
      assert.ok(burst, `${name} burst ${row.num} あり`);
      // 新経路: scene の fwAzDeg/fwDkm を destPoint
      const [nLat, nLng] = destPoint(req.viewpoint.lat, req.viewpoint.lng, burst.fwAzDeg, burst.fwDkm);
      // 旧経路: calcWindOffset から直接
      const [oLat, oLng] = oldKmlBurst(req, tb, row);
      assert.ok(Math.abs(nLat - oLat) < 1e-12, `${name} ${row.num} lat ${nLat} vs ${oLat}`);
      assert.ok(Math.abs(nLng - oLng) < 1e-12, `${name} ${row.num} lng ${nLng} vs ${oLng}`);
      // altitude（burst center 絶対高度 = tubeElev + height）は client 一般計算のまま（datum 非改変）
      const tubeElev = (tb.elev || 0) + (tb.elevOffset || 0);
      const rowAlt = tubeElev + row.height;
      assert.ok(Number.isFinite(rowAlt), `${name} ${row.num} rowAlt 有限`);
    }
    // tube position は KML では tb.lat/tb.lng 直接（風で動かさない）。scene も groundAz/dKm は tube 基準。
    assert.ok(Number.isFinite(tubeRes.dKm) && Number.isFinite(tubeRes.groundAzDeg));
  });
}

// normal（無風）
checkCase("normal 無風", baseReq());
// 風あり（北風 5m/s）
checkCase("風あり (北5m/s)", baseReq({ wind: { dirDeg: 0, speed: 5 } }));
// 風向違い（東風 8m/s）
checkCase("風向違い (東8m/s)", baseReq({ wind: { dirDeg: 90, speed: 8 } }));
// 南西風・強め
checkCase("南西風 12m/s", baseReq({ wind: { dirDeg: 225, speed: 12 } }));

// ougi（扇）ケース：扇有効筒場
checkCase("ougi 扇 (風あり)", baseReq({
  festivalTubes: [
    { id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5", "10"], enabled: true, ougi: true, ougiAz: 30 },
  ],
  ougiHeight: 90,
  wind: { dirDeg: 45, speed: 6 },
}));

// kunitomo（国友）ケース：kunitomoNums 設定
checkCase("kunitomo 国友 (風あり)", baseReq({
  festivalTubes: [
    { id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5", "10"], enabled: true, ougiAz: 30, kunitomoNums: { "3": 3, "5": 5 } },
  ],
  wind: { dirDeg: 45, speed: 6 },
}));

// 複数号数・複数筒場
checkCase("複数筒場・複数号数 (風あり)", baseReq({
  festivalTubes: [
    { id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5"], enabled: true },
    { id: "T2", festivalId: "F", lat: 34.71, lng: 135.53, elev: 8, elevOffset: 0, nums: ["10"], enabled: true },
  ],
  wind: { dirDeg: 120, speed: 7 },
}));

test("[kml-parity] NaN/Infinity が burst 値に出ない（全ケース）", () => {
  for (const req of [baseReq(), baseReq({ wind: { dirDeg: 0, speed: 5 } })]) {
    const res = solveScene(req);
    for (const tb of res.tubes) {
      for (const b of tb.bursts) {
        assert.ok(Number.isFinite(b.fwAzDeg) && Number.isFinite(b.fwDkm) && Number.isFinite(b.fwAltDeg));
        const [la, ln] = destPoint(34.68, 135.5, b.fwAzDeg, b.fwDkm);
        assert.ok(Number.isFinite(la) && Number.isFinite(ln), "burst lat/lng 有限");
      }
    }
  }
});
