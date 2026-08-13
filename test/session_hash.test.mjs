/**
 * SESSION_ID_HASH 生成の検証（session_hash.ts）
 *
 * 検証:
 * 1. session_id + secret から安定したハッシュを生成できる
 * 2. 同じ session_id → 同じハッシュ（決定的）
 * 3. 別の session_id → 異なるハッシュ
 * 4. 生 session_id をハッシュに含めない（ハッシュ文字列に session_id が現れない）
 * - secret が別なら別ハッシュ（サーバー鍵依存）
 * - session_id 欠損 or secret 欠損なら null（安全側）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSessionIdHash } from "./_bundle/purchase_logic.mjs";

const SID_A = "11111111-1111-4111-8111-111111111111";
const SID_B = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-secret-key-please-change";
const SECRET2 = "another-secret-key";

test("[session_hash] 要件1: session_id+secret から v1: 形式のハッシュを生成", async () => {
  const h = await computeSessionIdHash(SID_A, SECRET);
  assert.equal(typeof h, "string");
  assert.match(h, /^v1:[0-9a-f]{64}$/); // HMAC-SHA256 → 64 hex
});

test("[session_hash] 要件2: 同じ session_id → 同じハッシュ（決定的）", async () => {
  const h1 = await computeSessionIdHash(SID_A, SECRET);
  const h2 = await computeSessionIdHash(SID_A, SECRET);
  assert.equal(h1, h2);
});

test("[session_hash] 要件3: 別の session_id → 異なるハッシュ", async () => {
  const hA = await computeSessionIdHash(SID_A, SECRET);
  const hB = await computeSessionIdHash(SID_B, SECRET);
  assert.notEqual(hA, hB);
});

test("[session_hash] 要件4: 生 session_id をハッシュへ含めない", async () => {
  const h = await computeSessionIdHash(SID_A, SECRET);
  assert.equal(h.includes(SID_A), false, "ハッシュ文字列に生 session_id が現れてはならない");
});

test("[session_hash] secret が別なら別ハッシュ（サーバー鍵に依存）", async () => {
  const h1 = await computeSessionIdHash(SID_A, SECRET);
  const h2 = await computeSessionIdHash(SID_A, SECRET2);
  assert.notEqual(h1, h2);
});

test("[session_hash] session_id 欠損なら null（安全側）", async () => {
  assert.equal(await computeSessionIdHash(null, SECRET), null);
  assert.equal(await computeSessionIdHash(undefined, SECRET), null);
  assert.equal(await computeSessionIdHash("", SECRET), null);
});

test("[session_hash] secret 欠損なら null（鍵が無ければハッシュしない）", async () => {
  assert.equal(await computeSessionIdHash(SID_A, null), null);
  assert.equal(await computeSessionIdHash(SID_A, undefined), null);
  assert.equal(await computeSessionIdHash(SID_A, ""), null);
});
