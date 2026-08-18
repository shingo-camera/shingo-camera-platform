/**
 * P0: _buildTerrainPayload() が構図（compMode）を既存グローバル SSoT から取得し、
 * land→gSensor.w / port→gSensor.h で fovH を算出することを、実関数本文で固定する。
 *
 * 実 index.html から _buildTerrainPayload の関数本文を抽出し、スタブ環境で評価して検証する
 *（旧 input[name="comp"] shadow で常に land fallback になる不具合の再発防止）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, "../public/apps/hanabi/index.html"), "utf8");

// function _buildTerrainPayload( ... ) 本文を波括弧対応で抽出
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  let i = src.indexOf("{", start);
  let depth = 0;
  const bodyStart = start;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(bodyStart, i);
}

const fnSrc = extractFn(html, "_buildTerrainPayload");
assert.ok(fnSrc, "_buildTerrainPayload を抽出できる");
// shadow が無いこと（グローバル SSoT 使用）をソースレベルでも固定
assert.ok(!/const\s+compMode\s*=/.test(fnSrc), "ローカル const compMode で shadow していない");
// 実在しない DOM radio を「参照」していないこと（コメント言及は除外し querySelector 呼び出しのみ検査）
assert.ok(
  !/querySelector\([^)]*input\[name="comp"\]/.test(fnSrc),
  'querySelector で実在しない input[name="comp"] を参照していない',
);

// スタブ環境で実関数を評価。compMode/gSensor 等はクロージャ変数として注入する。
function makePayloadBuilder(env) {
  // env の各キーを引数名にして関数を包む → _buildTerrainPayload はそれらを自由変数として参照する。
  const keys = Object.keys(env);
  const factory = new Function(
    ...keys,
    "document",
    `${fnSrc}\n return _buildTerrainPayload;`,
  );
  const fakeDoc = {
    getElementById: (id) => {
      if (id === "sel-festival") return { value: "F1" };
      if (id === "sel-tube") return { value: "T1" };
      if (id === "sl-focal") return { value: String(env.__focal || 200) };
      return null;
    },
  };
  return factory(...keys.map((k) => env[k]), fakeDoc);
}

const baseEnv = (compMode) => ({
  compMode,
  viewManual: true,
  viewLat: 34.68,
  viewLng: 135.5,
  viewElev: 10,
  tripodH: 150,
  elevOffset: 0,
  treeHeightM: 20,
  gSensor: { w: 36, h: 24 }, // フルサイズ（w≠h で land/port を区別できる）
  _geParams: { azDeg: 45, focal: 200 },
  brng: () => 45,
  db: {
    tubes: [{ id: "T1", festivalId: "F1", lat: 34.7, lng: 135.52, nums: [10] }],
    numTable: [{ num: 10, dia: 320 }],
  },
  __focal: 200,
});

const R = Math.PI / 180;
const focal = 200;
const fovFromW = 2 * Math.atan(36 / (2 * focal)) * 180 / Math.PI;
const fovFromH = 2 * Math.atan(24 / (2 * focal)) * 180 / Math.PI;

test("[terrain-payload] land: fovH は gSensor.w 基準", () => {
  const build = makePayloadBuilder(baseEnv("land"));
  const p = build("front");
  assert.ok(p, "payload が構築される");
  assert.ok(Math.abs(p.fovHDeg - fovFromW) < 1e-9, `land fovH=${p.fovHDeg} expect ${fovFromW}`);
});

test("[terrain-payload] port: fovH は gSensor.h 基準", () => {
  const build = makePayloadBuilder(baseEnv("port"));
  const p = build("front");
  assert.ok(Math.abs(p.fovHDeg - fovFromH) < 1e-9, `port fovH=${p.fovHDeg} expect ${fovFromH}`);
});

test("[terrain-payload] 同一 sensor・同一 focal で land/port の fovH が正しく異なる", () => {
  const land = makePayloadBuilder(baseEnv("land"))("front");
  const port = makePayloadBuilder(baseEnv("port"))("front");
  assert.notEqual(land.fovHDeg, port.fovHDeg, "land と port で fovH が異なる");
  assert.ok(land.fovHDeg > port.fovHDeg, "w>h なので land(w基準) の方が広い");
});

/* ---- invalidate: setCompMode('port')→A→setCompMode('land') で旧 port の A が反映されない ---- */
const src = readFileSync(resolve(__dirname, "../public/apps/hanabi/terrain-request.js"), "utf8");
const moduleObj = { exports: {} };
new Function("module", "AbortController", src)(moduleObj, globalThis.AbortController);
const { createTerrainManager } = moduleObj.exports;
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

test("[terrain-payload] 構図変更 port→A→land で旧 port の A は反映されない", async () => {
  const defs = {};
  const results = [];
  const mgr = createTerrainManager({
    solve: (mode, payload) => { const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onResult: (mode, r) => results.push(r.tag),
  });
  // setCompMode('port') 相当 → terrain A（port の fovH で開始）
  mgr.request("front", { tag: "A_port" });
  await tick();
  // setCompMode('land') 相当 = 状態変更 → invalidate（onSetCompMode が _terrainInvalidate を呼ぶ経路）
  mgr.invalidate();
  // 旧 port の A が遅れて返る
  defs["A_port"].resolve({ ok: true, tag: "A_port" });
  await tick();
  assert.deepEqual(results, [], "port 状態の A は land へ反映されない");
});
