/**
 * Rev4 追加実装: 地図クリック時の (1) UI 先行反映 と (2) onViewPick stale race 修正。
 *
 * (1) 標高非依存の水平幾何（drawViewLines/drawFovLines）を getElev() 前に先行描画する。
 *     標高依存の表示（ラベルの E:標高・仰角）・scene/terrain/calcCamParams/layout は await 後に確定。
 * (2) A クリック→A の getElev 待ち中に B クリック→B が最新、のとき、遅れて返った A の continuation が
 *     B を上書きしないよう世代ガード（_viewGen）で A を破棄する。global viewElev は guard 通過後にのみ書く。
 *
 * onViewPick は map/getElev/DOM に強く依存するため、ここでは実装（source）構造と、世代ガードの
 * 論理を最小 harness で検証する（計算 core は非対象）。
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
  if (start < 0) {
    const a = src.indexOf(`async function ${name}(`);
    if (a < 0) return null;
    return sliceFn(src, a);
  }
  return sliceFn(src, start);
}
function sliceFn(src, start) {
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

const onViewPick = funcBody(html, "onViewPick");

test("[mapclick] onViewPick 抽出できる", () => {
  assert.ok(onViewPick, "onViewPick 抽出");
});

test("[mapclick][UI先行] drawViewLines/drawFovLines を getElev の await より前に呼ぶ", () => {
  const awaitIdx = onViewPick.indexOf("await getElev");
  assert.ok(awaitIdx > 0, "await getElev がある");
  const before = onViewPick.slice(0, awaitIdx);
  // 標高非依存の水平幾何は await 前に先行描画される
  assert.ok(before.indexOf("drawViewLines()") >= 0, "drawViewLines を await 前に呼ぶ");
  assert.ok(before.indexOf("drawFovLines()") >= 0, "drawFovLines を await 前に呼ぶ");
});

test("[mapclick][UI先行] 標高依存表示・計算は await 後に確定（先行させない）", () => {
  const awaitIdx = onViewPick.indexOf("await getElev");
  const before = onViewPick.slice(0, awaitIdx);
  // updateViewLabel（E:標高を含む）・calcCamParams・layout・scene は await 前に出さない
  assert.equal(before.indexOf("updateViewLabel()"), -1, "updateViewLabel を先行させない");
  assert.equal(before.indexOf("calcCamParams()"), -1, "calcCamParams を先行させない");
  assert.equal(before.indexOf("layout()"), -1, "layout を先行させない");
});

test("[mapclick][UI先行] drawViewLines/drawFovLines は標高非依存であること（実コード確認）", () => {
  for (const fn of ["drawViewLines", "drawFovLines"]) {
    const body = funcBody(html, fn);
    assert.ok(body, fn + " 抽出");
    assert.doesNotMatch(body, /viewElev|sElev|tripodH|elevOffset|getElev/, fn + " は標高非依存");
  }
});

test("[mapclick][stale] 世代ガード: await 後に最新でなければ continuation を破棄する", () => {
  // 世代カウンタを取得し、await 後に guard がある
  assert.match(onViewPick, /const\s+_myViewGen\s*=\s*\+\+_viewGen/, "呼び出し世代を捕捉");
  const awaitIdx = onViewPick.indexOf("await getElev");
  const after = onViewPick.slice(awaitIdx);
  assert.match(after, /if\(\s*_myViewGen\s*!==\s*_viewGen\s*\)\s*return/, "await 後に世代ガード");
});

test("[mapclick][stale] global viewElev は世代ガード通過後にのみ書く（stale 標高で上書きしない）", () => {
  const guardIdx = onViewPick.indexOf("_myViewGen !== _viewGen");
  assert.ok(guardIdx > 0, "guard 位置");
  const beforeGuard = onViewPick.slice(0, guardIdx);
  const afterGuard = onViewPick.slice(guardIdx);
  // await 直後〜guard 前に global viewElev への代入が無い（ローカルへ受ける）
  assert.equal(beforeGuard.indexOf("viewElev = await"), -1, "await 結果を直接 global viewElev に入れない");
  // guard 後に viewElev を確定
  assert.match(afterGuard, /viewElev\s*=\s*_elevVal/, "guard 後に global viewElev を確定");
});

/* 世代ガードの論理を最小 harness で検証（A→B 高速クリックの stale 破棄） */
test("[mapclick][stale] 論理検証: A→B で A の遅延 continuation が B を上書きしない", async () => {
  // onViewPick の世代ガードと同じ構造の最小モデル
  let _viewGen = 0;
  let committed = null; // 最終的に反映された視点
  const defers = {};
  function getElev(tag) { return new Promise((res) => { defers[tag] = res; }); }
  async function viewPick(tag) {
    const myGen = ++_viewGen;
    const elev = await getElev(tag);
    if (myGen !== _viewGen) return; // stale 破棄
    committed = { tag, elev };
  }
  const pA = viewPick("A"); // A 開始
  const pB = viewPick("B"); // B 開始（最新）
  // A が遅れて先に解決 → stale なので破棄されるべき
  defers["A"](100);
  await pA;
  assert.equal(committed, null, "A は stale で反映されない");
  // B が解決 → 反映される
  defers["B"](200);
  await pB;
  assert.deepEqual(committed, { tag: "B", elev: 200 }, "最新 B のみ反映");
});

test("[mapclick][単独] 単独クリックは世代一致で従来どおり確定する（論理）", async () => {
  let _viewGen = 0, committed = null;
  let d = null;
  function getElev() { return new Promise((r) => { d = r; }); }
  async function viewPick() {
    const myGen = ++_viewGen;
    const elev = await getElev();
    if (myGen !== _viewGen) return;
    committed = elev;
  }
  const p = viewPick();
  d(50);
  await p;
  assert.equal(committed, 50, "単独クリックは従来どおり確定");
});
