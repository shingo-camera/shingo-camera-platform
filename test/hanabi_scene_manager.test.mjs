/**
 * HANABI scene リクエストマネージャ（scene-request-manager.js）のテスト。
 *
 * 検証:
 *  - stale response 破棄: request A → request B → B応答 → A応答 でも、A が最新状態を上書きしない。
 *  - fail-closed: solve 失敗時は cache を消し error 状態にする（旧計算へ fallback しない）。
 *  - 二重送信防止: 同一 key 計算中は再送しない。
 *  - cache ヒット: 最新 key の結果があれば solve を呼ばない。
 *  - payload null（描画不能）は cache クリア・idle。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// scene-request-manager.js はブラウザ向け IIFE（window.HBScene に公開）。ブラウザと同様に window へ載せて読む。
const mgrSrc = readFileSync("public/apps/hanabi/scene-request-manager.js", "utf8");
const sandbox = { window: {}, Promise, setTimeout, clearTimeout, AbortController, Date, console };
vm.createContext(sandbox);
vm.runInContext(mgrSrc, sandbox);
const createSceneManager = sandbox.window.HBScene.createSceneManager;

// macrotask 待ち（solve は debounce タイマ内の microtask で呼ばれるため tick で流す）
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeControllableTimers() {
  let queue = [];
  return {
    setTimeoutFn: (fn) => { queue.push(fn); return queue.length; },
    clearTimeoutFn: () => {},
    flush: () => { const q = queue; queue = []; q.forEach((fn) => fn()); },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("[scene-mgr] stale 破棄（debounce前に越されたら solve しない）: A→B→flush で B のみ solve", async () => {
  const timers = makeControllableTimers();
  const defs = {};
  let calls = 0;
  const mgr = createSceneManager({
    solve: (payload) => { calls++; const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onState: () => {},
    debounceMs: 0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  // request A → request B（両方 debounce 前）。B が A を越すので flush 時 A は solve されない。
  mgr.request({ tag: "A" }, "keyA");
  mgr.request({ tag: "B" }, "keyB");
  timers.flush();
  await tick();
  assert.equal(calls, 1, "越された A は solve されない（B のみ）");
  assert.ok(!defs["A"], "A の solve は始まらない");
  assert.ok(defs["B"], "B の solve が始まる");

  defs["B"].resolve({ val: "B" });
  await tick();
  assert.equal(mgr.resultFor("keyB")?.val, "B", "B の結果が cache に入る");
  assert.equal(mgr.resultFor("keyA"), null, "A の結果は cache に入らない");
  assert.equal(mgr.getState(), "ok");
});

test("[scene-mgr] fail-closed: solve 失敗で cache を消し error 状態（fallback しない）", async () => {
  const timers = makeControllableTimers();
  let d;
  const mgr = createSceneManager({
    solve: () => { d = deferred(); return d.promise; },
    onState: () => {},
    debounceMs: 0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  mgr.request({ tag: "ok" }, "k1");
  timers.flush();
  await tick();
  d.resolve({ val: 1 });
  await tick();
  assert.equal(mgr.resultFor("k1")?.val, 1);

  mgr.request({ tag: "fail" }, "k2");
  timers.flush();
  await tick();
  d.reject(new Error("API_500"));
  await tick();
  assert.equal(mgr.getState(), "error", "失敗で error 状態");
  assert.equal(mgr.resultFor("k2"), null, "失敗結果は cache に入らない");
  assert.equal(mgr.resultFor("k1"), null, "cache はクリアされる（古い結果へ fallback しない）");
});

test("[scene-mgr] 二重送信防止: 同一 key 計算中は solve を再呼び出ししない", async () => {
  const timers = makeControllableTimers();
  let calls = 0;
  let d;
  const mgr = createSceneManager({
    solve: () => { calls++; d = deferred(); return d.promise; },
    onState: () => {},
    debounceMs: 0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  mgr.request({ tag: "x" }, "kx");
  timers.flush();
  await tick();
  assert.equal(calls, 1);
  mgr.request({ tag: "x" }, "kx"); // 計算中に同 key
  timers.flush();
  await tick();
  assert.equal(calls, 1, "同 key 計算中は再送しない");
  d.resolve({ val: 9 });
  await tick();
});

test("[scene-mgr] cache ヒット: 最新 key の結果があれば solve を呼ばない", async () => {
  const timers = makeControllableTimers();
  let calls = 0;
  let d;
  const mgr = createSceneManager({
    solve: () => { calls++; d = deferred(); return d.promise; },
    onState: () => {},
    debounceMs: 0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  mgr.request({ tag: "a" }, "ka");
  timers.flush();
  await tick();
  d.resolve({ val: 1 });
  await tick();
  assert.equal(calls, 1);
  mgr.request({ tag: "a" }, "ka"); // 同 key → cache ヒット
  timers.flush();
  await tick();
  assert.equal(calls, 1, "cache ヒット時は solve を呼ばない");
});

test("[scene-mgr] payload null（描画不能）は cache クリア・idle", () => {
  const timers = makeControllableTimers();
  const mgr = createSceneManager({
    solve: () => Promise.resolve({}),
    onState: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  mgr.request(null, null);
  assert.equal(mgr.getState(), "idle");
  assert.equal(mgr.getCache(), null);
});

/* ---- P0-1: error 状態からの再試行（入力 key 変化で再送、同一 key は自動再送しない） ---- */
test("[scene-mgr] error 後: keyB request で solve 実行され B 成功（error から再試行できる）", async () => {
  const timers = makeControllableTimers();
  const defs = {};
  let calls = 0;
  const mgr = createSceneManager({
    solve: (payload) => { calls++; const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onState: () => {},
    debounceMs: 0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  // keyA を失敗させる
  mgr.request({ tag: "A" }, "keyA");
  timers.flush();
  await tick();
  defs["A"].reject(new Error("API_500"));
  await tick();
  assert.equal(mgr.getState(), "error");
  assert.equal(calls, 1);

  // 同一 keyA を再要求しても自動再送しない（無限 retry 防止）
  mgr.request({ tag: "A" }, "keyA");
  timers.flush();
  await tick();
  assert.equal(calls, 1, "同一 failed key は再送しない");
  assert.equal(mgr.getState(), "error");

  // 入力 key が変われば（keyB）error から再試行できる
  mgr.request({ tag: "B" }, "keyB");
  timers.flush();
  await tick();
  assert.equal(calls, 2, "keyB で solve 実行");
  defs["B"].resolve({ val: "B" });
  await tick();
  assert.equal(mgr.getState(), "ok");
  assert.equal(mgr.resultFor("keyB")?.val, "B", "B 成功");
});

/* ---- P0-3: payload=null でも旧 generation を無効化する ---- */
test("[scene-mgr] P0-3: A solve中に request(null) → idle/cache=null、遅れて A resolve でも不変", async () => {
  const timers = makeControllableTimers();
  const defs = {};
  const states = [];
  const mgr = createSceneManager({
    solve: (payload) => { const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onState: (s) => states.push(s),
    debounceMs: 0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  // 1. A request → 2. A solve 開始
  mgr.request({ tag: "A" }, "keyA");
  timers.flush();
  await tick();
  assert.ok(defs["A"], "A solve 開始");

  // 3. request(null, null)（描画不能へ遷移）
  mgr.request(null, null);
  // 4. state=idle / cache=null
  assert.equal(mgr.getState(), "idle");
  assert.equal(mgr.getCache(), null);

  // 5. 遅れて A resolve（stale）
  defs["A"].resolve({ val: "A" });
  await tick();
  // 6. state は idle のまま 7. cache も null のまま
  assert.equal(mgr.getState(), "idle", "stale A の resolve で state を変えない");
  assert.equal(mgr.getCache(), null, "stale A の resolve で cache を変えない");
  assert.equal(mgr.resultFor("keyA"), null);
});

/* ---- P0-4: cache hit へ戻った時も別 key inflight を stale 化する ---- */
test("[scene-mgr] P0-4: A成功→B solve中にAへ戻る → A cache即利用、B resolve でも cache は A", async () => {
  const timers = makeControllableTimers();
  const defs = {};
  const mgr = createSceneManager({
    solve: (payload) => { const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onState: () => {},
    debounceMs: 0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  // 1. A request → A 成功 → cache=A
  mgr.request({ tag: "A" }, "keyA");
  timers.flush();
  await tick();
  defs["A"].resolve({ val: "A" });
  await tick();
  assert.equal(mgr.resultFor("keyA")?.val, "A", "cache=A");

  // 2. B request → B solve 開始
  mgr.request({ tag: "B" }, "keyB");
  timers.flush();
  await tick();
  assert.ok(defs["B"], "B solve 開始");

  // 3. B 未応答のまま A request（cache hit へ戻る）
  mgr.request({ tag: "A" }, "keyA");
  // 4. A cache を即利用（state=ok・cache=A）
  assert.equal(mgr.getState(), "ok", "A へ戻ると即 ok");
  assert.equal(mgr.resultFor("keyA")?.val, "A", "A の cache を即利用");

  // 5. B resolve（stale）
  defs["B"].resolve({ val: "B" });
  await tick();
  // 6. cache は A のまま 7. state=ok
  assert.equal(mgr.resultFor("keyA")?.val, "A", "B は cache を上書きしない");
  assert.equal(mgr.resultFor("keyB"), null, "B は cache に入らない");
  assert.equal(mgr.getState(), "ok");
});

/* ---- P0-2: request 受付順が generation の正本（debounce 未flushでも A を stale 化） ---- */
test("[scene-mgr] P0-2: A solve中に B request 受付 → A 応答は cache へ入らない → B 成功", async () => {
  const timers = makeControllableTimers();
  const defs = {};
  const mgr = createSceneManager({
    solve: (payload) => { const d = deferred(); defs[payload.tag] = d; return d.promise; },
    onState: () => {},
    debounceMs: 0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  // 1. A request → 2. A solve 開始
  mgr.request({ tag: "A" }, "keyA");
  timers.flush();
  await tick();
  assert.ok(defs["A"], "A solve 開始");

  // 3. B request（まだ debounce 未 flush）→ generation は B 受付で進む
  mgr.request({ tag: "B" }, "keyB");

  // 4. A resolve（B の debounce 未 flush）→ 5. A は cache へ入らない
  defs["A"].resolve({ val: "A" });
  await tick();
  assert.equal(mgr.resultFor("keyA"), null, "A は cache に入らない（受付順で stale）");

  // 6. B debounce 発火 → 7. B 成功
  timers.flush();
  await tick();
  assert.ok(defs["B"], "B solve 開始");
  defs["B"].resolve({ val: "B" });
  await tick();
  assert.equal(mgr.resultFor("keyB")?.val, "B", "B 成功で cache は B");
  assert.equal(mgr.resultFor("keyA"), null, "A は依然 cache に入らない");
  assert.equal(mgr.getState(), "ok");
});
