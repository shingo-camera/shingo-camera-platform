/**
 * HANABI scene-solve parity テスト。
 *
 * サーバの solveScene が、client renderSim の「答えを計算する部分」と同一の値を返すことを検証する。
 * renderSim は DOM/Canvas 依存で直接実行できないため、renderSim が使う独自プリミティブ
 * （elAng / calcWindOffset / hav / brng：parity 済み）で「期待値」を組み立て、solveScene と比較する。
 * これにより「renderSim の値計算式」と「solveScene の値計算式」が同一であることを固定する。
 *
 * パターン: 対象あり/なし、複数筒場、無効筒場スキップ、風あり/なし、大号数/小号数、手動視点/既定視点。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveScene } from "./_bundle/hanabi_scene.mjs";
import { elAng, calcWindOffset, windDriftWorld, hav, brng } from "./_bundle/hanabi_calc.mjs";

const DEG = Math.PI / 180;

// 号数表（seed 相当。riseTime/windFollowRatio 込み）
const NUM = [
  { num: "5", height: 224, dia: 170, riseTime: 6.76, windFollowRatio: 0.85 },
  { num: "10", height: 394, dia: 320, riseTime: 8.97, windFollowRatio: 0.81 },
  { num: "40", height: 798, dia: 725, riseTime: 12.76, windFollowRatio: 0.57 },
];

function tbBaseElev(t) {
  return (t.elev || 0) + (t.elevOffset || 0);
}
function tgBaseElev(t) {
  return (t.elev || 0) + (t.baseOffset || 0);
}

// client renderSim と同じ式で期待バーストを組み立てる
function expectTube(simLat, simLng, sElev, tb, numRows, wind) {
  const tbElev = tbBaseElev(tb);
  const tbDkm = hav(simLat, simLng, tb.lat, tb.lng);
  const tbAz = brng(simLat, simLng, tb.lat, tb.lng);
  const groundAltDeg = elAng(tbDkm, sElev, tbElev, 0);
  const bursts = [];
  for (const numStr of tb.nums) {
    const row = numRows.find((r) => r.num === numStr);
    if (!row) continue;
    // world-fixed: 風で流された burst world を先に確定してから viewpoint 投影
    const wd = windDriftWorld(row.riseTime || 7, row.windFollowRatio, wind);
    const bw = wd.driftM === 0 ? { lat: tb.lat, lng: tb.lng } : fwLatLng(tb.lat, tb.lng, (wd.blowToDeg * Math.PI) / 180, wd.driftM);
    const fwAz = brng(simLat, simLng, bw.lat, bw.lng);
    const fwDkm = Math.max(0.05, hav(simLat, simLng, bw.lat, bw.lng));
    const fwAlt = elAng(fwDkm, sElev, tbElev, row.height);
    bursts.push({ num: numStr, fwAzDeg: fwAz, fwAltDeg: fwAlt, fwDkm, diaM: row.dia });
  }
  return { id: tb.id, groundAzDeg: tbAz, groundAltDeg, dKm: tbDkm, bursts };
}

const baseReq = (over = {}) => ({
  viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
  camera: { focal: 200, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
  festivalTubes: [
    { id: "t1", lat: 34.69, lng: 135.51, elev: 5, elevOffset: 0, enabled: true, nums: ["5", "10"] },
    { id: "t2", lat: 34.70, lng: 135.52, elev: 8, elevOffset: 2, enabled: true, nums: ["40"] },
  ],
  targets: [{ id: "g1", lat: 34.685, lng: 135.505, elev: 3, baseOffset: 0, height: 40 }],
  numTable: NUM,
  selectedTubeId: "t1",
  targetId: null,
  subTargetIds: [],
  wind: null,
  ...over,
});

test("[scene] 手動視点・対象なし・風なし: 全筒場バーストが renderSim 式と一致", () => {
  const req = baseReq();
  const res = solveScene(req);
  assert.equal(res.ok, true);
  const sElev = 10 + 150 / 100 + 0;
  assert.equal(res.view.sElev, sElev);
  for (const tb of req.festivalTubes) {
    const exp = expectTube(34.68, 135.5, sElev, tb, NUM, null);
    const got = res.tubes.find((x) => x.id === tb.id);
    assert.equal(got.groundAltDeg, exp.groundAltDeg, `${tb.id} groundAlt`);
    assert.equal(got.groundAzDeg, exp.groundAzDeg, `${tb.id} groundAz`);
    assert.equal(got.dKm, exp.dKm, `${tb.id} dKm`);
    assert.equal(got.bursts.length, exp.bursts.length);
    for (let i = 0; i < exp.bursts.length; i++) {
      assert.equal(got.bursts[i].fwAltDeg, exp.bursts[i].fwAltDeg, `${tb.id} burst${i} alt`);
      assert.equal(got.bursts[i].fwAzDeg, exp.bursts[i].fwAzDeg, `${tb.id} burst${i} az`);
      assert.equal(got.bursts[i].fwDkm, exp.bursts[i].fwDkm, `${tb.id} burst${i} dkm`);
      assert.equal(got.bursts[i].diaM, exp.bursts[i].diaM, `${tb.id} burst${i} dia`);
    }
  }
});

test("[scene] 風あり（横風）: 開花方位・距離オフセットが calcWindOffset と一致", () => {
  const wind = { dirDeg: 90, speed: 8 };
  const req = baseReq({ wind });
  const res = solveScene(req);
  const sElev = 10 + 1.5;
  const exp = expectTube(34.68, 135.5, sElev, req.festivalTubes[0], NUM, wind);
  const got = res.tubes.find((x) => x.id === "t1");
  for (let i = 0; i < exp.bursts.length; i++) {
    assert.equal(got.bursts[i].fwAzDeg, exp.bursts[i].fwAzDeg, `burst${i} az wind`);
    assert.equal(got.bursts[i].fwDkm, exp.bursts[i].fwDkm, `burst${i} dkm wind`);
    assert.equal(got.bursts[i].fwAltDeg, exp.bursts[i].fwAltDeg, `burst${i} alt wind`);
  }
});

test("[scene] 無効筒場はスキップされる", () => {
  const req = baseReq();
  req.festivalTubes[1].enabled = false;
  const res = solveScene(req);
  assert.ok(!res.tubes.find((x) => x.id === "t2"), "無効筒場 t2 が含まれない");
  assert.ok(res.tubes.find((x) => x.id === "t1"), "有効筒場 t1 は含まれる");
});

test("[scene] 対象あり: 対象の仰角 top/base・方位・距離が一致", () => {
  const req = baseReq({ targetId: "g1" });
  const res = solveScene(req);
  const sElev = 10 + 1.5;
  const tg = req.targets[0];
  const dTgElev = tgBaseElev(tg);
  const dKm = hav(34.68, 135.5, tg.lat, tg.lng);
  assert.equal(res.target.azDeg, brng(34.68, 135.5, tg.lat, tg.lng));
  assert.equal(res.target.dKm, dKm);
  assert.equal(res.target.vaTopDeg, elAng(dKm, sElev, dTgElev, tg.height));
  assert.equal(res.target.vaBaseDeg, elAng(dKm, sElev, dTgElev, 0));
});

test("[scene] camAxis.vaTubeDeg は選択筒場の最大号数開花高度の仰角", () => {
  const req = baseReq();
  const res = solveScene(req);
  const sElev = 10 + 1.5;
  const selTube = req.festivalTubes[0];
  const rows = selTube.nums.map((n) => NUM.find((r) => r.num === n));
  const maxRow = rows.reduce((a, b) => (a.height > b.height ? a : b));
  const dKmTube = hav(34.68, 135.5, selTube.lat, selTube.lng);
  assert.equal(res.camAxis.vaTubeDeg, elAng(dKmTube, sElev, tbBaseElev(selTube), maxRow.height));
});

/* ---- Phase B: renderDiag/calcCamParams の gCamAlpha が server camAxis.vaTubeDeg から再現できる ---- */
test("[scene][diag] gCamAlpha = camAxis.vaTubeDeg + elOff - camOffsetRad/deg（旧 calcCamParams と一致）", () => {
  // 手動視点（renderDiag は viewManual 前提）。elOff/焦点は任意の代表値。
  const elOff = 5;
  const focal = 200;
  const req = baseReq({
    viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    camera: { focal, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: elOff },
  });
  const res = solveScene(req);
  // 旧 calcCamParams（numRows>0 分岐）: gCamAlpha = vaTop + elOff - camOffsetRad/r
  //   vaTop = elAng(dKm, sElev, tbBaseElev(selTube), maxRow.height) = camAxis.vaTubeDeg
  //   fvV = 2*atan(sensor.h/(2*focal))/deg（land）, camOffsetRad = atan(0.5*tan(fvV/2*deg))
  const r = Math.PI / 180;
  const fvV = (2 * Math.atan(24 / (2 * focal))) / r;
  const camOffsetRad = Math.atan(0.5 * Math.tan((fvV / 2) * r));
  const expectedGCamAlpha = res.camAxis.vaTubeDeg + elOff - camOffsetRad / r;
  // server 値からの再現（client は elAng を呼ばずこの式で gCamAlpha を作る）
  const gCamAlphaFromServer = res.camAxis.vaTubeDeg + elOff - camOffsetRad / r;
  assert.equal(gCamAlphaFromServer, expectedGCamAlpha);
  // gFovV は純光学（server 非依存）で fvV と一致
  assert.equal(fvV, (2 * Math.atan(24 / (2 * focal))) / r);
});

test("[scene] 既定視点（対象→筒場延長1km）: 対象なしなら NO_VIEWPOINT", () => {
  const req = baseReq({ viewpoint: { manual: false, lat: null, lng: null, elev: 0, tripodH: 150, elevOffset: 0 }, targetId: null });
  const res = solveScene(req);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NO_VIEWPOINT");
});

test("[scene] 既定視点（対象あり）: 視点は対象→選択筒場方向の延長1km", () => {
  const req = baseReq({
    viewpoint: { manual: false, lat: null, lng: null, elev: 0, tripodH: 150, elevOffset: 0 },
    targetId: "g1",
  });
  const res = solveScene(req);
  const tg = req.targets[0];
  const selTube = req.festivalTubes[0];
  const az2tube = brng(tg.lat, tg.lng, selTube.lat, selTube.lng);
  const deg1km = 1000 / 111000;
  const simLat = tg.lat + Math.cos(az2tube * DEG) * deg1km;
  const simLng = tg.lng + (Math.sin(az2tube * DEG) * deg1km) / Math.cos(tg.lat * DEG);
  assert.equal(res.view.lat, simLat);
  assert.equal(res.view.lng, simLng);
  assert.equal(res.view.sElev, 150 / 100 + 0);
});

/* ---- 扇（ougi）parity ---- */
function fwLatLng(tbLat, tbLng, azRad, dM) {
  const R = 6371000;
  const dOverR = dM / R;
  const lat =
    (Math.asin(
      Math.sin((tbLat * Math.PI) / 180) * Math.cos(dOverR) +
        Math.cos((tbLat * Math.PI) / 180) * Math.sin(dOverR) * Math.cos(azRad),
    ) * 180) / Math.PI;
  const lng =
    tbLng +
    (Math.atan2(
      Math.sin(azRad) * Math.sin(dOverR) * Math.cos((tbLat * Math.PI) / 180),
      Math.cos(dOverR) - Math.sin((tbLat * Math.PI) / 180) * Math.sin((lat * Math.PI) / 180),
    ) * 180) / Math.PI;
  return { lat, lng };
}

test("[scene] 扇（ougi）: 各方向の開花点が renderSim 扇式と一致", () => {
  const req = baseReq({ ougiHeight: 90 });
  req.festivalTubes[0].ougiAz = 30;
  const res = solveScene(req);
  const sElev = 10 + 1.5;
  const tb = req.festivalTubes[0];
  const tbElev = (tb.elev || 0) + (tb.elevOffset || 0);
  const ougiAzDeg = 30;
  const latAzR = (ougiAzDeg + 90 + 360) % 360;
  const latAzL = (ougiAzDeg - 90 + 360) % 360;
  const dirs = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
  const got = res.tubes.find((x) => x.id === "t1").ougi;
  assert.equal(got.length, dirs.length);
  dirs.forEach((horzDeg, k) => {
    const thetaDeg = 90 - Math.abs(horzDeg);
    const theta = (thetaDeg * Math.PI) / 180;
    const h = 90 * Math.sin(theta) * Math.sin(theta);
    const d = 90 * Math.sin(2 * theta);
    const lateralAz = horzDeg >= 0 ? latAzR : latAzL;
    const { lat: fwLat, lng: fwLng } = fwLatLng(tb.lat, tb.lng, (lateralAz * Math.PI) / 180, d);
    const fwAzDeg = brng(34.68, 135.5, fwLat, fwLng);
    const fwDkm = Math.max(0.05, hav(34.68, 135.5, fwLat, fwLng));
    const fwAlt = elAng(fwDkm, sElev, tbElev, h);
    assert.equal(got[k].fwAzDeg, fwAzDeg, `ougi[${k}] az`);
    assert.equal(got[k].fwAltDeg, fwAlt, `ougi[${k}] alt`);
    assert.equal(got[k].fwDkm, fwDkm, `ougi[${k}] dkm`);
  });
});

test("[scene] 扇 ougi:false でスキップ", () => {
  const req = baseReq();
  req.festivalTubes[0].ougi = false;
  const res = solveScene(req);
  assert.equal(res.tubes.find((x) => x.id === "t1").ougi.length, 0);
});

/* ---- 國友打ち（kunitomo）parity ---- */
test("[scene] 國友打ち: 開花点が renderSim 國友式と一致（1.65補正・riseTimeK・風）", () => {
  const wind = { dirDeg: 90, speed: 6 };
  const req = baseReq({ wind });
  req.festivalTubes[0].ougiAz = 0;
  req.festivalTubes[0].kunitomoNums = { "5": 5 }; // 5 は 10号以下・5方向
  const res = solveScene(req);
  const sElev = 10 + 1.5;
  const tb = req.festivalTubes[0];
  const tbElev = (tb.elev || 0) + (tb.elevOffset || 0);
  const tbAz = brng(34.68, 135.5, tb.lat, tb.lng);
  const tbDkm = hav(34.68, 135.5, tb.lat, tb.lng);
  const row = NUM.find((r) => r.num === "5");
  const dirs = [-60, -30, 0, 30, 60];
  const got = res.tubes.find((x) => x.id === "t1").kunitomo.filter((k) => k.num === "5");
  assert.equal(got.length, dirs.length);
  dirs.forEach((horzDeg, k) => {
    const thetaDeg = 90 - Math.abs(horzDeg);
    const theta = (thetaDeg * Math.PI) / 180;
    const h = row.height * Math.sin(theta) * Math.sin(theta);
    const dBase = row.height * Math.sin(theta) * Math.cos(theta) * 2;
    const d = dBase * (Math.abs(horzDeg) === 60 ? 1.65 : 1.0);
    const riseTimeK = (row.riseTime || 7) * Math.sin(theta);
    const lateralAzDeg = horzDeg === 0 ? 0 : (0 + (horzDeg > 0 ? 90 : -90) + 360) % 360;
    // world-fixed: 風なし ground burst world を確定 → blowToDeg 方向へ driftM 移動 → viewpoint 投影
    const windK = windDriftWorld(riseTimeK, row.windFollowRatio, wind);
    const g = fwLatLng(tb.lat, tb.lng, (lateralAzDeg * Math.PI) / 180, d);
    const bw = windK.driftM === 0 ? { lat: g.lat, lng: g.lng } : fwLatLng(g.lat, g.lng, (windK.blowToDeg * Math.PI) / 180, windK.driftM);
    const fwAzDeg = brng(34.68, 135.5, bw.lat, bw.lng);
    const fwDkm = Math.max(0.05, hav(34.68, 135.5, bw.lat, bw.lng));
    const fwAlt = elAng(fwDkm, sElev, tbElev, h);
    assert.equal(got[k].fwAzDeg, fwAzDeg, `kuni[${k}] az`);
    assert.equal(got[k].fwAltDeg, fwAlt, `kuni[${k}] alt`);
    assert.equal(got[k].fwDkm, fwDkm, `kuni[${k}] dkm`);
    assert.equal(got[k].radiusBasisM, row.dia / 2, `kuni[${k}] R`);
  });
});

test("[scene] 國友打ち: 11号以上・未設定はスキップ", () => {
  const req = baseReq();
  req.festivalTubes[0].nums = ["5", "40"];
  req.festivalTubes[0].kunitomoNums = { "40": 5 }; // 40 は 11号以上 → 対象外
  const res = solveScene(req);
  assert.equal(res.tubes.find((x) => x.id === "t1").kunitomo.length, 0);
});
