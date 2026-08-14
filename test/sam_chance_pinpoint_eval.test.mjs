/**
 * SUN AND MOON チャンス/ピンポイント評価一本化：新評価・filter・共通★（§14/§15）。
 *
 * ・理想点（対象上端中央一致）に必要な実移動距離 m を idealMoveGeo で決定論的に検証
 * ・★共通表 starOf（index.html から抽出）＝ 5/10/50/100/200
 * ・採否 filter：chance ≤200m / pinpoint ≤30m（★境界50mとは別概念）
 * ・天体再評価版 idealMove の収束（Moon/Sun）
 * ・実エンドポイント /api/chance（chance/pinpoint）の不変条件（pinpoint ⊆ chance）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { idealMoveGeo, solveDstar, idealMove, acceptMove, prefilterBounds } from "../src/apps/sun-and-moon/api/_search.js";
import { onRequest as chanceReq } from "../src/apps/sun-and-moon/api/chance.js";
import { brng, hav, elAng, dest, moonPos, sunPos, moonAge } from "../src/apps/sun-and-moon/api/_astro.js";

// ---- 共通★ starOf を index.html から抽出（実装そのものを検証）----
const html = readFileSync("public/apps/sun-and-moon/index.html", "utf8");
function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`);
  const m = html.match(re);
  assert.ok(m, `${name} が index.html から抽出できること`);
  return m[0];
}
const starOf = new Function(`${extractFn("starOf")}\nreturn starOf;`)();

// 採否 filter（サーバ実装と同値）
const keepChance = m => m <= 200;
const keepPin = m => m <= 30;

// 基準シナリオ
const sLat = 35.6586, sLng = 139.7454, sElev = 20;
const tp = dest(sLat, sLng, 120, 400);
const t = { lat: tp.lat, lng: tp.lng, elev: 20, h: 200 };
const D = hav(sLat, sLng, t.lat, t.lng) * 1000;
const tAz = brng(sLat, sLng, t.lat, t.lng);
const topAlt = elAng(D / 1000, sElev, t.elev, t.h);

// ===== ★共通表（§7） =====
test("starOf：5/10/50/100/200 の境界（通常chance現行値を正本）", () => {
  assert.equal(starOf(0, "🌕"), "🎯🌕🎯");
  assert.equal(starOf(5, "🌕"), "🎯🌕🎯");
  assert.equal(starOf(5.01, "🌕"), "★★★");
  assert.equal(starOf(10), "★★★");
  assert.equal(starOf(10.01), "★★☆");
  assert.equal(starOf(30), "★★☆");   // pinpoint上限内でも★は★★☆
  assert.equal(starOf(50), "★★☆");
  assert.equal(starOf(50.01), "★☆☆");
  assert.equal(starOf(100), "★☆☆");
  assert.equal(starOf(100.01), "☆☆☆");
  assert.equal(starOf(200), "☆☆☆");
  assert.equal(starOf(200.01), "―");
  assert.equal(starOf(NaN), "―");
});

// ===== 理想点・必要移動距離 m（§14） =====
test("完全上端中央一致 → m≈0 → 🎯", () => {
  const r = idealMoveGeo(sLat, sLng, sElev, t, tAz, topAlt);
  assert.ok(r.ok, "上端中央一致（検算）");
  assert.ok(r.m < 0.05, `m≈0: ${r.m.toFixed(4)}`);
  assert.equal(starOf(r.m, "🌕"), "🎯🌕🎯");
});

test("前後移動のみ（方位一致・上端から外れる）で m=境界値を厳密再現", () => {
  // D* を D+X に置く bodyAlt を作れば、方位一致(azDiff=0)で m=X（前後移動）になる
  for (const X of [5, 10, 30, 50, 100, 200]) {
    const bodyAlt = elAng((D + X) / 1000, sElev, t.elev, t.h); // D*=D+X となる上端仰角
    const r = idealMoveGeo(sLat, sLng, sElev, t, tAz, bodyAlt);
    assert.ok(r.ok, `上端中央一致（X=${X}）`);
    assert.ok(Math.abs(r.m - X) < 0.5, `m≈${X}（前後移動）: 実測 ${r.m.toFixed(2)}`);
  }
});

test("横移動のみ（上端仰角一致・方位ズレ）でも m>0・上端中央一致は成立", () => {
  for (const X of [5, 20, 40]) {
    const dAz = 2 * Math.asin(X / (2 * D)) * 180 / Math.PI; // 弦長Xに相当する方位差
    const r = idealMoveGeo(sLat, sLng, sElev, t, tAz + dAz, topAlt);
    assert.ok(r.ok, `上端中央一致（横X=${X}）`);
    assert.ok(Math.abs(r.m - X) < 0.5, `m≈${X}（横移動）: 実測 ${r.m.toFixed(2)}`);
  }
});

test("方位一致だが上下にズレる → m>0（上端中央一致にしない）", () => {
  const bodyAlt = topAlt - 3; // 上端より3°低い
  const r = idealMoveGeo(sLat, sLng, sElev, t, tAz, bodyAlt);
  assert.ok(r.m > 0.5, `m>0: ${r.m.toFixed(2)}`);
  // その地点では上端中央（=元の topAlt）ではなく、bodyAlt に一致する点まで移動している
  assert.ok(r.ok, "移動後は bodyAlt=上端仰角 が成立（別距離の上端）");
});

test("高度一致だが方位ズレ → m>0", () => {
  const r = idealMoveGeo(sLat, sLng, sElev, t, tAz + 3, topAlt);
  assert.ok(r.m > 0.5, `m>0: ${r.m.toFixed(2)}`);
});

test("近距離/遠距離・対象高さ違い・撮影地点標高違いでも上端中央一致が成立", () => {
  const cases = [
    { dist: 150, h: 60, se: 0 },
    { dist: 150, h: 300, se: 40 },
    { dist: 3000, h: 60, se: 0 },
    { dist: 3000, h: 333, se: 100 },
  ];
  for (const c of cases) {
    const p2 = dest(sLat, sLng, 100, c.dist);
    const t2 = { lat: p2.lat, lng: p2.lng, elev: 10, h: c.h };
    const D2 = hav(sLat, sLng, t2.lat, t2.lng) * 1000;
    const tAz2 = brng(sLat, sLng, t2.lat, t2.lng);
    const topAlt2 = elAng(D2 / 1000, c.se, t2.elev, t2.h);
    const r = idealMoveGeo(sLat, sLng, c.se, t2, tAz2 + 0.5, topAlt2);
    assert.ok(r.ok, `上端中央一致 dist=${c.dist} h=${c.h} se=${c.se}: azErr=${r.azErr.toFixed(3)} altErr=${r.altErr.toFixed(3)}`);
  }
});

// ===== filter（§15） =====
test("filter：chance≤200表示/超非表示、pinpoint≤30表示/超非表示", () => {
  assert.equal(keepChance(200), true);
  assert.equal(keepChance(200.01), false);
  assert.equal(keepPin(30), true);
  assert.equal(keepPin(30.01), false);
});

test("40m は ★★☆・chanceに出る・pinpointには出ない（★と採否は別概念）", () => {
  assert.equal(starOf(40), "★★☆");
  assert.equal(keepChance(40), true);
  assert.equal(keepPin(40), false);
});

test("§10 の関係表を満たす（8→★★★/pin, 25→★★☆/pin, 40→★★☆/chanceのみ, 80→★☆☆, 180→☆☆☆, 220→対象外）", () => {
  const rows = [
    { m: 8, star: "★★★", pin: true, ch: true },
    { m: 25, star: "★★☆", pin: true, ch: true },
    { m: 40, star: "★★☆", pin: false, ch: true },
    { m: 80, star: "★☆☆", pin: false, ch: true },
    { m: 180, star: "☆☆☆", pin: false, ch: true },
    { m: 220, star: "―", pin: false, ch: false },
  ];
  for (const r of rows) {
    assert.equal(starOf(r.m), r.star, `m=${r.m}★`);
    assert.equal(keepPin(r.m), r.pin, `m=${r.m} pin`);
    assert.equal(keepChance(r.m), r.ch, `m=${r.m} chance`);
  }
});

// ===== 天体再評価版 idealMove の収束（§5,§6,§21） =====
async function callChance(mode, extra, tArg, days) {
  const body = { sLat, sLng, sElev, t: tArg || t, dateStr: "2026-08-14", mode, dayOffset: 0, dayCount: days || 365, ...extra };
  const req = new Request("https://x/api/chance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const res = await chanceReq({ request: req });
  return await res.json();
}

// ===== P0-4: fail-closed 採否述語 =====
test("P0-4: acceptMove は収束かつmoveM閾値内のみ true（未収束/NaN/Infinityはfalse）", () => {
  // pinpoint(30)
  assert.equal(acceptMove({ moveConverged: true, moveM: 20 }, 30), true);
  assert.equal(acceptMove({ moveConverged: true, moveM: 30 }, 30), true);
  assert.equal(acceptMove({ moveConverged: true, moveM: 30.01 }, 30), false);
  assert.equal(acceptMove({ moveConverged: false, moveM: 20 }, 30), false, "未収束はpinpointに出ない");
  assert.equal(acceptMove({ moveConverged: true, moveM: NaN }, 30), false, "NaNはfail-closed");
  assert.equal(acceptMove({ moveConverged: true, moveM: Infinity }, 30), false, "Infinityはfail-closed");
  assert.equal(acceptMove({ moveM: 20 }, 30), false, "converged未定義はfalse");
  // chance(200)
  assert.equal(acceptMove({ moveConverged: true, moveM: 200 }, 200), true);
  assert.equal(acceptMove({ moveConverged: false, moveM: 100 }, 200), false, "未収束はchanceに出ない");
  assert.equal(acceptMove({ moveConverged: true, moveM: 250 }, 200), false);
});

test("実 /api/chance：pinpoint 全件 m≤30・上端中央近傍（altPct≈100）・全件収束", async () => {
  const pin = await callChance("pinpoint", { bodyFilter: "both" });
  const arr = Array.isArray(pin) ? pin : (pin.results || []);
  assert.ok(arr.length > 0, "pinpoint結果が存在");
  for (const r of arr) {
    assert.ok(r.moveM <= 30 + 1e-6, `moveM≤30: ${r.moveM}`);
    const altPct = (r.alt - r.baseAlt) / (r.topAlt - r.baseAlt) * 100;
    assert.ok(altPct > 85, `上端近傍(altPct>85): ${altPct.toFixed(1)}%（症状A解消）`);
    // 返却された全件が、独立に再評価しても収束している（fail-closedの効果）
    const mv = idealMove(sLat, sLng, sElev, t, r.ts instanceof Date ? r.ts : new Date(r.ts), r.isSun === true);
    assert.equal(mv.converged, true, `返却結果は収束済み ${r.date} ${r.time}`);
  }
});

test("idealMove（天体再評価版）：Moon/Sun とも最大4回以内で全検査ケース収束（iters実測）", () => {
  // 1年分・毎時サンプルで、上端中央近傍の候補について収束と反復回数を実測する。
  let checked = 0, notConverged = 0, maxIters = 0;
  const start = new Date("2026-08-14T00:00:00+09:00").getTime();
  for (const isSun of [false, true]) {
    for (let h = 0; h < 365 * 24; h += 6) {
      const dt = new Date(start + h * 3600000);
      const r = idealMove(sLat, sLng, sElev, t, dt, isSun);
      if (!isFinite(r.m) || r.m > 200) continue; // budget内候補のみ
      checked++;
      if (!r.converged) notConverged++;
      if (r.iters > maxIters) maxIters = r.iters;
    }
  }
  assert.ok(checked > 50, `十分な件数を検査（${checked}件）`);
  assert.equal(notConverged, 0, `全件収束（未収束 ${notConverged}/${checked}）`);
  assert.ok(maxIters <= 4, `反復は最大4回以内（実測最大 ${maxIters}）`);
  console.log(`  [収束実測] 検査${checked}件 未収束0 最大反復${maxIters}回`);
});

test("実 /api/chance：chance(月) 全件 m≤200、pinpoint(月) ⊆ chance(月) が100%一致", async () => {
  const ch = await callChance("chance", { sunsetMode: false });
  const chArr = Array.isArray(ch) ? ch : (ch.results || []);
  for (const r of chArr) assert.ok(r.moveM <= 200 + 1e-6, `chance moveM≤200: ${r.moveM}`);

  // 同一1分刻み・同一評価・同一プレフィルタなので、pinpoint(月) は必ず chance(月) の部分集合。
  const pin = await callChance("pinpoint", { bodyFilter: "moon" });
  const pinArr = Array.isArray(pin) ? pin : (pin.results || []);
  const chKey = new Map(chArr.map(r => [`${r.date} ${r.time}`, r.moveM]));
  for (const r of pinArr) {
    const k = `${r.date} ${r.time}`;
    assert.ok(chKey.has(k), `pinpoint候補がchanceに存在（100%部分集合）: ${k}`);
    assert.ok(Math.abs(chKey.get(k) - r.moveM) < 1e-6, `同一評価m ${k}: ${chKey.get(k)} vs ${r.moveM}`);
  }
  assert.ok(pinArr.length > 0, "pinpoint結果が存在");
});

// ===== P0-1 / P0-2: brute-force ground truth（moveM最小代表・落とさないprefilter） =====
// プレフィルタ無しで全分をスキャンした真値と、エンドポイント結果を突き合わせる。
// searchCore と同一の「月の照度<0.01の日はスキップ」を適用する。
function moonIllumSkip(ds) {
  const age = moonAge(new Date(ds + "T03:00:00Z"));
  const illum = (1 - Math.cos(2 * Math.PI * age / 29.53058867)) / 2;
  return illum < 0.01;
}
function groundTruthDay(t2, ds, isSun, budget) {
  if (!isSun && moonIllumSkip(ds)) return null; // searchCore と同条件
  const distM2 = hav(sLat, sLng, t2.lat, t2.lng) * 1000;
  const dayStart = new Date(ds + "T00:00:00+09:00").getTime();
  let best = null;
  for (let i = 0; i <= 1440; i++) {
    const dt = new Date(dayStart + i * 60000);
    const bp = isSun ? sunPos(dt, sLat, sLng) : moonPos(dt, sLat, sLng);
    const mg = idealMoveGeo(sLat, sLng, sElev, t2, bp.az, bp.alt, distM2, budget); // プレフィルタ無し全分
    if (!isFinite(mg.m)) continue;
    if (!best || mg.m < best.m) best = { m: mg.m, i };
  }
  return best;
}

test("P0-1/P0-2: 月chanceで、真の日別最小moveMをエンドポイントが落とさず代表もmoveM最小", async () => {
  // 近距離ケース（区間が長く乖離が出やすい）を30日で検証（月のみ／照度条件はsearchCore側で除外あり）
  const pc = dest(sLat, sLng, 120, 250); const tc = { lat: pc.lat, lng: pc.lng, elev: 20, h: 150 };
  const ch = await callChance("chance", { sunsetMode: false }, tc, 30);
  const chArr = Array.isArray(ch) ? ch : (ch.results || []);
  // エンドポイント結果を日別最小mへ
  const epByDay = new Map();
  for (const r of chArr) {
    const cur = epByDay.get(r.date);
    if (cur == null || r.moveM < cur) epByDay.set(r.date, r.moveM);
  }
  const start = new Date("2026-08-14T00:00:00+09:00").getTime();
  let comparedDays = 0, missing = 0, worse = 0;
  for (let d = 0; d < 30; d++) {
    const ds = new Date(start + d * 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    // 月の照度が極小の日は searchCore がスキップするため、ここでも同条件で除外
    const age = (() => { // moonAge 相当は不要。照度<0.01の日をscで除外するのに合わせ、endpointに無い日は真値も緩く扱う
      return null;
    })();
    const gt = groundTruthDay(tc, ds, false, 200);
    if (!gt || gt.m > 200) continue;             // 真値でchance対象外の日は比較しない
    comparedDays++;
    const ep = epByDay.get(ds);
    if (ep == null) { missing++; continue; }     // 真値≤200なのにエンドポイントに無い＝prefilterで落とした
    if (ep > gt.m + 1.0) worse++;                // 代表がmoveM最小になっていない
  }
  assert.ok(comparedDays >= 5, `十分な日数を比較（${comparedDays}日）`);
  assert.equal(missing, 0, `真値≤200の日を落としていない（落とし ${missing}日）＝prefilter superset`);
  assert.equal(worse, 0, `各日の代表がmoveM最小（非最小 ${worse}日）＝P0-1`);
});

test("P0-2(pinpoint): 真の日別最小moveM≤30の日をpinpointが落とさない（30日・月）", async () => {
  const pc = dest(sLat, sLng, 120, 250); const tc = { lat: pc.lat, lng: pc.lng, elev: 20, h: 150 };
  const pin = await callChance("pinpoint", { bodyFilter: "moon" }, tc, 30);
  const pinArr = Array.isArray(pin) ? pin : (pin.results || []);
  const epDays = new Set(pinArr.map(r => r.date));
  const start = new Date("2026-08-14T00:00:00+09:00").getTime();
  let cmp = 0, missing = 0;
  for (let d = 0; d < 30; d++) {
    const ds = new Date(start + d * 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const gt = groundTruthDay(tc, ds, false, 200);
    if (!gt || gt.m > 30) continue; // 真値でpinpoint対象の日のみ
    cmp++;
    if (!epDays.has(ds)) missing++;
  }
  assert.ok(cmp >= 1, `pinpoint対象日を比較（${cmp}日）`);
  assert.equal(missing, 0, `真値≤30の日を落としていない（落とし ${missing}日）`);
});
