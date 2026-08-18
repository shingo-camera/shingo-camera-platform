/**
 * Phase C2 rev2 characterization: 旧 KML kunitomo（国友）の最終結果（lat/lng/alt）を固定する。
 *
 * 旧 KML 仕様（正本・wind 非適用・tube 中心）:
 *   dirs = kunitomoNums[num]===5 ? [-60,-30,0,30,60] : [-30,0,30]
 *   thetaDeg = 90-|horzDeg|, theta=thetaDeg·π/180
 *   h = height·sin²θ, dBase = height·sinθ·cosθ·2, d = dBase·(|horzDeg|===60 ? 1.65 : 1)
 *   kAlt = tubeElev + h
 *   horzDeg===0: (tb.lat, tb.lng, kAlt)
 *   horzDeg≠0 : latAz=(ougiAz+(horzDeg>0?90:-90)+360)%360, destPoint(tb.lat,tb.lng,latAz,d/1000), kAlt
 *   ※ num サイズ制限なし（kunitomoNums[num]>0 の全号数）。wind は使わない。
 *
 * server 新 field（kmlKunitomo）が旧式と lat/lng/alt で一致することを固定する。
 * また wind 有無で KML kunitomo 座標が変わらないことも固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveScene } from "./_bundle/hanabi_scene.mjs";

// client destPoint（KML と同一式）
function destPoint(lat, lng, azDeg, distKm) {
  const R = 6371;
  const az = (azDeg * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  const dR = distKm / R;
  const lat2 = Math.asin(Math.sin(latR) * Math.cos(dR) + Math.cos(latR) * Math.sin(dR) * Math.cos(az));
  const lng2 = lng + (Math.atan2(Math.sin(az) * Math.sin(dR) * Math.cos(latR), Math.cos(dR) - Math.sin(latR) * Math.sin(lat2)) * 180) / Math.PI;
  return [(lat2 * 180) / Math.PI, lng2];
}

// 旧 KML kunitomo の最終結果（正本）を直接再現
function oldKmlKunitomo(tb, numTable) {
  const tubeElev = (tb.elev || 0) + (tb.elevOffset || 0);
  const ougiAz = tb.ougiAz || 0;
  const kunitomoNums = tb.kunitomoNums || {};
  const out = [];
  const numRows = (tb.nums || []).map((n) => numTable.find((r) => r.num === n)).filter(Boolean).sort((a, b) => b.height - a.height);
  for (const row of numRows) {
    const cnt = kunitomoNums[row.num] || 0;
    if (!(cnt > 0)) continue;
    const dirs = cnt === 5 ? [-60, -30, 0, 30, 60] : [-30, 0, 30];
    for (const horzDeg of dirs) {
      const thetaDeg = 90 - Math.abs(horzDeg);
      const theta = (thetaDeg * Math.PI) / 180;
      const h = row.height * Math.sin(theta) * Math.sin(theta);
      const dBase = row.height * Math.sin(theta) * Math.cos(theta) * 2;
      const d = dBase * (Math.abs(horzDeg) === 60 ? 1.65 : 1.0);
      const kAlt = tubeElev + h;
      let lat, lng;
      if (horzDeg === 0) { lat = tb.lat; lng = tb.lng; }
      else {
        const latAz = (ougiAz + (horzDeg > 0 ? 90 : -90) + 360) % 360;
        [lat, lng] = destPoint(tb.lat, tb.lng, latAz, d / 1000);
      }
      out.push({ num: row.num, horzDeg, lat, lng, alt: kAlt });
    }
  }
  return out;
}

const NUM = [
  { num: "3", height: 180, dia: 90, riseTime: 5, windFollowRatio: 0.7 },
  { num: "5", height: 220, dia: 140, riseTime: 6, windFollowRatio: 0.8 },
  { num: "8", height: 300, dia: 240, riseTime: 7, windFollowRatio: 0.82 },
];

function reqWith(tbOver, wind = null) {
  return {
    viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    camera: { focal: 100, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
    festivalTubes: [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5", "8"], enabled: true, ...tbOver }],
    targets: [], numTable: NUM, selectedTubeId: "T1", wind,
  };
}

function assertKmlKunitomoParity(name, tbOver, wind) {
  test(`[kml-kunitomo] ${name}: server kmlKunitomo が旧式と lat/lng/alt 一致`, () => {
    const req = reqWith(tbOver, wind);
    const res = solveScene(req);
    assert.ok(res.ok, "scene ok");
    const tb = req.festivalTubes[0];
    const tubeRes = res.tubes.find((t) => t.id === tb.id);
    assert.ok(tubeRes, "tube 結果");
    assert.ok(Array.isArray(tubeRes.kmlKunitomo), "kmlKunitomo field あり");
    const expect = oldKmlKunitomo(tb, NUM);
    assert.equal(tubeRes.kmlKunitomo.length, expect.length, `件数 ${tubeRes.kmlKunitomo.length} vs ${expect.length}`);
    for (let i = 0; i < expect.length; i++) {
      const s = tubeRes.kmlKunitomo[i], e = expect[i];
      assert.equal(s.num, e.num, `[${i}] num`);
      assert.equal(s.horzDeg, e.horzDeg, `[${i}] horzDeg`);
      assert.ok(Math.abs(s.lat - e.lat) < 1e-12, `[${i}] lat ${s.lat} vs ${e.lat}`);
      assert.ok(Math.abs(s.lng - e.lng) < 1e-12, `[${i}] lng ${s.lng} vs ${e.lng}`);
      assert.ok(Math.abs(s.alt - e.alt) < 1e-9, `[${i}] alt ${s.alt} vs ${e.alt}`);
    }
  });
}

// 3方向（kunitomoNums=3）: horzDeg 0/±30
assertKmlKunitomoParity("3方向 ougiAz0 無風", { ougiAz: 0, kunitomoNums: { "3": 3 } }, null);
// 5方向（kunitomoNums=5）: horzDeg 0/±30/±60（1.65補正含む）
assertKmlKunitomoParity("5方向 ougiAz0 無風", { ougiAz: 0, kunitomoNums: { "5": 5 } }, null);
// ougiAz 非0
assertKmlKunitomoParity("5方向 ougiAz30 無風", { ougiAz: 30, kunitomoNums: { "5": 5 } }, null);
// 複数号数
assertKmlKunitomoParity("複数号数 ougiAz45 無風", { ougiAz: 45, kunitomoNums: { "3": 3, "5": 5, "8": 5 } }, null);
// wind 有り（KML kunitomo は wind 非適用なので結果は無風と同一のはず）
assertKmlKunitomoParity("5方向 ougiAz30 風あり", { ougiAz: 30, kunitomoNums: { "5": 5 } }, { dirDeg: 45, speed: 8 });

test("[kml-kunitomo] wind 有無で KML kunitomo 座標が変わらない（wind 非適用の固定）", () => {
  const tbOver = { ougiAz: 30, kunitomoNums: { "3": 3, "5": 5 } };
  const noWind = solveScene(reqWith(tbOver, null)).tubes[0].kmlKunitomo;
  const withWind = solveScene(reqWith(tbOver, { dirDeg: 120, speed: 15 })).tubes[0].kmlKunitomo;
  assert.equal(noWind.length, withWind.length);
  for (let i = 0; i < noWind.length; i++) {
    assert.equal(noWind[i].lat, withWind[i].lat, `[${i}] lat wind 不変`);
    assert.equal(noWind[i].lng, withWind[i].lng, `[${i}] lng wind 不変`);
    assert.equal(noWind[i].alt, withWind[i].alt, `[${i}] alt wind 不変`);
  }
});

test("[kml-kunitomo] kunitomoNums 未設定なら空", () => {
  const res = solveScene(reqWith({ ougiAz: 0 }, null));
  assert.deepEqual(res.tubes[0].kmlKunitomo, []);
});

test("[kml-kunitomo] NaN/Infinity が出ない", () => {
  const res = solveScene(reqWith({ ougiAz: 30, kunitomoNums: { "3": 3, "5": 5, "8": 5 } }, { dirDeg: 45, speed: 8 }));
  for (const k of res.tubes[0].kmlKunitomo) {
    assert.ok(Number.isFinite(k.lat) && Number.isFinite(k.lng) && Number.isFinite(k.alt));
  }
});
