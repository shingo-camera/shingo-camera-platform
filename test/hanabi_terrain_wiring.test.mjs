/**
 * P0: terrain manager invalidate が実際の UI 状態変更経路へ接続されていることを固定する。
 *
 * 2 段構成:
 *  1) 実ファイル（index.html）経路検証: _buildTerrainPayload の値を変える各ハンドラが
 *     _terrainInvalidate()（= _terrainMgr.invalidate()）を呼ぶことを、ソース上で固定。
 *     「invalidate() が存在するだけ」ではなく、実 UI ハンドラから呼ばれることを検証する。
 *  2) 機能検証: manager の invalidate 後に旧 inflight response が onResult されないことを固定。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, "../public/apps/hanabi/index.html"), "utf8");

// 指定関数の本文を粗く抽出（function NAME( ... ) の波括弧対応で本文を取り出す）
function funcBody(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  // 関数開始の '{' を探す
  let i = src.indexOf("{", start);
  if (i < 0) return null;
  let depth = 0;
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(bodyStart, i);
}

// _buildTerrainPayload の値に影響する各状態変更ハンドラ（棚卸し結果）
const funnels = {
  onViewPick: "撮影地 lat/lng/elev",
  onTubeChange: "選択筒場 / festival / allTubes / maxDiaHalf",
  onSlider: "焦点距離 / azOffset（PC）",
  onMobSlider: "焦点距離 / azOffset（モバイル）",
  setCompMode: "compMode（fovH）",
  setSensor: "sensor（fovH）",
  setTreeHeight: "treeHeight",
  shiftTripod: "tripodH（sElev）",
  shiftElevOffset: "elevOffset（sElev）",
};

for (const [fn, what] of Object.entries(funnels)) {
  test(`[terrain-wire] ${fn} が terrain invalidate を呼ぶ（${what}）`, () => {
    const body = funcBody(html, fn);
    assert.ok(body, `${fn} が index.html に存在する`);
    assert.ok(
      /_terrainInvalidate\(\)/.test(body),
      `${fn} は状態変更時に _terrainInvalidate() を呼ぶ（terrain request を無効化）`,
    );
  });
}

test("[terrain-wire] _terrainInvalidate は _terrainMgr.invalidate() を呼ぶ", () => {
  const body = funcBody(html, "_terrainInvalidate");
  assert.ok(body, "_terrainInvalidate が存在する");
  assert.ok(/_terrainMgr\s*&&/.test(body) && /\.invalidate\(\)/.test(body), "invalidate へ委譲する");
});

test("[terrain-wire] tripod/elev キーパッド OK も invalidate を呼ぶ", () => {
  // キーパッド確定（handleHkKey 等）からの tripodH/elevOffset 変更経路
  assert.ok(
    /_terrainInvalidate\(\);\s*tripodH=n/.test(html),
    "tripod パッド OK で invalidate",
  );
  assert.ok(
    /_terrainInvalidate\(\);\s*\n?\s*elevOffset=/.test(html),
    "elevOffset パッド OK で invalidate",
  );
});

/* ---- 機能検証: invalidate 後は旧 inflight を採用しない ---- */
const src = readFileSync(resolve(__dirname, "../public/apps/hanabi/terrain-request.js"), "utf8");
const moduleObj = { exports: {} };
new Function("module", "AbortController", src)(moduleObj, globalThis.AbortController);
const { createTerrainManager } = moduleObj.exports;
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

test("[terrain-wire] 機能: A開始 → invalidate（状態変更相当）→ A resolve → onResult されない", async () => {
  const defs = {};
  let okCount = 0;
  const mgr = createTerrainManager({
    solve: (mode, payload) => { const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onResult: () => okCount++,
  });
  mgr.request("front", { tag: "A" });
  await tick();
  mgr.invalidate(); // viewpoint/tube/focal 変更相当
  defs["A"].resolve({ ok: true, tag: "A" });
  await tick();
  assert.equal(okCount, 0, "invalidate 後の A は最新画面へ反映されない");
});

test("[terrain-wire] 機能: tube/focal 変更相当（新 request）でも旧 A は破棄", async () => {
  const defs = {};
  const results = [];
  const mgr = createTerrainManager({
    solve: (mode, payload) => { const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onResult: (mode, r) => results.push(r.tag),
  });
  mgr.request("front", { tag: "A" });        // terrain A 開始
  await tick();
  mgr.invalidate();                           // tube 変更（onTubeChange 相当）
  mgr.request("front", { tag: "B" });         // focal 変更後の新規取得（onSlider→ボタン相当）
  await tick();
  defs["A"].resolve({ ok: true, tag: "A" });  // 旧 A が遅れて返る
  await tick();
  defs["B"].resolve({ ok: true, tag: "B" });
  await tick();
  assert.deepEqual(results, ["B"], "A は破棄され B のみ反映");
});
