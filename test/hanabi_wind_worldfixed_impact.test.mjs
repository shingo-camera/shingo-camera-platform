/**
 * HANABI 風計算「world-fixed model」変更影響調査（実装変更なし・比較のみ）。
 *
 * 旧方式（現行 server = 統合前 HANABI）:
 *   driftM = speed·(10/7)·fr·riseTime
 *   relDeg = (dirDeg+180) - viewAz、lateral/depth を視線基準で分解、
 *   azOffsetDeg = atan2(lateral, distM)、distOffsetKm = depth/1000 を
 *   (tbAz, tbDkm) に加算し destPoint(view, ...) → burst world。
 *   → world position が viewpoint 依存。
 *
 * 新方式（world-fixed 候補）:
 *   driftM 同一 → 筒場 world から blowToDeg 方向へ driftM だけ world 上で移動 →
 *   burst world lat/lng/alt を確定（viewpoint を風物理の入力にしない）。
 *   各 viewpoint からは az/dist/elev を投影するだけ → world invariant。
 *
 * 本 test は比較専用。src/ の計算式・UI は一切変更しない。
 * WIND_ALT_FACTOR=10/7 は hanabi_calc.ts に定義された定数（比較のため test 内で同値を使用）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hav, brng } from "./_bundle/hanabi_calc.mjs";

const WIND_ALT_FACTOR = 10 / 7;

// destPoint（KML/client と同一の球面 destination・R=6371km）
function destPoint(lat, lng, azDeg, distKm) {
  const R = 6371;
  const az = (azDeg * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  const dR = distKm / R;
  const lat2 = Math.asin(Math.sin(latR) * Math.cos(dR) + Math.cos(latR) * Math.sin(dR) * Math.cos(az));
  const lng2 = lng + (Math.atan2(Math.sin(az) * Math.sin(dR) * Math.cos(latR), Math.cos(dR) - Math.sin(latR) * Math.sin(lat2)) * 180) / Math.PI;
  return [(lat2 * 180) / Math.PI, lng2];
}
function worldDistM(aLat, aLng, aAlt, bLat, bLng, bAlt) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const horiz = R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return Math.sqrt(horiz * horiz + ((bAlt || 0) - (aAlt || 0)) ** 2);
}

// ---- 旧方式 calcWindOffset（正本・hanabi_calc.ts と同一演算を比較用に再現）----
function oldWindOffset(viewAzDeg, distKm, riseTime, followRatio, wind) {
  if (!wind) return { azOffsetDeg: 0, distOffsetKm: 0 };
  const altWind = wind.speed * WIND_ALT_FACTOR;
  const fr = followRatio === undefined ? 0.8 : followRatio;
  const driftM = altWind * fr * riseTime;
  const blowToDeg = (wind.dirDeg + 180) % 360;
  const relDeg = ((blowToDeg - viewAzDeg + 540) % 360) - 180;
  const relRad = (relDeg * Math.PI) / 180;
  const lateralM = driftM * Math.sin(relRad);
  const depthM = driftM * Math.cos(relRad);
  const distM = distKm * 1000;
  return { azOffsetDeg: (Math.atan2(lateralM, distM) * 180) / Math.PI, distOffsetKm: depthM / 1000 };
}
// driftM（両方式共通）
function driftMOf(riseTime, followRatio, wind) {
  if (!wind) return 0;
  const fr = followRatio === undefined ? 0.8 : followRatio;
  return wind.speed * WIND_ALT_FACTOR * fr * riseTime;
}

// ---- 旧 world（viewpoint 依存）: normal burst ----
function oldNormalWorld(view, tube, tubeElev, row, wind) {
  const tbDkm = hav(view.lat, view.lng, tube.lat, tube.lng);
  const tbAz = brng(view.lat, view.lng, tube.lat, tube.lng);
  const w = oldWindOffset(tbAz, tbDkm, row.riseTime, row.windFollowRatio, wind);
  const fwAz = tbAz + w.azOffsetDeg;
  const fwDkm = Math.max(0.05, tbDkm + w.distOffsetKm);
  const [lat, lng] = destPoint(view.lat, view.lng, fwAz, fwDkm);
  return { lat, lng, alt: tubeElev + row.height };
}
// ---- 新 world-fixed: normal burst（viewpoint を入力にしない）----
function newNormalWorld(tube, tubeElev, row, wind) {
  const driftM = driftMOf(row.riseTime, row.windFollowRatio, wind);
  const blowToDeg = wind ? (wind.dirDeg + 180) % 360 : 0;
  const [lat, lng] = driftM === 0 ? [tube.lat, tube.lng] : destPoint(tube.lat, tube.lng, blowToDeg, driftM / 1000);
  return { lat, lng, alt: tubeElev + row.height };
}

// ---- renderSim kunitomo（旧/新）----
// 旧: 各 horzDeg で lateralAz 方向へ d だけ ground 移動した点(fwLatLng) を、viewpoint 相対 az/dist に直し
//     さらに calcWindOffset(tbAz,tbDkm,riseTimeK,...) を az/dist に加算 → destPoint(view,...) で world。
// 新: kunitomo の ground 開花点（tube から lateralAz・d の world 点）を正本とし、そこから
//     blowToDeg 方向へ driftMK だけ world 移動して固定 → viewpoint 投影は brng/hav のみ。
function kuniDirsFor(cnt) { return cnt === 5 ? [-60, -30, 0, 30, 60] : [-30, 0, 30]; }
function kuniGroundPoint(tube, ougiAz, horzDeg, H) {
  const thetaDeg = 90 - Math.abs(horzDeg);
  const theta = (thetaDeg * Math.PI) / 180;
  const dBase = H * Math.sin(theta) * Math.cos(theta) * 2;
  const d = dBase * (Math.abs(horzDeg) === 60 ? 1.65 : 1.0);
  const h = H * Math.sin(theta) * Math.sin(theta);
  const lateralAz = horzDeg === 0 ? ougiAz : (ougiAz + (horzDeg > 0 ? 90 : -90) + 360) % 360;
  const [gLat, gLng] = horzDeg === 0 ? [tube.lat, tube.lng] : destPoint(tube.lat, tube.lng, lateralAz, d / 1000);
  return { gLat, gLng, h, riseFactor: Math.sin(theta) };
}
function oldKuniWorld(view, tube, tubeElev, row, ougiAz, horzDeg, wind) {
  const tbDkm = hav(view.lat, view.lng, tube.lat, tube.lng);
  const tbAz = brng(view.lat, view.lng, tube.lat, tube.lng);
  const g = kuniGroundPoint(tube, ougiAz, horzDeg, row.height);
  const riseTimeK = row.riseTime * g.riseFactor;
  const w = oldWindOffset(tbAz, tbDkm, riseTimeK, row.windFollowRatio, wind);
  const fwAzBase = brng(view.lat, view.lng, g.gLat, g.gLng);
  const fwAz = fwAzBase + w.azOffsetDeg;
  const fwDkm = Math.max(0.05, hav(view.lat, view.lng, g.gLat, g.gLng) + w.distOffsetKm);
  const [lat, lng] = destPoint(view.lat, view.lng, fwAz, fwDkm);
  return { lat, lng, alt: tubeElev + g.h };
}
function newKuniWorld(tube, tubeElev, row, ougiAz, horzDeg, wind) {
  const g = kuniGroundPoint(tube, ougiAz, horzDeg, row.height);
  const riseTimeK = row.riseTime * g.riseFactor;
  const driftM = driftMOf(riseTimeK, row.windFollowRatio, wind);
  const blowToDeg = wind ? (wind.dirDeg + 180) % 360 : 0;
  const [lat, lng] = driftM === 0 ? [g.gLat, g.gLng] : destPoint(g.gLat, g.gLng, blowToDeg, driftM / 1000);
  return { lat, lng, alt: tubeElev + g.h };
}

// ---- ケースマトリクス ----
const NUMS = [
  { num: "3", height: 132, dia: 60, riseTime: 5.19, windFollowRatio: 0.85 },
  { num: "5", height: 224, dia: 170, riseTime: 6.76, windFollowRatio: 0.85 },
  { num: "10", height: 394, dia: 320, riseTime: 8.97, windFollowRatio: 0.81 },
  { num: "40", height: 798, dia: 725, riseTime: 12.76, windFollowRatio: 0.57 },
];
const TUBE = { lat: 34.7, lng: 135.52 };
const TUBE_ELEV = 20;
const OUGI_AZ = 30;
const WINDS = [
  { dirDeg: 0, speed: 3 }, { dirDeg: 0, speed: 7 }, { dirDeg: 0, speed: 12 },
  { dirDeg: 45, speed: 7 }, { dirDeg: 90, speed: 7 }, { dirDeg: 180, speed: 7 }, { dirDeg: 270, speed: 12 },
];
// viewpoint: 方位 × 距離 × 標高
function viewsAt() {
  const arr = [];
  const dirs = { 北: 0, 南: 180, 東: 90, 西: 270, 北東: 45 };
  const dists = [0.3, 0.5, 1, 2, 5, 8];
  for (const [dname, az] of Object.entries(dirs)) {
    for (const dkm of dists) {
      const [lat, lng] = destPoint(TUBE.lat, TUBE.lng, (az + 180) % 360, dkm); // 筒場から見て逆方向に viewpoint
      arr.push({ name: `${dname}${dkm}km`, dir: dname, dkm, lat, lng, elev: 5 });
    }
  }
  // 標高差ケース
  const [hlat, hlng] = destPoint(TUBE.lat, TUBE.lng, 0, 2);
  arr.push({ name: "標高250m", dir: "南", dkm: 2, lat: hlat, lng: hlng, elev: 250 });
  return arr;
}
const VIEWS = viewsAt();

// 角度・pixel 換算参考値（focal=100mm, sensor幅36mm → 水平画角、画面横 6000px 想定）
function pxAndArcmin(diffM, viewDistKm) {
  const angRad = Math.atan2(diffM, viewDistKm * 1000); // 対象での横ズレの角度
  const arcmin = (angRad * 180 / Math.PI) * 60;
  const fovH = 2 * Math.atan(36 / (2 * 100)) * 180 / Math.PI; // ≈20.4°（100mm/36mm）
  const px = (angRad * 180 / Math.PI) / fovH * 6000;
  return { arcmin, px };
}

const rows = { normal: [], kuni: [] };

test("[wf-normal] normal burst: old vs world-fixed 差を全ケース集計", () => {
  let maxDiff = 0, sum = 0, n = 0;
  const byDist = {}, bySpeed = {}, byNum = {};
  for (const row of NUMS) {
    for (const wind of WINDS) {
      const newW = newNormalWorld(TUBE, TUBE_ELEV, row, wind); // viewpoint 非依存
      for (const v of VIEWS) {
        const oldW = oldNormalWorld(v, TUBE, TUBE_ELEV, row, wind);
        const diff = worldDistM(oldW.lat, oldW.lng, oldW.alt, newW.lat, newW.lng, newW.alt);
        maxDiff = Math.max(maxDiff, diff); sum += diff; n++;
        byDist[v.dkm] = Math.max(byDist[v.dkm] || 0, diff);
        bySpeed[wind.speed] = Math.max(bySpeed[wind.speed] || 0, diff);
        byNum[row.num] = Math.max(byNum[row.num] || 0, diff);
        rows.normal.push({ num: row.num, wind, v: v.name, dkm: v.dkm, diff });
      }
    }
  }
  rows._normal = { maxDiff, avg: sum / n, byDist, bySpeed, byNum, n };
  assert.ok(Number.isFinite(maxDiff));
});

test("[wf-kuni] renderSim kunitomo: old vs world-fixed 差を全ケース集計", () => {
  let maxDiff = 0, sum = 0, n = 0;
  const byDist = {}, bySpeed = {}, byNum = {};
  const kuniNums = NUMS.filter((r) => parseInt(r.num) <= 10); // renderSim kunitomo は num≤10
  for (const row of kuniNums) {
    for (const wind of WINDS) {
      for (const horzDeg of kuniDirsFor(5)) {
        const newW = newKuniWorld(TUBE, TUBE_ELEV, row, OUGI_AZ, horzDeg, wind);
        for (const v of VIEWS) {
          const oldW = oldKuniWorld(v, TUBE, TUBE_ELEV, row, OUGI_AZ, horzDeg, wind);
          const diff = worldDistM(oldW.lat, oldW.lng, oldW.alt, newW.lat, newW.lng, newW.alt);
          maxDiff = Math.max(maxDiff, diff); sum += diff; n++;
          byDist[v.dkm] = Math.max(byDist[v.dkm] || 0, diff);
          bySpeed[wind.speed] = Math.max(bySpeed[wind.speed] || 0, diff);
          byNum[row.num] = Math.max(byNum[row.num] || 0, diff);
        }
      }
    }
  }
  rows._kuni = { maxDiff, avg: sum / n, byDist, bySpeed, byNum, n };
  assert.ok(Number.isFinite(maxDiff));
});

test("[wf-invariance] world-fixed 方式は viewpoint 間 world 差が数値誤差レベルで 0", () => {
  let maxInv = 0;
  for (const row of NUMS) {
    for (const wind of WINDS) {
      const ref = newNormalWorld(TUBE, TUBE_ELEV, row, wind); // viewpoint 非依存
      // 新方式は viewpoint を入力にしないため全 viewpoint で同一。念のため呼び出し安定性を確認。
      const again = newNormalWorld(TUBE, TUBE_ELEV, row, wind);
      maxInv = Math.max(maxInv, worldDistM(ref.lat, ref.lng, ref.alt, again.lat, again.lng, again.alt));
    }
  }
  // kunitomo も同様
  for (const row of NUMS.filter((r) => parseInt(r.num) <= 10)) {
    for (const wind of WINDS) {
      for (const hd of kuniDirsFor(5)) {
        const a = newKuniWorld(TUBE, TUBE_ELEV, row, OUGI_AZ, hd, wind);
        const b = newKuniWorld(TUBE, TUBE_ELEV, row, OUGI_AZ, hd, wind);
        maxInv = Math.max(maxInv, worldDistM(a.lat, a.lng, a.alt, b.lat, b.lng, b.alt));
      }
    }
  }
  assert.ok(maxInv < 1e-9, `world-fixed invariance error ${maxInv}m（0 であるべき）`);
});

test("[wf-REPORT] 集計と pixel/arcmin 換算を出力", () => {
  const N = rows._normal, K = rows._kuni;
  console.log("\n===== WORLD-FIXED IMPACT SUMMARY =====");
  console.log(`normal burst  : n=${N.n} maxDiff=${N.maxDiff.toFixed(3)}m avg=${N.avg.toFixed(3)}m`);
  console.log(`renderSim kuni: n=${K.n} maxDiff=${K.maxDiff.toFixed(3)}m avg=${K.avg.toFixed(3)}m`);
  console.log("\n-- normal 距離別 maxDiff[m] --");
  for (const d of [0.3, 0.5, 1, 2, 5, 8]) console.log(`   ${d}km: ${(N.byDist[d] || 0).toFixed(3)}`);
  console.log("-- normal 風速別 maxDiff[m] --");
  for (const s of [3, 7, 12]) console.log(`   ${s}m/s: ${(N.bySpeed[s] || 0).toFixed(3)}`);
  console.log("-- normal 号数別 maxDiff[m] --");
  for (const nm of ["3", "5", "10", "40"]) console.log(`   ${nm}号: ${(N.byNum[nm] || 0).toFixed(3)}`);
  console.log("-- kunitomo 距離別 maxDiff[m] --");
  for (const d of [0.3, 0.5, 1, 2, 5, 8]) console.log(`   ${d}km: ${(K.byDist[d] || 0).toFixed(3)}`);
  console.log("-- kunitomo 号数別 maxDiff[m] --");
  for (const nm of ["3", "5", "10"]) console.log(`   ${nm}号: ${(K.byNum[nm] || 0).toFixed(3)}`);
  console.log("\n-- pixel/arcmin 換算（normal 号数別 maxDiff を各距離で見た場合の参考値, focal=100mm）--");
  for (const d of [0.3, 1, 2, 5]) {
    const conv = pxAndArcmin(N.byDist[d] || 0, d);
    console.log(`   ${d}km, diff=${(N.byDist[d] || 0).toFixed(2)}m → ${conv.arcmin.toFixed(2)}′ / ${conv.px.toFixed(1)}px(6000px幅)`);
  }
  console.log("======================================\n");
  assert.ok(true);
});
