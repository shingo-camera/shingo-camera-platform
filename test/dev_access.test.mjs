/**
 * DEV Cloudflare Access 認証境界（P0-1 webhook exempt / P1-1 JWT 本検証）。
 * A 通常/dev：JWT無→拒否  B JWT不正→拒否  C 正 issuer/aud→email取得
 * D webhook：JWT無でも exempt  E Stripe署名境界（webhook は Access 対象外を固定）
 * F 通常/dev/api/config：JWT無で通らない  G env不足→fail-closed
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { isDevWebhookExempt, devAccessIssuer, verifyDevAccessEmail, resolveDevAccessEmail } from "./_bundle/dev_access.mjs";

const ISSUER = "https://myteam.cloudflareaccess.com";
const AUD = "aud-test-123";

// ローカル鍵で Access JWT を模擬（本番は Cloudflare の JWKS）
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = await exportJWK(publicKey);
jwk.kid = "k1"; jwk.alg = "ES256";
const KEYS = createLocalJWKSet({ keys: [jwk] });
const otherPair = await generateKeyPair("ES256"); // 署名鍵違い（不正署名用）

async function sign(claims, { issuer = ISSUER, aud = AUD, key = privateKey } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuedAt().setIssuer(issuer).setAudience(aud).setExpirationTime("5m")
    .sign(key);
}

test("[webhook exempt] POST /api/stripe/webhook のみ Access 対象外", () => {
  assert.equal(isDevWebhookExempt("POST", "/api/stripe/webhook"), true);
  assert.equal(isDevWebhookExempt("GET", "/api/stripe/webhook"), false, "GET は除外しない");
  assert.equal(isDevWebhookExempt("POST", "/api/config"), false, "他 API は除外しない");
  assert.equal(isDevWebhookExempt("POST", "/api/stripe/webhook/x"), false, "前方一致では除外しない");
});

test("[issuer] TEAM_DOMAIN 短縮名/URL の解決", () => {
  assert.equal(devAccessIssuer("myteam"), "https://myteam.cloudflareaccess.com");
  assert.equal(devAccessIssuer("https://myteam.cloudflareaccess.com/"), "https://myteam.cloudflareaccess.com");
});

test("[C] 正しい issuer/aud/email の JWT → email 取得", async () => {
  const t = await sign({ email: "me@example.com" });
  assert.equal(await verifyDevAccessEmail(t, { issuer: ISSUER, audience: AUD, keys: KEYS }), "me@example.com");
});

test("[A/F] JWT 無し → null（拒否）", async () => {
  assert.equal(await verifyDevAccessEmail(null, { issuer: ISSUER, audience: AUD, keys: KEYS }), null);
  assert.equal(await verifyDevAccessEmail("", { issuer: ISSUER, audience: AUD, keys: KEYS }), null);
});

test("[B] 不正 JWT → null（署名違い/aud違い/issuer違い/email無/改ざん）", async () => {
  const badSig = await sign({ email: "me@example.com" }, { key: otherPair.privateKey });
  assert.equal(await verifyDevAccessEmail(badSig, { issuer: ISSUER, audience: AUD, keys: KEYS }), null, "署名違い");
  const badAud = await sign({ email: "me@example.com" }, { aud: "other-aud" });
  assert.equal(await verifyDevAccessEmail(badAud, { issuer: ISSUER, audience: AUD, keys: KEYS }), null, "aud違い");
  const badIss = await sign({ email: "me@example.com" }, { issuer: "https://evil.cloudflareaccess.com" });
  assert.equal(await verifyDevAccessEmail(badIss, { issuer: ISSUER, audience: AUD, keys: KEYS }), null, "issuer違い");
  const noEmail = await sign({ sub: "x" });
  assert.equal(await verifyDevAccessEmail(noEmail, { issuer: ISSUER, audience: AUD, keys: KEYS }), null, "email無");
  const t = await sign({ email: "me@example.com" });
  assert.equal(await verifyDevAccessEmail(t + "x", { issuer: ISSUER, audience: AUD, keys: KEYS }), null, "改ざん");
});

test("[G] env(DEV_ACCESS_*) 不足 → fail-closed（null）", async () => {
  const req = new Request("https://shingo-camera.com/dev/api/config", {
    headers: { "Cf-Access-Jwt-Assertion": await sign({ email: "me@example.com" }) },
  });
  assert.equal(await resolveDevAccessEmail(req, {}, () => KEYS), null, "team/aud 未設定は拒否");
  assert.equal(await resolveDevAccessEmail(req, { DEV_ACCESS_TEAM_DOMAIN: "myteam" }, () => KEYS), null, "aud 未設定は拒否");
});

test("[C/F] resolveDevAccessEmail：env揃い＋正JWTヘッダ→email／ヘッダ無→null", async () => {
  const env = { DEV_ACCESS_TEAM_DOMAIN: "myteam", DEV_ACCESS_AUD: AUD };
  const ok = new Request("https://shingo-camera.com/dev/api/config", {
    headers: { "Cf-Access-Jwt-Assertion": await sign({ email: "me@example.com" }) },
  });
  assert.equal(await resolveDevAccessEmail(ok, env, () => KEYS), "me@example.com");
  const noHdr = new Request("https://shingo-camera.com/dev/api/config");
  assert.equal(await resolveDevAccessEmail(noHdr, env, () => KEYS), null, "ヘッダ無は拒否");
});
