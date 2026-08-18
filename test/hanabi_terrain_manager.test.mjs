/**
 * terrain-request.js（HBTerrain.createTerrainManager）の stale / fail-closed テスト。
 * Phase A scene-manager とは独立系統（terrain 専用の最小 generation/abort）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// terrain-request.js はブラウザ向け IIFE（window.HBTerrain に公開）。ブラウザ同様に window へ載せて読む。
const src = readFileSync("public/apps/hanabi/terrain-request.js", "utf8");
const sandbox = { window: {}, module: undefined, Promise, setTimeout, clearTimeout, AbortController, Date, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const createTerrainManager = sandbox.window.HBTerrain.createTerrainManager;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("[terrain-mgr] 最新 request の結果のみ onResult へ（stale 破棄）", async () => {
  const defs = {};
  const results = [];
  const mgr = createTerrainManager({
    solve: (mode, payload) => { const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onResult: (mode, r) => results.push(r),
    onError: () => results.push("ERR"),
  });

  mgr.request("front", { tag: "A" });
  await tick();
  mgr.request("front", { tag: "B" }); // A を stale 化・abort
  await tick();

  defs["A"].resolve({ ok: true, tag: "A" }); // 遅れて A
  await tick();
  assert.equal(results.length, 0, "stale A は onResult されない");

  defs["B"].resolve({ ok: true, tag: "B" });
  await tick();
  assert.equal(results.length, 1);
  assert.equal(results[0].tag, "B", "最新 B のみ反映");
});

test("[terrain-mgr] fail-closed: solve 失敗で onError（旧計算へ fallback しない）", async () => {
  const d = deferred();
  let errCalled = false;
  let resultCalled = false;
  const mgr = createTerrainManager({
    solve: () => d.promise,
    onResult: () => { resultCalled = true; },
    onError: () => { errCalled = true; },
  });
  mgr.request("front", { tag: "A" });
  await tick();
  d.reject(new Error("TERRAIN_UNAVAILABLE"));
  await tick();
  assert.equal(errCalled, true, "onError が呼ばれる");
  assert.equal(resultCalled, false, "onResult は呼ばれない");
});

test("[terrain-mgr] stale なエラーは無視（新 request 後の旧エラーで onError しない）", async () => {
  const defs = {};
  let errCount = 0;
  const mgr = createTerrainManager({
    solve: (mode, payload) => { const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onResult: () => {},
    onError: () => { errCount++; },
  });
  mgr.request("front", { tag: "A" });
  await tick();
  mgr.request("front", { tag: "B" });
  await tick();
  defs["A"].reject(new Error("stale")); // 古い A のエラー
  await tick();
  assert.equal(errCount, 0, "stale A のエラーは無視");
  defs["B"].resolve({ ok: true, tag: "B" });
  await tick();
});

test("[terrain-mgr] invalidate で進行中を stale 化（結果を捨てる）", async () => {
  const d = deferred();
  let resultCalled = false;
  const mgr = createTerrainManager({
    solve: () => d.promise,
    onResult: () => { resultCalled = true; },
    onError: () => {},
  });
  mgr.request("front", { tag: "A" });
  await tick();
  mgr.invalidate(); // 視点変更等で既存 terrain を破棄
  d.resolve({ ok: true, tag: "A" });
  await tick();
  assert.equal(resultCalled, false, "invalidate 後の結果は反映しない");
});
