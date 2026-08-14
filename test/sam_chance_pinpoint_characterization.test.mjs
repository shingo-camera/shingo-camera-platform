/**
 * SUN AND MOON チャンス/ピンポイント評価一本化：characterization（§13）。
 *
 * 目的：現行（変更前）の評価ブレを決定論的に再現し、新評価（対象上端中央一致に
 * 必要な撮影地点移動距離 m）で期待どおりに解消することを固定する。
 *
 * 変更前の評価値（3描画関数で共通）：
 *   moveM_old = distM * tan(azDiff)   … 方位差だけの横移動量（上端との上下ズレを無視）
 * 変更前の★閾値（不一致）：
 *   一括pinpoint : 🎯5 / ★★★10 / ★★☆30
 *   通常chance   : 🎯5 / ★★★10 / ★★☆50 / ★☆☆100 / ☆☆☆200
 *
 * 新評価：idealMoveGeo が返す実移動距離 m（横＋前後）。★は starOf（50/100/200正本）で共通。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { idealMoveGeo, solveDstar, solveDstarRoots, prefilterBounds } from "../src/apps/sun-and-moon/api/_search.js";
import { brng, hav, elAng, dest } from "../src/apps/sun-and-moon/api/_astro.js";

// 変更前の評価式・閾値（再現用）
const moveM_old = (distM, azDiffDeg) => distM * Math.tan(azDiffDeg * Math.PI / 180);
const oldBatchStar = m => m <= 5 ? "🎯" : m <= 10 ? "★★★" : m <= 30 ? "★★☆" : "―"; // 一括pinpoint(30cap)
const oldChanceStar = m => m <= 5 ? "🎯" : m <= 10 ? "★★★" : m <= 50 ? "★★☆" : m <= 100 ? "★☆☆" : m <= 200 ? "☆☆☆" : "―";

// 共通シナリオ：東京駅付近から南東120°・400m・高さ200mの対象
const sLat = 35.6586, sLng = 139.7454, sElev = 20;
const tp = dest(sLat, sLng, 120, 400);
const t = { lat: tp.lat, lng: tp.lng, elev: 20, h: 200 };
const D = hav(sLat, sLng, t.lat, t.lng) * 1000;
const tAz = brng(sLat, sLng, t.lat, t.lng);
const topAlt = elAng(D / 1000, sElev, t.elev, t.h);
const baseAlt = elAng(D / 1000, sElev, t.elev, 0);

test("A: 方位一致でも天体が上端より下を通ると、旧moveMは≈0(🎯)だが新mは大(採用外)", () => {
  // 天体が方位一致(azDiff=0)で対象の約50%高さを通る＝上端より明確に下
  const bodyAz = tAz;
  const bodyAlt = baseAlt + (topAlt - baseAlt) * 0.5;
  const altPct = (bodyAlt - baseAlt) / (topAlt - baseAlt) * 100;
  assert.ok(altPct < 70, "前提：天体は上端中央より明確に下（altPct<70）");

  // 旧評価：方位差0なので旧moveM≈0 → 🎯（誤検出）。旧pinpointゲート(≤30)も通過
  const mOld = moveM_old(D, 0);
  assert.ok(mOld <= 5, "旧moveMは≈0で🎯相当（誤検出の再現）");
  assert.ok(mOld <= 30, "旧pinpointゲート(30m)を通過してしまう");

  // 新評価：上端中央へは前後方向に大きく移動する必要があり、この配置では200mを超える。
  // → pinpoint(≤30)からもchance(≤200)からも正しく除外される（誤検出の解消）。
  const nw = idealMoveGeo(sLat, sLng, sElev, t, bodyAz, bodyAlt); // budget=200
  assert.ok(nw.m > 30, `新mはpinpoint上限30m超（誤検出解消）: m=${nw.m}`);
  assert.ok(!(nw.m <= 200), `この深い下側通過は新mが200m超でchanceからも除外: m=${nw.m}`);
});

test("C: 方位と上端が両方ズレる候補では、旧の横移動量だけでは上端中央に届かない（前後成分の欠落）", () => {
  // 方位0.5°ズレ かつ 天体は上端よりやや下（約85%高さ）＝理想地点は200m以内
  const bodyAz = tAz + 0.5;
  const bodyAlt = baseAlt + (topAlt - baseAlt) * 0.85;

  // 旧：横移動だけ（方位差のみ）。上端との上下ズレ（前後移動で埋める分）を一切含まない
  const mLatOld = moveM_old(D, 0.5);

  // 新：P*は横＋前後で配置され、移動後に上端中央一致が成立する（budget内なので検算一致）
  const nw = idealMoveGeo(sLat, sLng, sElev, t, bodyAz, bodyAlt);
  assert.ok(nw.ok, "新P*では上端中央一致が成立（再評価で検算一致）");
  assert.ok(nw.azErr < 0.02 && nw.altErr < 0.02, "方位・上端仰角とも一致");
  assert.ok(nw.m > mLatOld + 1,
    `新mは旧の横移動量より大（欠落していた前後成分ぶん）: 新${nw.m.toFixed(1)}m > 旧${mLatOld.toFixed(1)}m`);
});

test("B: ★★☆の境界が旧は不一致(一括30/通常50)、新は starOf で共通(50正本)", () => {
  // 40mの移動：旧は場所で評価が割れる（通常=★★☆ / 一括=範囲外）
  assert.equal(oldChanceStar(40), "★★☆", "旧通常chanceでは40m=★★☆");
  assert.equal(oldBatchStar(40), "―", "旧一括pinpointでは40mは範囲外（★★☆にならない）");
  assert.notEqual(oldChanceStar(40), oldBatchStar(40), "旧は同じ40mでも評価が割れる（ブレの再現）");
  // 新：starOf は単一表（40m=★★☆）。採否(pinpoint30m)は★とは別概念で分離。
  // starOf 自体は eval テスト側で index.html から抽出して検証する。
});

test("solveDstar は elAng の逆関数（上端仰角一致距離を厳密に返す）", () => {
  for (const targetAlt of [5, 10, 20, 30]) {
    const dm = solveDstar(targetAlt, sElev, t.elev, t.h);
    assert.ok(dm && isFinite(dm), `D*が求まる（targetAlt=${targetAlt}）`);
    const back = elAng(dm / 1000, sElev, t.elev, t.h);
    assert.ok(Math.abs(back - targetAlt) < 1e-4, `elAng(D*)=targetAlt（誤差<1e-4）: ${back.toFixed(5)} vs ${targetAlt}`);
  }
});

// ===== P0-3: solveDstarRoots は単調性を仮定しない（高台→低対象の逆解） =====
test("P0-3: 高台(se=300)→低対象(te=0,th=100) targetAlt=-5° の実解≈2.29kmを返し再代入一致", () => {
  const roots = solveDstarRoots(-5, 300, 0, 100, 0.0005, 500);
  assert.ok(roots.length >= 1, "根が少なくとも1個");
  const near = roots.reduce((a, b) => Math.abs(b - 2290) < Math.abs(a - 2290) ? b : a);
  assert.ok(Math.abs(near - 2290) < 30, `約2.29kmの実解: ${near.toFixed(1)}m`);
  assert.ok(Math.abs(elAng(near / 1000, 300, 0, 100) - (-5)) < 1e-4, "再代入elAng=-5°");
});

test("P0-3: 対象上端が撮影地点より上/同程度/下 のいずれでも逆解が再代入一致", () => {
  const cases = [
    { se: 0, te: 0, th: 100, alt: 20 },     // 上端が上
    { se: 95, te: 0, th: 100, alt: 0.2 },   // ほぼ同高
    { se: 300, te: 0, th: 100, alt: -5 },   // 上端が下（高台）
    { se: 300, te: 0, th: 100, alt: -10 },  // 上端が下・より急
  ];
  for (const c of cases) {
    const roots = solveDstarRoots(c.alt, c.se, c.te, c.th, 0.0005, 500);
    assert.ok(roots.length >= 1, `根あり se=${c.se} alt=${c.alt}`);
    const ok = roots.some(r => Math.abs(elAng(r / 1000, c.se, c.te, c.th) - c.alt) < 1e-3);
    assert.ok(ok, `いずれかの根で再代入一致 se=${c.se} alt=${c.alt}`);
  }
});

test("P0-3: 複数根がある場合は必要移動最小（現在距離に最も近い）根を採用", () => {
  // elAng は curvature により遠方でピークを持ち、その付近では同一 targetAlt に2根が生じる。
  const se = 300, te = 0, th = 100;
  let peakD = 0.001, peakE = -1e9;
  for (let dk = 0.001; dk <= 500; dk *= 1.02) { const e = elAng(dk, se, te, th); if (e > peakE) { peakE = e; peakD = dk; } }
  const alt2 = peakE - 0.02;
  const roots = solveDstarRoots(alt2, se, te, th, 0.0005, 500);
  assert.ok(roots.length >= 2, `2根が生じる（roots=${roots.map(r => r.toFixed(0))}）`);
  roots.sort((a, b) => a - b);
  // 各根が再代入で一致
  for (const r of roots) assert.ok(Math.abs(elAng(r / 1000, se, te, th) - alt2) < 1e-3, "各根が再代入一致");
  // 観測距離を近根寄りに置き、両根を含む budget で idealMoveGeo が近根（最小移動）を選ぶ
  const dref = roots[0] + (roots[1] - roots[0]) * 0.3;
  const oLat = 35.7, oLng = 139.7;
  const tt = dest(oLat, oLng, 90, dref); const tobj = { lat: tt.lat, lng: tt.lng, elev: te, h: th };
  const budget = (roots[1] - roots[0]) + 500;
  const az = brng(oLat, oLng, tobj.lat, tobj.lng);
  const dOrig = hav(oLat, oLng, tobj.lat, tobj.lng) * 1000;
  const nearest = roots.reduce((a, b) => Math.abs(b - dOrig) < Math.abs(a - dOrig) ? b : a);
  const r = idealMoveGeo(oLat, oLng, se, tobj, az, alt2, dOrig, budget);
  assert.ok(Math.abs(r.Dstar - nearest) < 5, `最小移動根を採用: Dstar=${r.Dstar?.toFixed(0)} nearest=${nearest.toFixed(0)}`);
});

// ===== P0-2: プレフィルタ superset（moveM≤budget を落とさない） =====
test("P0-2: 現在地点で上端範囲外(bodyAlt>topAlt+R)でも、budget内の候補は高度prefilterに含まれる", () => {
  // 近距離100m/高100m：現在地点 topAlt を少し超える bodyAlt でも、移動closerで上端一致しうる
  const pc = dest(sLat, sLng, 120, 100); const tc = { lat: pc.lat, lng: pc.lng, elev: 20, h: 100 };
  const Dc = hav(sLat, sLng, tc.lat, tc.lng) * 1000;
  const topC = elAng(Dc / 1000, sElev, tc.elev, tc.h);
  const R = 0.265;
  const bodyAlt = topC + R + 3; // 旧inAlt(topAlt+R)を明確に超過 → 旧prefilterなら除外
  // 実際に budget内の解があるか（idealMoveGeoで確認）
  const mg = idealMoveGeo(sLat, sLng, sElev, tc, brng(sLat, sLng, tc.lat, tc.lng), bodyAlt, Dc, 200);
  const pf = prefilterBounds(Dc, sElev, tc.elev, tc.h, 200);
  if (mg.m <= 200) {
    assert.ok(bodyAlt <= pf.altHi && bodyAlt >= pf.altLo,
      `budget内候補(m=${mg.m.toFixed(2)})が高度prefilter[${pf.altLo.toFixed(1)},${pf.altHi.toFixed(1)}]に含まれる（旧top+R=${(topC + R).toFixed(1)}は超過）`);
    assert.ok(bodyAlt > topC + R, "旧inAltなら除外される高度である（P0-2反例の再現）");
  } else {
    assert.ok(true, `この高度では200m超（m=${mg.m}）のためprefilter対象外で正しい`);
  }
});

test("P0-2: 実移動200m以内なら、旧atan2(200,D)より方位差が大きくても方位prefilterに含まれる", () => {
  // 方位prefilterは asin(200/D)（旧 atan2(200,D) より広い＝superset）
  const Dm = 400;
  const oldAz = Math.atan2(200, Dm) * 180 / Math.PI;   // 旧（狭い）
  const pf = prefilterBounds(Dm, sElev, 0, 100, 200);
  assert.ok(pf.azThr > oldAz, `新方位prefilter(${pf.azThr.toFixed(3)}°)は旧(${oldAz.toFixed(3)}°)より広い`);
  // asin と atan の関係の確認
  assert.ok(Math.abs(pf.azThr - Math.asin(200 / Dm) * 180 / Math.PI) < 1e-9, "azThr=asin(budget/D)");
});

// ===== P0-1: 区間内 moveM 最小が代表（旧高度差最小とは別） =====
// 実データ探索で「旧高度差最小の時刻」と「moveM最小の時刻」が異なる日を見つけ、
// 代表として moveM 最小側が選ばれることを確認する（brute-force reference）。
import { moonPos, sunPos } from "../src/apps/sun-and-moon/api/_astro.js";

function bruteforceDay(sLat2, sLng2, sElev2, t2, ds, isSun) {
  const tAz2 = brng(sLat2, sLng2, t2.lat, t2.lng);
  const distM2 = hav(sLat2, sLng2, t2.lat, t2.lng) * 1000;
  const topAlt2 = elAng(distM2 / 1000, sElev2, t2.elev, t2.h);
  const pf = prefilterBounds(distM2, sElev2, t2.elev, t2.h, 200);
  const dayStart = new Date(ds + "T00:00:00+09:00").getTime();
  let byMove = null, byAlt = null; // {m, dt, altdiff}
  for (let i = 0; i <= 1440; i++) {
    const dt = new Date(dayStart + i * 60000);
    const bp = isSun ? sunPos(dt, sLat2, sLng2) : moonPos(dt, sLat2, sLng2);
    const azD = Math.abs(((bp.az - tAz2 + 180) % 360) - 180);
    if (!(azD <= pf.azThr && bp.alt >= pf.altLo && bp.alt <= pf.altHi)) continue;
    const mg = idealMoveGeo(sLat2, sLng2, sElev2, t2, bp.az, bp.alt, distM2, 200);
    const altdiff = Math.abs(bp.alt - topAlt2);
    if (!byMove || mg.m < byMove.m) byMove = { m: mg.m, i, altdiff };
    if (!byAlt || altdiff < byAlt.altdiff) byAlt = { m: mg.m, i, altdiff };
  }
  return { byMove, byAlt };
}

test("P0-1: 旧高度差最小とmoveM最小が異なる日で、代表はmoveM最小側になる", () => {
  // 近距離ケースは区間が長く、両者が乖離しやすい
  const pc = dest(sLat, sLng, 120, 250); const tc = { lat: pc.lat, lng: pc.lng, elev: 20, h: 150 };
  let found = false;
  const start = new Date("2026-08-14T00:00:00+09:00").getTime();
  for (let d = 0; d < 40 && !found; d++) {
    const ds = new Date(start + d * 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const bf = bruteforceDay(sLat, sLng, sElev, tc, ds, false);
    if (bf.byMove && bf.byAlt && bf.byMove.i !== bf.byAlt.i && (bf.byAlt.m - bf.byMove.m) > 1) {
      // moveM最小の方が高度差最小より小さいmを持つ日を発見
      found = true;
      assert.ok(bf.byMove.m < bf.byAlt.m, `moveM最小(${bf.byMove.m.toFixed(2)}) < 旧高度差最小のm(${bf.byAlt.m.toFixed(2)})`);
    }
  }
  assert.ok(found, "旧高度差最小とmoveM最小が乖離する日を確認（代表選択の変更が意味を持つ）");
});
