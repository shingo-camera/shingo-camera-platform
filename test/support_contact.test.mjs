// SUPPORT 問い合わせ検証（純関数）のテスト。
// 検証対象は src/shared/support_validate.ts（esbuild で _bundle へ出力）。
// email はフォームから受け取らない設計（認証から確定）のため、ここでは扱わない。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSupportInput,
  buildAdminMailText,
  buildAdminMailSubject,
  buildAckMailText,
  buildAckMailSubject,
  SUPPORT_CATEGORIES,
  SUPPORT_LIMITS,
} from "./_bundle/support_validate.mjs";

const base = () => ({
  category: "purchase",
  product: "SUN AND MOON PLANNER",
  subject: "利用権が反映されない",
  body: "決済完了後にMY PAGEへ反映されません。",
  website: "",
});

test("[support] 正常系: 妥当な入力は ok=true で正規化される", () => {
  const r = validateSupportInput(base());
  assert.equal(r.ok, true);
  assert.equal(r.value.category, "purchase");
  assert.equal(r.value.categoryLabel, "購入・利用権");
  // email はフォーム value に含まれない
  assert.equal("email" in r.value, false);
});

test("[support] category は allowlist のみ許可", () => {
  assert.equal(validateSupportInput({ ...base(), category: "" }).code, "CATEGORY_REQUIRED");
  assert.equal(validateSupportInput({ ...base(), category: undefined }).code, "CATEGORY_REQUIRED");
  assert.equal(validateSupportInput({ ...base(), category: "hack" }).code, "CATEGORY_INVALID");
  for (const c of SUPPORT_CATEGORIES) {
    assert.equal(validateSupportInput({ ...base(), category: c }).ok, true, c);
  }
});

test("[support] body 必須・最大長", () => {
  assert.equal(validateSupportInput({ ...base(), body: "" }).code, "BODY_REQUIRED");
  assert.equal(validateSupportInput({ ...base(), body: "   " }).code, "BODY_REQUIRED");
  assert.equal(validateSupportInput({ ...base(), body: undefined }).code, "BODY_REQUIRED");
  const long = "あ".repeat(SUPPORT_LIMITS.bodyMax + 1);
  assert.equal(validateSupportInput({ ...base(), body: long }).code, "BODY_TOO_LONG");
});

test("[support] subject / product はヘッダインジェクション（改行）を拒否", () => {
  assert.equal(validateSupportInput({ ...base(), subject: "件名\r\nBcc: x@y.com" }).code, "SUBJECT_INVALID");
  assert.equal(validateSupportInput({ ...base(), product: "商品\nX-Header: 1" }).code, "PRODUCT_INVALID");
});

test("[support] honeypot に値があれば SPAM_DETECTED", () => {
  const r = validateSupportInput({ ...base(), website: "http://bot.example" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "SPAM_DETECTED");
});

test("[support] 任意項目は未指定でも通る", () => {
  const r = validateSupportInput({ category: "other", body: "本文", website: "" });
  assert.equal(r.ok, true);
  assert.equal(r.value.product, "");
  assert.equal(r.value.subject, "");
});

test("[support] 管理者通知メール: 問い合わせ者メール・AUTH_USER_ID を含む", () => {
  const r = validateSupportInput(base());
  assert.equal(r.ok, true);
  const text = buildAdminMailText(r.value, { email: "user@example.com", authUserId: "auth-123" });
  assert.match(text, /問い合わせ者メール: user@example\.com/);
  assert.match(text, /AUTH_USER_ID: auth-123/);
  assert.match(text, /種別: 購入・利用権/);
  assert.match(text, /決済完了後にMY PAGEへ反映されません。/);
  assert.equal(buildAdminMailSubject(r.value), "【SUPPORT】購入・利用権");
});

test("[support] 受付完了メール: 内部識別子を含まず・返信期限を約束しない", () => {
  const r = validateSupportInput(base());
  assert.equal(r.ok, true);
  const text = buildAckMailText(r.value);
  assert.match(text, /shingo_camera LABO へのお問い合わせを受け付けました。/);
  assert.match(text, /種別: 購入・利用権/);
  assert.match(text, /決済完了後にMY PAGEへ反映されません。/);
  // 内部識別子・利用者メールは受付メールに出さない
  assert.doesNotMatch(text, /AUTH_USER_ID/);
  assert.doesNotMatch(text, /auth-123/);
  // 返信期限・営業日を約束しない
  assert.doesNotMatch(text, /営業日/);
  assert.doesNotMatch(text, /以内に(返信|回答)/);
  // 機密情報注意は含む
  assert.match(text, /パスワード/);
  assert.match(buildAckMailSubject(r.value), /shingo_camera LABO/);
});
