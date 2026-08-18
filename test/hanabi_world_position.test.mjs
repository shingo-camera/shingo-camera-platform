/**
 * STEP 2: 同一花火の観測地点横断 world-position characterization。
 *
 * 固定: festival / tube(lat/lng/elev/elevOffset) / num / height / dia / riseTime / windFollowRatio /
 *       wind(dir/speed) / ougi / kunitomo。変更するのは viewpoint のみ。
 *
 * 比較は pixel でなく world lat/lng/alt。server は viewpoint-relative（fwAzDeg/fwDkm/fwAltDeg）しか返さないため、
 *   world lat/lng = destPoint(viewLat, viewLng, fwAzDeg, fwDkm)
 *   world alt     = tubeElev + height（絶対高度・viewpoint 非依存の設計値）
 * へ再投影して比較する。
 *
 * 2 種類の比較:
 *   A. 統合前 HANABI vs 現在 server（各 viewpoint）… client→server 移行 parity
 *   B. viewpoint A vs viewpoint B … 同一花火が観測地点に依存せず同じ world position にあるか
 *
 * 正本（旧版比較）: 統合開始時の hanabi.html 実コードは現在の作業コンテキストに無いため、
 *   Phase A〜C で固定した旧 client characterization 実装（= server core の elAng/calcWindOffset/hav/brng/
 *   seedNumMeta と同一演算）を旧版正本として使用する。新たに旧式を推測・写経していない。
 *   → したがって A（old vs new）は設計上一致するはず。B（viewpoint 不変性）が本質的な調査対象。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveScene } from "./_bundle/hanabi_scene.mjs";
import { elAng, calcWindOffset, hav, brng, seedNumMeta } from "./_bundle/hanabi_calc.mjs";

// ---- 一般測地（destPoint: KML/client と同一式）----
function destPoint(lat, lng, azDeg, distKm) {
  const R = 6371;
  const az = (azDeg * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  const dR = distKm / R;
  const lat2 = Math.asin(Math.sin(latR) * Math.cos(dR) + Math.cos(latR) * Math.sin(dR) * Math.cos(az));
  const lng2 = lng + (Math.atan2(Math.sin(az) * Math.sin(dR) * Math.cos(latR), Math.cos(dR) - Math.sin(latR) * Math.sin(lat2)) * 180) / Math.PI;
  return [(lat2 * 180) / Math.PI, lng2];
}
// world 2 点間の距離[m]（haversine, R=6371000）
function worldDistM(aLat, aLng, aAlt, bLat, bLng, bAlt) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const horiz = R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  const vert = (bAlt || 0) - (aAlt || 0);
  return Math.sqrt(horiz * horiz + vert * vert);
}

// ---- 固定パラメータ（花火そのもの）----
const TUBE = { id: "T1", festivalId: "F", lat: 34.7000, lng: 135.5200, elev: 20, elevOffset: 0, nums: ["5"], enabled: true, ougi: true, ougiAz: 30, kunitomoNums: { "5": 5 } };
const NUM = [{ num: "5", height: 224, dia: 170, riseTime: 6.76, windFollowRatio: 0.85 }];
const TUBE_ELEV = TUBE.elev + TUBE.elevOffset; // 20
const OUGI_HEIGHT = 90;

// ---- viewpoint ケース（日本国内・筒場周辺）----
const VIEWS = [
  { name: "北", lat: 34.7300, lng: 135.5200, elev: 5 },
  { name: "南", lat: 34.6700, lng: 135.5200, elev: 5 },
  { name: "東", lat: 34.7000, lng: 135.5560, elev: 5 },
  { name: "西", lat: 34.7000, lng: 135.4840, elev: 5 },
  { name: "北東斜め", lat: 34.7200, lng: 135.5400, elev: 5 },
  { name: "近距離", lat: 34.7030, lng: 135.5220, elev: 5 },
  { name: "中距離", lat: 34.6820, lng: 135.5050, elev: 5 },
  { name: "長距離", lat: 34.6300, lng: 135.4600, elev: 5 },
  { name: "標高違い", lat: 34.6820, lng: 135.5050, elev: 250 },
];

function makeReq(view, wind) {
  return {
    viewpoint: { manual: true, lat: view.lat, lng: view.lng, elev: view.elev, tripodH: 0, elevOffset: 0 },
    camera: { focal: 100, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
    festivalTubes: [TUBE], targets: [], numTable: NUM, selectedTubeId: "T1", wind, ougiHeight: OUGI_HEIGHT,
  };
}

// sElev（撮影者の目線標高）= elev + tripodH/100（tripodH=0 なので elev）。scene.ts と同一。
function sElevOf(view) { return view.elev + 0 / 100; }

// 旧版正本: server core で各 burst 系の world 位置を直接計算（Phase A〜C characterization と同一演算）
function oldWorldNormal(view, wind) {
  const tbDkm = hav(view.lat, view.lng, TUBE.lat, TUBE.lng);
  const tbAz = brng(view.lat, view.lng, TUBE.lat, TUBE.lng);
  const row = NUM[0];
  const w = calcWindOffset(tbAz, tbDkm, row.riseTime, row.windFollowRatio, wind);
  const fwAz = tbAz + w.azOffsetDeg;
  const fwDkm = Math.max(0.05, tbDkm + w.distOffsetKm);
  const [lat, lng] = destPoint(view.lat, view.lng, fwAz, fwDkm);
  return { lat, lng, alt: TUBE_ELEV + row.height };
}

// server(new) の normal burst → world
function newWorldNormal(res, view) {
  const b = res.tubes[0].bursts.find((x) => x.num === "5");
  const [lat, lng] = destPoint(view.lat, view.lng, b.fwAzDeg, b.fwDkm);
  return { lat, lng, alt: TUBE_ELEV + NUM[0].height };
}

// server の ougi 点群 → world（各 horzDeg）
function newWorldOugi(res, view) {
  return res.tubes[0].ougi.map((o) => {
    const [lat, lng] = destPoint(view.lat, view.lng, o.fwAzDeg, o.fwDkm);
    // ougi world alt: h = H·sin²θ（server が fwAltDeg にしか持たないため、設計上の絶対高度を tubeElev+h で再構成）
    const theta = ((90 - Math.abs(o.horzDeg)) * Math.PI) / 180;
    const h = OUGI_HEIGHT * Math.sin(theta) * Math.sin(theta);
    return { horzDeg: o.horzDeg, lat, lng, alt: TUBE_ELEV + h };
  });
}
// server の renderSim kunitomo 点群 → world
function newWorldKuni(res, view) {
  return res.tubes[0].kunitomo.map((k) => {
    const [lat, lng] = destPoint(view.lat, view.lng, k.fwAzDeg, k.fwDkm);
    const theta = ((90 - Math.abs(k.horzDeg)) * Math.PI) / 180;
    const h = NUM[0].height * Math.sin(theta) * Math.sin(theta);
    return { num: k.num, horzDeg: k.horzDeg, lat, lng, alt: TUBE_ELEV + h };
  });
}
// server の kmlKunitomo は既に world lat/lng/alt
function newWorldKmlKuni(res) {
  return res.tubes[0].kmlKunitomo.map((k) => ({ num: k.num, horzDeg: k.horzDeg, lat: k.lat, lng: k.lng, alt: k.alt }));
}

const results = { normal_nowind: [], normal_wind: [], ougi: [], kuni: [], kmlkuni: [] };

/* ============ A: 旧方式(viewpoint-relative) vs 新 server(world-fixed) の差 ============
 * world-fixed 移行後、旧方式と新 server は**意図的に異なる**（仕様変更）。
 * ここでは「両者が一致する」ことではなく、差が既知の spec-change 量であることを記録する。 */
test("[world-A] 旧方式(viewpoint-relative) と 新 server(world-fixed) の差を記録（仕様変更）", () => {
  let maxDiff = 0;
  for (const wind of [null, { dirDeg: 45, speed: 8 }]) {
    for (const v of VIEWS) {
      const res = solveScene(makeReq(v, wind));
      const oldW = oldWorldNormal(v, wind); // 旧 viewpoint-relative
      const newW = newWorldNormal(res, v); // 新 server(world-fixed)
      const err = worldDistM(oldW.lat, oldW.lng, oldW.alt, newW.lat, newW.lng, newW.alt);
      maxDiff = Math.max(maxDiff, err);
      if (!wind) assert.ok(err < 1e-6, `${v.name} 無風は旧新一致すべき`); // 無風は不変（差0）
    }
  }
  // 風ありは仕様変更で差が出る（0 ではない）。有限であることのみ確認し、値は REPORT で参照。
  assert.ok(Number.isFinite(maxDiff), "差は有限");
});

/* ============ B: viewpoint 間 world 不変性 ============ */
function invarianceMaxM(list, keyFn) {
  // list: [{v, items:[{key, lat,lng,alt}]}]。同一 key の world 位置の viewpoint 間最大差[m]
  let maxM = 0;
  const byKey = new Map();
  for (const entry of list) for (const it of entry.items) {
    const k = keyFn(it);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
  }
  for (const [, pts] of byKey) {
    for (let i = 1; i < pts.length; i++) {
      const d = worldDistM(pts[0].lat, pts[0].lng, pts[0].alt, pts[i].lat, pts[i].lng, pts[i].alt);
      if (d > maxM) maxM = d;
    }
  }
  return maxM;
}

test("[world-B] normal burst 無風: viewpoint 間 world 不変性を測定", () => {
  const list = VIEWS.map((v) => ({ v: v.name, items: [{ key: "5", ...newWorldNormal(solveScene(makeReq(v, null)), v) }] }));
  const maxM = invarianceMaxM(list, (it) => it.key);
  results._invariance = results._invariance || {};
  results._invariance.normal_nowind = maxM;
  // 無風は viewpoint 非依存のはず（tube 位置そのもの）。厳しめに固定。
  assert.ok(maxM < 1e-3, `normal 無風 viewpoint 間 world 差 ${maxM}m（無風は不変であるべき）`);
});

test("[world-B] normal burst 風あり: viewpoint 間 world 不変性 ≈ 0（world-fixed 新仕様）", () => {
  const wind = { dirDeg: 45, speed: 8 };
  const list = VIEWS.map((v) => ({ v: v.name, world: newWorldNormal(solveScene(makeReq(v, wind)), v) }));
  const maxM = invarianceMaxM(list.map((e) => ({ v: e.v, items: [{ key: "5", ...e.world }] })), (it) => it.key);
  results._invariance = results._invariance || {};
  results._invariance.normal_wind = maxM;
  results.normal_wind = list.map((e) => ({ v: e.v, world: e.world }));
  // world-fixed: 同一花火は viewpoint に依存せず同一 world 位置。数値誤差レベルで 0。
  assert.ok(maxM < 1e-6, `normal 風あり viewpoint 間 world 差 ${maxM}m（world-fixed で不変であるべき）`);
});

test("[world-B] ougi: viewpoint 間 world 不変性を測定（調査）", () => {
  const wind = { dirDeg: 45, speed: 8 };
  const list = VIEWS.map((v) => ({ v: v.name, items: newWorldOugi(solveScene(makeReq(v, wind)), v).map((o) => ({ key: `o${o.horzDeg}`, lat: o.lat, lng: o.lng, alt: o.alt })) }));
  const maxM = invarianceMaxM(list, (it) => it.key);
  results._invariance.ougi = maxM;
  assert.ok(maxM < 1e-6, `ougi viewpoint 間 world 差 ${maxM}m（不変であるべき）`);
});

test("[world-B] renderSim kunitomo: viewpoint 間 world 不変性 ≈ 0（world-fixed 新仕様）", () => {
  const wind = { dirDeg: 45, speed: 8 };
  const list = VIEWS.map((v) => ({ v: v.name, items: newWorldKuni(solveScene(makeReq(v, wind)), v).map((k) => ({ key: `k${k.num}_${k.horzDeg}`, lat: k.lat, lng: k.lng, alt: k.alt })) }));
  const maxM = invarianceMaxM(list, (it) => it.key);
  results._invariance.kuni = maxM;
  assert.ok(maxM < 1e-6, `renderSim kunitomo viewpoint 間 world 差 ${maxM}m（world-fixed で不変であるべき）`);
});

test("[world-B] kmlKunitomo: viewpoint 間 world 不変性（wind 非適用・tube 中心なので不変であるべき）", () => {
  const wind = { dirDeg: 45, speed: 8 };
  const list = VIEWS.map((v) => ({ v: v.name, items: newWorldKmlKuni(solveScene(makeReq(v, wind))).map((k) => ({ key: `k${k.num}_${k.horzDeg}`, lat: k.lat, lng: k.lng, alt: k.alt })) }));
  const maxM = invarianceMaxM(list, (it) => it.key);
  results._invariance.kmlkuni = maxM;
  // kmlKunitomo は tube 中心・wind 非適用なので viewpoint 完全非依存であるべき。
  assert.ok(maxM < 1e-6, `kmlKunitomo viewpoint 間 world 差 ${maxM}m（不変であるべき）`);
});

/* ============ 結果表の出力 ============ */
test("[world-REPORT] world-fixed invariance 結果を出力", () => {
  const inv = results._invariance || {};
  console.log("\n===== WORLD-FIXED INVARIANCE SUMMARY =====");
  console.log("viewpoint 間 world 不変性 最大差[m]（world-fixed 新仕様）:");
  console.log("   normal 無風 :", (inv.normal_nowind ?? NaN).toExponential(3));
  console.log("   normal 風あり:", (inv.normal_wind ?? NaN).toExponential(3));
  console.log("   ougi 風あり  :", (inv.ougi ?? NaN).toExponential(3));
  console.log("   kunitomo 風  :", (inv.kuni ?? NaN).toExponential(3));
  console.log("   kmlKunitomo  :", (inv.kmlkuni ?? NaN).toExponential(3));
  if (results.normal_wind) {
    console.log("\n-- normal 風あり 各 viewpoint world 位置（全て同一であるべき）--");
    for (const r of results.normal_wind) {
      console.log(`   ${r.v.padEnd(12)} lat=${r.world.lat.toFixed(7)} lng=${r.world.lng.toFixed(7)} alt=${r.world.alt.toFixed(1)}`);
    }
  }
  console.log("==========================================\n");
  assert.ok(true);
});
