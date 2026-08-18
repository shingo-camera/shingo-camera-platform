/**
 * Phase C2: downloadGoogleEarthKml が scene-solve 結果を consume し、
 * 旧 calcWindOffset へ fallback しない（fail-closed）ことをソース経路で固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, "../public/apps/hanabi/index.html"), "utf8");

function funcBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

const kml = funcBody(html, "downloadGoogleEarthKml");

test("[kml-wire] downloadGoogleEarthKml が存在する", () => {
  assert.ok(kml, "関数抽出");
});

test("[kml-wire] calcWindOffset を呼ばない（scene 結果を consume）", () => {
  assert.ok(!/calcWindOffset\(/.test(kml), "KML 経路で calcWindOffset を実行しない");
});

test("[kml-wire] scene-solve 結果（_sceneMgr.resultFor / bursts.fwAzDeg）を参照する", () => {
  assert.ok(/_sceneMgr\.resultFor/.test(kml), "scene cache を参照");
  assert.ok(/\.fwAzDeg/.test(kml) && /\.fwDkm/.test(kml), "burst の fwAzDeg/fwDkm を使う");
});

test("[kml-wire] fail-closed: scene 無しなら旧式で作らず中止（_requestScene 要求）", () => {
  assert.ok(/_kmlScene\.ok!==true|!_kmlScene/.test(kml), "scene 結果の有無を確認");
  assert.ok(/_requestScene\(\)/.test(kml), "scene が無ければ再計算を要求");
  assert.ok(/return;/.test(kml), "fail-closed で中止する経路がある");
});

test("[kml-wire] burst altitude は tubeElev+height の一般計算のまま（datum 非改変）", () => {
  assert.ok(/tubeElev \+ row\.height|rowAlt = tubeElev/.test(kml), "rowAlt は tubeElev+height");
  // magic offset / geoid 補正の新規追加が無い（代表的な語を含まない）
  assert.ok(!/geoid|EGM96|magicOffset/i.test(kml), "新しい datum 補正を追加していない");
});

test("[kml-wire] kunitomo は scene の kmlKunitomo を consume（独自式を実行しない）", () => {
  assert.ok(/kmlKunitomo/.test(kml), "kmlKunitomo を参照");
  assert.ok(!/Math\.sin\(theta\) \* Math\.sin\(theta\)/.test(kml), "h=H·sin²θ を実行しない");
  assert.ok(!/1\.65/.test(kml.replace(/\/\/.*$/gm, "")), "1.65 補正の実行式が無い（コメント除く）");
});

test("[kml-wire] completeness fail-closed: 欠落時は KML 全体を生成せず中止", () => {
  // 事前 completeness 検証 → 不足で return する経路がある
  assert.ok(/_complete/.test(kml), "completeness フラグで検証する");
  assert.ok(/計算結果を取得できませんでした/.test(kml), "明示的なエラーメッセージ");
});

test("[kml-wire] completeness に kmlKunitomo も含む（P0 rev3）", () => {
  // completeness 検証が kmlKunitomo と必要 horzDeg・finite を確認している
  assert.ok(/kmlKunitomo/.test(kml), "completeness で kmlKunitomo を参照");
  assert.ok(/kunitomoNums/.test(kml) && /horzDeg/.test(kml), "kunitomoNums の必要 horzDeg を検証");
  assert.ok(/isFinite/.test(kml), "lat/lng/alt の有限性を検証");
  assert.ok(/\[-60,\s*-30,\s*0,\s*30,\s*60\]/.test(kml) && /\[-30,\s*0,\s*30\]/.test(kml), "5方向/3方向の必要点");
});

/* ---- completeness 述語の機能検証（scene 結果の充足判定） ---- */
import { solveScene as _solve } from "./_bundle/hanabi_scene.mjs";
import { readFileSync as _rf } from "node:fs";

// downloadGoogleEarthKml の completeness と同一述語を再現して判定を固定する
// （normal burst + kmlKunitomo の両方）
function isComplete(sceneTubeById, tubes, numTable) {
  for (const tb of tubes) {
    if (tb.enabled === false) continue;
    const str = sceneTubeById[tb.id];
    if (!str || !Array.isArray(str.bursts)) return false;
    const validNums = (tb.nums || []).filter((n) => numTable.find((r) => r.num === n));
    // (1) normal burst
    for (const n of validNums) {
      if (!str.bursts.some((b) => b.num === String(n))) return false;
    }
    // (2) kmlKunitomo（kunitomoNums[num]>0 の号数のみ）
    const kNums = tb.kunitomoNums || {};
    const kmlKuniArr = Array.isArray(str.kmlKunitomo) ? str.kmlKunitomo : null;
    for (const n of validNums) {
      const cnt = kNums[n] || 0;
      if (!(cnt > 0)) continue;
      if (!kmlKuniArr) return false;
      const needDirs = cnt === 5 ? [-60, -30, 0, 30, 60] : [-30, 0, 30];
      for (const hd of needDirs) {
        const pt = kmlKuniArr.find((k) => k.num === String(n) && k.horzDeg === hd);
        if (!pt || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lng) || !Number.isFinite(pt.alt)) return false;
      }
    }
  }
  return true;
}

const NUM = [
  { num: "3", height: 180, dia: 90 },
  { num: "5", height: 220, dia: 140 },
  { num: "10", height: 330, dia: 280 },
];
function sceneReq(tubes) {
  return {
    viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    camera: { focal: 100, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
    festivalTubes: tubes, targets: [], numTable: NUM, selectedTubeId: tubes[0].id, wind: null,
  };
}
function byId(res) { const m = {}; for (const t of res.tubes) m[t.id] = t; return m; }

test("[kml-complete] 全件揃う → KML 生成可能", () => {
  const tubes = [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5"], enabled: true }];
  const res = _solve(sceneReq(tubes));
  assert.equal(isComplete(byId(res), tubes, NUM), true);
});

test("[kml-complete] 1筒場1号数の scene 結果欠落 → download 不可", () => {
  const tubes = [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5"], enabled: true }];
  const res = _solve(sceneReq(tubes));
  const m = byId(res);
  // 1 号数分の burst を欠落させる
  m["T1"].bursts = m["T1"].bursts.filter((b) => b.num !== "5");
  assert.equal(isComplete(m, tubes, NUM), false);
});

test("[kml-complete] 複数筒場のうち1件の tube 結果欠落 → download 不可", () => {
  const tubes = [
    { id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3"], enabled: true },
    { id: "T2", festivalId: "F", lat: 34.71, lng: 135.53, elev: 8, elevOffset: 0, nums: ["10"], enabled: true },
  ];
  const res = _solve(sceneReq(tubes));
  const m = byId(res);
  delete m["T2"]; // 1 筒場分の結果が丸ごと無い
  assert.equal(isComplete(m, tubes, NUM), false);
});

test("[kml-complete] disabled 筒場は completeness 判定から除外", () => {
  const tubes = [
    { id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3"], enabled: true },
    { id: "T2", festivalId: "F", lat: 34.71, lng: 135.53, elev: 8, elevOffset: 0, nums: ["10"], enabled: false },
  ];
  const res = _solve(sceneReq(tubes));
  const m = byId(res);
  assert.equal(isComplete(m, tubes, NUM), true, "無効筒場は必須ではない");
});

/* ---- kmlKunitomo completeness（P0・rev3） ---- */
function kuniReq(tubes) {
  return {
    viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    camera: { focal: 100, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
    festivalTubes: tubes, targets: [], numTable: NUM, selectedTubeId: tubes[0].id, wind: null,
  };
}
// wiring test 冒頭で読んだ NUM は num "3","5","10"。3号=3方向, 5号=5方向 を使う。

test("[kml-kuni-complete] kunitomoNums=3 → 3点揃う → 生成可能", () => {
  const tubes = [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3"], enabled: true, ougiAz: 0, kunitomoNums: { "3": 3 } }];
  const res = _solve(kuniReq(tubes));
  const m = byId(res);
  assert.equal(m["T1"].kmlKunitomo.filter((k) => k.num === "3").length, 3, "3点");
  assert.equal(isComplete(m, tubes, NUM), true);
});

test("[kml-kuni-complete] 3点中1点欠落 → 生成不可", () => {
  const tubes = [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3"], enabled: true, ougiAz: 0, kunitomoNums: { "3": 3 } }];
  const res = _solve(kuniReq(tubes));
  const m = byId(res);
  m["T1"].kmlKunitomo = m["T1"].kmlKunitomo.filter((k) => !(k.num === "3" && k.horzDeg === 30)); // +30 欠落
  assert.equal(isComplete(m, tubes, NUM), false);
});

test("[kml-kuni-complete] kunitomoNums=5 → 5点揃う → 生成可能", () => {
  const tubes = [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["5"], enabled: true, ougiAz: 0, kunitomoNums: { "5": 5 } }];
  const res = _solve(kuniReq(tubes));
  const m = byId(res);
  assert.equal(m["T1"].kmlKunitomo.filter((k) => k.num === "5").length, 5, "5点");
  assert.equal(isComplete(m, tubes, NUM), true);
});

test("[kml-kuni-complete] 5点中1点欠落 → 生成不可", () => {
  const tubes = [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["5"], enabled: true, ougiAz: 0, kunitomoNums: { "5": 5 } }];
  const res = _solve(kuniReq(tubes));
  const m = byId(res);
  m["T1"].kmlKunitomo = m["T1"].kmlKunitomo.filter((k) => !(k.num === "5" && k.horzDeg === -60)); // -60 欠落
  assert.equal(isComplete(m, tubes, NUM), false);
});

test("[kml-kuni-complete] normal burst は揃うが kmlKunitomo だけ欠落 → 生成不可", () => {
  const tubes = [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["5"], enabled: true, ougiAz: 0, kunitomoNums: { "5": 5 } }];
  const res = _solve(kuniReq(tubes));
  const m = byId(res);
  m["T1"].kmlKunitomo = []; // kmlKunitomo 全欠落（normal burst は残す）
  assert.ok(m["T1"].bursts.some((b) => b.num === "5"), "normal burst は存在");
  assert.equal(isComplete(m, tubes, NUM), false);
});

test("[kml-kuni-complete] 複数筒場のうち1筒場の kmlKunitomo 欠落 → 生成不可", () => {
  const tubes = [
    { id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3"], enabled: true, ougiAz: 0, kunitomoNums: { "3": 3 } },
    { id: "T2", festivalId: "F", lat: 34.71, lng: 135.53, elev: 8, elevOffset: 0, nums: ["5"], enabled: true, ougiAz: 0, kunitomoNums: { "5": 5 } },
  ];
  const res = _solve(kuniReq(tubes));
  const m = byId(res);
  m["T2"].kmlKunitomo = m["T2"].kmlKunitomo.filter((k) => k.horzDeg !== 0); // T2 の真上欠落
  assert.equal(isComplete(m, tubes, NUM), false);
});

test("[kml-kuni-complete] kunitomoNums 未設定 → kmlKunitomo completeness を要求しない", () => {
  const tubes = [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5"], enabled: true }];
  const res = _solve(kuniReq(tubes));
  const m = byId(res);
  assert.deepEqual(m["T1"].kmlKunitomo, [], "kmlKunitomo は空");
  assert.equal(isComplete(m, tubes, NUM), true, "国友未設定なら normal burst だけで可");
});

test("[kml-kuni-complete] lat/lng/alt に NaN/Infinity → 生成不可", () => {
  const tubes = [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3"], enabled: true, ougiAz: 0, kunitomoNums: { "3": 3 } }];
  const res = _solve(kuniReq(tubes));
  const m = byId(res);
  const pt = m["T1"].kmlKunitomo.find((k) => k.num === "3" && k.horzDeg === 0);
  pt.alt = NaN;
  assert.equal(isComplete(m, tubes, NUM), false, "NaN で不可");
  pt.alt = Infinity;
  assert.equal(isComplete(m, tubes, NUM), false, "Infinity で不可");
});
