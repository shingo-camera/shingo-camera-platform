// SUN AND MOON 表示時刻整合：canonical fd.dt を最近傍1分へ丸めた displayDt を唯一の表示基準とし、
// date/time/azDiff/alt/angDiam を同一 displayDt から生成する。検索側（moveM/採否/★/candidate/sort/dedup/canonical/ts）は不変。
import test from "node:test";
import assert from "node:assert/strict";
import { jstDateTime } from "../src/apps/sun-and-moon/api/_astro.js";
import { onRequest as chanceReq } from "../src/apps/sun-and-moon/api/chance.js";
import { diskEval } from "../src/apps/sun-and-moon/api/_search.js";
import { brng, hav, elAng, dest, moonPos, sunPos } from "../src/apps/sun-and-moon/api/_astro.js";

const sLat = 35.6586, sLng = 139.7454, sElev = 20;
const tp = dest(sLat, sLng, 120, 400);
const t = { lat: tp.lat, lng: tp.lng, elev: 20, h: 200 };
const tAz = brng(sLat, sLng, t.lat, t.lng);

// displayDt = round(fd.dt to nearest minute)。jstDateTime は同一 Date から date/time を生成。
const roundDisp = (iso) => jstDateTime(new Date(Math.round(new Date(iso).getTime() / 60000) * 60000));

test("[丸め] 秒<30→当該分 / 秒=30→次分 / 秒>30→次分", () => {
  assert.deepEqual(roundDisp("2026-08-03T08:03:20+09:00"), { date: "2026-08-03", time: "08:03" });
  assert.deepEqual(roundDisp("2026-08-03T08:03:29.999+09:00"), { date: "2026-08-03", time: "08:03" });
  assert.deepEqual(roundDisp("2026-08-03T08:03:30+09:00"), { date: "2026-08-03", time: "08:04" }); // 30ちょうど→次分
  assert.deepEqual(roundDisp("2026-08-03T08:03:44+09:00"), { date: "2026-08-03", time: "08:04" }); // 実測ケース 08:03:44→08:04
});

test("[跨ぎ] 日跨ぎ23:59:30+→翌日00:00 / 月跨ぎ / 年跨ぎ（同一Dateから生成）", () => {
  assert.deepEqual(roundDisp("2026-08-14T23:59:30+09:00"), { date: "2026-08-15", time: "00:00" });
  assert.deepEqual(roundDisp("2026-08-14T23:59:29+09:00"), { date: "2026-08-14", time: "23:59" });
  assert.deepEqual(roundDisp("2026-08-31T23:59:40+09:00"), { date: "2026-09-01", time: "00:00" }); // 月跨ぎ
  assert.deepEqual(roundDisp("2026-12-31T23:59:45+09:00"), { date: "2027-01-01", time: "00:00" }); // 年跨ぎ
});

// 実API
async function callChance(mode, days) {
  const body = { sLat, sLng, sElev, t, dateStr: "2026-08-14", mode, dayOffset: 0, dayCount: days || 365, bodyFilter: "both" };
  const req = new Request("https://x/api/chance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await (await chanceReq({ request: req })).json();
}
const arrOf = (p) => Array.isArray(p) ? p : (p.results || []);
const isSunOf = (r) => r.isSun === true || (r.isSun === undefined && r.age == null);

test("[実API] chance/pinpoint とも displayDt=round(ts) で date/time を生成（同一丸め規則・月/太陽・PP/CH）", async () => {
  const ch = arrOf(await callChance("chance"));
  const pin = arrOf(await callChance("pinpoint"));
  const all = [...ch, ...pin];
  assert.ok(all.length > 0);
  let nSun = 0, nMoon = 0, nPP = 0, nCH = 0;
  for (const r of all) {
    const ts = typeof r.ts === "number" ? r.ts : new Date(r.ts).getTime();
    const exp = jstDateTime(new Date(Math.round(ts / 60000) * 60000));
    assert.equal(r.date, exp.date, `date=round(ts) ${r.date} ${r.time}`);
    assert.equal(r.time, exp.time, `time=round(ts) ${r.date} ${r.time}`);
    const sec = new Date(ts + 9 * 3600000).getUTCSeconds();
    const floorT = new Date(Math.floor(ts / 60000) * 60000 + 9 * 3600000).toISOString().substr(11, 5);
    const ceilT = new Date((Math.floor(ts / 60000) + 1) * 60000 + 9 * 3600000).toISOString().substr(11, 5);
    assert.equal(r.time, sec < 30 ? floorT : ceilT, `秒${sec}の丸め方向`);
    if (isSunOf(r)) nSun++; else nMoon++;
    if (r.moveM <= 30) nPP++; else nCH++;
  }
  assert.ok(nSun > 0 && nMoon > 0, "月・太陽双方");
  assert.ok(nPP > 0 && nCH > 0, "PINPOINT・CHANCE双方");
});

test("[同一時刻由来] date/time/azDiff/alt/angDiam が同一 displayDt から生成されている", async () => {
  const all = [...arrOf(await callChance("chance")), ...arrOf(await callChance("pinpoint"))];
  for (const r of all) {
    const isSun = isSunOf(r);
    const disp = new Date(`${r.date}T${r.time}:00+09:00`);
    const bp = isSun ? sunPos(disp, sLat, sLng) : moonPos(disp, sLat, sLng);
    const azd = Math.abs(((bp.az - tAz + 540) % 360) - 180);
    assert.ok(Math.abs(bp.alt - r.alt) < 1e-6, `alt=displayDt由来 ${r.date} ${r.time}`);
    assert.ok(Math.abs(azd - r.azDiff) < 1e-6, `azDiff=displayDt由来 ${r.date} ${r.time}`);
    assert.ok(Math.abs((bp.angDiam || 0.53) - r.angDiam) < 1e-6, `angDiam=displayDt由来 ${r.date} ${r.time}`);
  }
});

test("[非回帰] moveM/採否閾値/ts は不変（ts=canonical・moveMはts時刻由来）", async () => {
  const ch = arrOf(await callChance("chance"));
  const pin = arrOf(await callChance("pinpoint"));
  for (const r of ch)  assert.ok(r.moveM <= 200 + 1e-6, `chance≤200 ${r.moveM}`);
  for (const r of pin) assert.ok(r.moveM <= 30 + 1e-6, `pinpoint≤30 ${r.moveM}`);
  // ts は canonical：その時刻の moveM が結果 moveM と一致（displayDt由来ではない＝丸めていない）
  for (const r of pin.slice(0, 20)) {
    const ts = typeof r.ts === "number" ? r.ts : new Date(r.ts).getTime();
    const de = diskEval(sLat, sLng, sElev, t, new Date(ts), isSunOf(r));
    assert.ok(Math.abs(de.moveM - r.moveM) < 1e-6, `moveM は canonical ts 由来 ${r.date} ${r.time}`);
    // ts に秒が残る（canonical sub-minute）ことがある＝displayDtへ丸めていない
  }
});
