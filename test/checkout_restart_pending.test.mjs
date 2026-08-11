// 購入再開始「戻る」選択時の pending 整合のテスト（フロント localStorage ロジック）
// site.js は IIFE のため関数を直接 import できない。site.js と同一の pending 契約
// （getPending/setPending/clearPending と、送信前退避→「戻る」で復元）を localStorage 上で
// 再現し、「存在しない新 operationId を pending に残さない」ことを検証する。
import { test } from "node:test";
import assert from "node:assert/strict";

// --- localStorage の最小モック ---
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

// --- site.js と同一の pending 契約（挙動を写経。実装が変わればこのテストも追随させる）---
const PENDING_KEY = "shingo_pending_checkout";
function getPending(ls) {
  try { const v = ls.getItem(PENDING_KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function setPending(ls, operationId, codes) {
  try { ls.setItem(PENDING_KEY, JSON.stringify({ operationId, codes })); } catch (e) {}
}
function clearPending(ls) {
  try { ls.removeItem(PENDING_KEY); } catch (e) {}
}
// startMultiCheckout の該当部分（送信前退避→RESTART_CONFIRM で proceed により分岐）
function simulateCheckout(ls, opId, codes, proceed) {
  const prevPending = getPending(ls);
  setPending(ls, opId, codes); // API 送信前に保存（通信失敗回収のため維持）
  // ... サーバーが CHECKOUT_RESTART_CONFIRM を返した想定 ...
  if (proceed) {
    // 「新しく購入する」→ restart 続行（pending は新 opId のまま。restart で attempt が作られる）
    return;
  }
  // 「戻る」→ 旧購入手続きは何も変更しない。存在しない新 opId を残さない。
  if (prevPending && prevPending.operationId) {
    setPending(ls, prevPending.operationId, prevPending.codes);
  } else {
    clearPending(ls);
  }
}

test("戻る: 送信前 pending が無ければ、新 operationId を残さず pending は空になる", () => {
  const ls = makeLocalStorage();
  // このタブに旧 pending 無し（旧 A は別タブ/DB 管理）
  simulateCheckout(ls, "op-B-new", ["HANABI"], false);
  assert.equal(getPending(ls), null, "存在しない op-B を pending に残さない");
});

test("戻る: 送信前 pending（旧A）があれば、旧A へ復元される", () => {
  const ls = makeLocalStorage();
  setPending(ls, "op-A-old", ["SUN_AND_MOON"]); // 旧 A がこのタブの pending
  simulateCheckout(ls, "op-B-new", ["SUN_AND_MOON", "HANABI"], false);
  const p = getPending(ls);
  assert.ok(p);
  assert.equal(p.operationId, "op-A-old", "旧 A を指した状態を維持");
  assert.deepEqual(p.codes, ["SUN_AND_MOON"]);
});

test("新しく購入する: pending は新 operationId のまま（restart で attempt 作成へ）", () => {
  const ls = makeLocalStorage();
  setPending(ls, "op-A-old", ["SUN_AND_MOON"]);
  simulateCheckout(ls, "op-B-new", ["SUN_AND_MOON", "HANABI"], true);
  const p = getPending(ls);
  assert.ok(p);
  assert.equal(p.operationId, "op-B-new", "restart 続行時は新 opId を保持");
});
