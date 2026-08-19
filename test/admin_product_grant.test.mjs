// Admin 商品権限 手動付与の回帰テスト。
//
// 背景（Production スモークで発覚）:
//   Admin ユーザー詳細の新規付与で開始日時 input が placeholder のみ（value 未設定）だったため、
//   payload に startAt が入らず、新規付与 API（startAt 必須）で 400 VALIDATION_ERROR になっていた。
//   終了日時 input は既定値を実値で持っていたため startAt だけが非対称に欠落していた。
//
// 方針（承認済み）:
//   API validation は緩めない。Admin フロントを修正し、開始日時に Platform 共通の
//   JST ISO 8601(+09:00) 現在時刻を既定値として実値で投入する（AdminUI.nowJstIso）。
//   HANABI 限定にせず、select は /api/products 由来で全買い切り商品共通の経路。
//
// site.js/admin.js/detail.html は IIFE・DOM 依存で単体 import できないため、
// frontend_fixes.test.mjs と同様に「実ファイルへ要件を満たす実コードが在ること」を直接検証する。
// あわせて payload 組み立て・付与時必須契約・entitlement 判定の純ロジックを写経検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const detailHtml = readFileSync("public/admin/users/detail.html", "utf8");
const adminJs = readFileSync("public/admin/assets/admin.js", "utf8");

/* ============================================================
 * A. 実ファイル検証: 開始日時 input に JST 既定値を実値で投入
 * ============================================================ */

test("[実ファイル] admin.js に JST(+09:00) 現在時刻ヘルパ nowJstIso がある", () => {
  assert.match(adminJs, /function nowJstIso\(\)/, "nowJstIso 定義");
  // 壁時計方式（UTC へ +9h して getUTC*）・末尾 +09:00・toISOString(Z) を使わない
  assert.match(adminJs, /Date\.now\(\)\s*\+\s*9\s*\*\s*60\s*\*\s*60\s*\*\s*1000/, "UTC へ +9h");
  assert.match(adminJs, /getUTCFullYear\(\)/, "getUTC* で壁時計を取り出す");
  assert.match(adminJs, /\+09:00/, "末尾 +09:00");
  assert.doesNotMatch(adminJs.match(/function nowJstIso[\s\S]*?\n  }/)[0], /toISOString/, "Z形式(toISOString)は使わない");
});

test("[実ファイル] admin.js は nowJstIso を AdminUI で公開する", () => {
  assert.match(adminJs, /nowJstIso:\s*nowJstIso/, "AdminUI.nowJstIso を公開");
});

test("[実ファイル] detail.html は開始日時 input に nowJstIso を value として実値投入する", () => {
  // inStart に value = A.nowJstIso() を設定している（placeholder だけにしない）
  assert.match(detailHtml, /var inStart[\s\S]*?inStart\.value\s*=\s*A\.nowJstIso\(\)/, "inStart.value に nowJstIso");
});

test("[実ファイル] 終了日時 input の既定値は従来どおり維持（+09:00 の実値）", () => {
  assert.match(detailHtml, /var inEnd[\s\S]*?inEnd\.value\s*=\s*"9999-12-31T23:59:59\+09:00"/, "endAt 既定値維持");
});

test("[実ファイル] 付与 payload は status=1 / grantType=3 を従来どおり組み、startAt/endAt/memo を値ありで送る", () => {
  // payload 初期化
  assert.match(detailHtml, /var payload\s*=\s*\{\s*status:\s*1,\s*grantType:\s*3\s*\}/, "status=1/grantType=3");
  // 各値は value がある時に payload へ入れる（inStart は既定値があるので常に入る）
  assert.match(detailHtml, /if\s*\(inStart\.value\.trim\(\)\)\s*payload\.startAt\s*=\s*inStart\.value\.trim\(\)/, "startAt 送信");
  assert.match(detailHtml, /if\s*\(inEnd\.value\.trim\(\)\)\s*payload\.endAt\s*=\s*inEnd\.value\.trim\(\)/, "endAt 送信");
  assert.match(detailHtml, /if\s*\(inMemo\.value\.trim\(\)\)\s*payload\.memo\s*=\s*inMemo\.value\.trim\(\)/, "memo 送信");
});

test("[実ファイル] 既存権限の停止/再開は status のみ（START/END/GRANT_TYPE/MEMO の編集UIを新設しない）", () => {
  // 既存行の操作は status 変更（停止 2 / 再開 1）だけを productOp へ渡す。
  const rowSection = detailHtml.slice(detailHtml.indexOf('section("商品権限")'), detailHtml.indexOf("商品権限の新規付与フォーム"));
  // productOp へ渡す payload は {status:2} と {status:1} のみ（startAt/endAt/grantType/memo を含めない）
  const productOpCalls = rowSection.match(/productOp\(p\.productCode,\s*\{[^}]*\}/g) || [];
  assert.ok(productOpCalls.length >= 2, "停止/再開の2操作がある");
  for (const call of productOpCalls) {
    assert.match(call, /\{\s*status:\s*[12]\s*\}/, "payload は status のみ: " + call);
    assert.doesNotMatch(call, /startAt|endAt|grantType|memo/, "既存行操作に日時/区分/memo を含めない: " + call);
  }
  // 既存行に日時/区分/memo を編集する input 要素を新設していない（表示 p.startDate 等は td 表示のみ）
  assert.doesNotMatch(rowSection, /A\.el\("input"\)/, "既存行に編集 input を新設しない");
});

test("[実ファイル] 付与 select は /api/products 由来で商品非依存（HANABI 限定でない）", () => {
  assert.match(detailHtml, /apiFetch\("\/api\/products"\)/, "商品一覧は /api/products");
  assert.match(detailHtml, /productList\.forEach/, "全商品を option 化");
  // code をそのまま API パスへ渡す（商品コード非依存）
  assert.match(detailHtml, /productOp\(code,\s*payload/, "選択 code をそのまま付与");
});

/* ============================================================
 * B. 純ロジック: payload 組み立て（既定値ありで startAt が必ず入る）
 * ============================================================ */

// detail.html の付与ロジックと同一構造の写経（実ファイル検証と二重化）。
function buildGrantPayload(startVal, endVal, memoVal) {
  const payload = { status: 1, grantType: 3 };
  if (startVal.trim()) payload.startAt = startVal.trim();
  if (endVal.trim()) payload.endAt = endVal.trim();
  if (memoVal.trim()) payload.memo = memoVal.trim();
  return payload;
}
// admin.js の nowJstIso と同一構造の写経。
function nowJstIso(nowMs) {
  const p2 = (n) => String(n).padStart(2, "0");
  const jst = new Date((nowMs ?? Date.now()) + 9 * 60 * 60 * 1000);
  return jst.getUTCFullYear() + "-" + p2(jst.getUTCMonth() + 1) + "-" + p2(jst.getUTCDate()) +
    "T" + p2(jst.getUTCHours()) + ":" + p2(jst.getUTCMinutes()) + ":" + p2(jst.getUTCSeconds()) + "+09:00";
}

test("[payload] 開始日時が既定値（nowJstIso）で入っていれば startAt が payload に含まれる", () => {
  const start = nowJstIso();
  const p = buildGrantPayload(start, "9999-12-31T23:59:59+09:00", "");
  assert.equal(p.startAt, start, "startAt 含む");
  assert.equal(p.endAt, "9999-12-31T23:59:59+09:00", "endAt 含む");
  assert.equal(p.status, 1);
  assert.equal(p.grantType, 3);
  assert.equal("memo" in p, false, "memo 空なら送らない");
});

test("[payload] nowJstIso は JST +09:00 の ISO8601（秒精度）で Date parse 可能", () => {
  const s = nowJstIso(Date.UTC(2026, 7, 5, 9, 0, 0)); // 2026-08-05 09:00Z = 18:00 JST
  assert.equal(s, "2026-08-05T18:00:00+09:00", "UTC→JST 変換が +09:00 壁時計");
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/, "書式");
  assert.equal(Number.isNaN(new Date(s).getTime()), false, "Date parse 可能");
  assert.doesNotMatch(s, /Z$/, "UTC(Z)形式でない");
});

/* ============================================================
 * C. 新規付与の必須契約（API validation を緩めない）写経検証
 *    upsertUserProduct の新規分岐: grantType/startAt/endAt 必須, startAt<=endAt
 * ============================================================ */

function validateNewGrant(input) {
  const missing = {};
  if (input.grantType === null || input.grantType === undefined) missing.grantType = "必須項目です。";
  if (!input.startAt) missing.startAt = "必須項目です。";
  if (!input.endAt) missing.endAt = "必須項目です。";
  if (Object.keys(missing).length > 0) return { ok: false, missing };
  const s = new Date(input.startAt).getTime();
  const e = new Date(input.endAt).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return { ok: false, parse: false };
  if (s > e) return { ok: false, order: false };
  return { ok: true };
}

test("[contract] 修正後 payload は新規付与 validation を通過する（startAt 込み）", () => {
  const p = buildGrantPayload(nowJstIso(Date.UTC(2026, 7, 5, 9, 0, 0)), "9999-12-31T23:59:59+09:00", "");
  const r = validateNewGrant(p);
  assert.equal(r.ok, true, "validation 通過");
});

test("[contract] startAt 欠落は従来どおり 400 相当（validation は緩めない）", () => {
  const r = validateNewGrant({ status: 1, grantType: 3, endAt: "9999-12-31T23:59:59+09:00" });
  assert.equal(r.ok, false);
  assert.equal(r.missing.startAt, "必須項目です。", "startAt 必須を維持");
});

test("[contract] grantType/endAt も新規付与では必須のまま", () => {
  assert.equal(validateNewGrant({ status: 1, startAt: "2026-08-05T18:00:00+09:00", endAt: "9999-12-31T23:59:59+09:00" }).missing.grantType, "必須項目です。");
  assert.equal(validateNewGrant({ status: 1, grantType: 3, startAt: "2026-08-05T18:00:00+09:00" }).missing.endAt, "必須項目です。");
});

test("[contract] startAt > endAt は拒否（順序検証を維持）", () => {
  const r = validateNewGrant({ status: 1, grantType: 3, startAt: "2027-01-01T00:00:00+09:00", endAt: "2026-01-01T00:00:00+09:00" });
  assert.equal(r.ok, false);
  assert.equal(r.order, false);
});

/* ============================================================
 * D. entitlement 判定（付与直後有効 / 停止で無効 / 再開で有効）写経検証
 *    isEntitlementActive: STATUS===1 && DEL_FLG===0 && START<=now<=END
 * ============================================================ */

function isEntitlementActive(up, nowMs) {
  if (up.STATUS !== 1) return false;
  if (up.DEL_FLG !== 0) return false;
  const start = new Date(up.START_DATE).getTime();
  const end = new Date(up.END_DATE).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return start <= nowMs && nowMs <= end;
}

const NOW = Date.UTC(2026, 7, 19, 9, 0, 0); // 2026-08-19 18:00 JST 相当

test("[entitlement] 付与直後（status=1, del=0, start<=now<=end）は有効", () => {
  const up = { STATUS: 1, DEL_FLG: 0, START_DATE: "2026-08-05T18:00:00+09:00", END_DATE: "9999-12-31T23:59:59+09:00" };
  assert.equal(isEntitlementActive(up, NOW), true);
});

test("[entitlement] 停止（status=2）で無効", () => {
  const up = { STATUS: 2, DEL_FLG: 0, START_DATE: "2026-08-05T18:00:00+09:00", END_DATE: "9999-12-31T23:59:59+09:00" };
  assert.equal(isEntitlementActive(up, NOW), false);
});

test("[entitlement] 再開（status=1 に戻す）で再び有効", () => {
  const up = { STATUS: 1, DEL_FLG: 0, START_DATE: "2026-08-05T18:00:00+09:00", END_DATE: "9999-12-31T23:59:59+09:00" };
  assert.equal(isEntitlementActive(up, NOW), true);
});

test("[entitlement] START が現在より未来なら無効（開始前）", () => {
  const up = { STATUS: 1, DEL_FLG: 0, START_DATE: "2099-01-01T00:00:00+09:00", END_DATE: "9999-12-31T23:59:59+09:00" };
  assert.equal(isEntitlementActive(up, NOW), false);
});

test("[entitlement] 開始日時が現在時刻既定なら付与直後から有効（start<=now）", () => {
  // 既定 startAt = nowJstIso() は now とほぼ同時刻。境界で now を含む（<=）ため有効。
  const startIso = nowJstIso(NOW);
  const up = { STATUS: 1, DEL_FLG: 0, START_DATE: startIso, END_DATE: "9999-12-31T23:59:59+09:00" };
  assert.equal(isEntitlementActive(up, new Date(startIso).getTime()), true, "start==now で有効");
});

/* ============================================================
 * E. 3 商品共通（付与経路は商品コード非依存）
 * ============================================================ */

test("[3商品] 付与経路は商品コードに依存せず SUN_AND_MOON/HANABI/HANABI_GOOGLE_EARTH で同一に成立", () => {
  for (const code of ["SUN_AND_MOON", "HANABI", "HANABI_GOOGLE_EARTH"]) {
    // 同一 payload 生成・同一 validation を通る（コードは API パスにのみ使用）
    const p = buildGrantPayload(nowJstIso(NOW), "9999-12-31T23:59:59+09:00", "");
    assert.equal(validateNewGrant(p).ok, true, code + " で付与 payload が有効");
  }
});
