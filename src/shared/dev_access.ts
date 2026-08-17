/**
 * DEV 環境の Cloudflare Access 認証境界（P1-1）。
 *
 * 方針:
 *   - /dev/* は Cloudflare Access（メール allowlist）で前段保護する（Dashboard 設定・人間手順）。
 *   - Worker 側でも二段目として Access JWT（Cf-Access-Jwt-Assertion）を本検証する:
 *       署名（JWKS）／issuer=TEAM_DOMAIN／audience=AUD。payload.email を取得できた場合のみ許可。
 *   - env（DEV_ACCESS_TEAM_DOMAIN / DEV_ACCESS_AUD）不足時は fail-closed（許可しない）。
 *   - 例外: /dev/api/stripe/webhook（POST）は machine-to-machine のため Access 対象外とし、
 *       Stripe 署名検証（既存 handleStripeWebhook）を認証境界とする。Webhook 以外は広く bypass しない。
 *
 * 依存: jose（既存 auth.ts と同方式）。JWKS resolver は注入可能（テストでローカル鍵を使うため）。
 */
import { jwtVerify } from "jose";

/**
 * Access 対象外にする exact path（Stripe webhook のみ）。
 * inner は DEV_BASE_PATH 除去後の内部パス（"/api/stripe/webhook"）。
 */
export function isDevWebhookExempt(method: string, innerPath: string): boolean {
  return method === "POST" && innerPath === "/api/stripe/webhook";
}

/**
 * TEAM_DOMAIN から Access issuer URL を生成する。
 * - 既に https:// 付きならそのまま（末尾スラッシュ除去）。
 * - "myteam" のような短縮名なら https://myteam.cloudflareaccess.com。
 */
export function devAccessIssuer(teamDomain: string): string {
  const t = teamDomain.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}.cloudflareaccess.com`;
}

/**
 * Access JWT を検証し、検証済み email を返す（失敗時 null）。
 * keys は jose の JWKS resolver（createRemoteJWKSet の戻り）または鍵。テストで注入する。
 */
export async function verifyDevAccessEmail(
  token: string | null | undefined,
  opts: { issuer: string; audience: string; keys: Parameters<typeof jwtVerify>[1] },
): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, opts.keys, {
      issuer: opts.issuer,
      audience: opts.audience,
    });
    const email = typeof payload.email === "string" ? payload.email : null;
    return email && email.length > 0 ? email : null;
  } catch {
    return null; // 署名不正・issuer/aud 不一致・期限切れ等はすべて拒否
  }
}

/**
 * リクエストから DEV Access の email を解決する（env 不足は fail-closed）。
 * keysFactory は issuer から JWKS resolver を作る関数（本番は createRemoteJWKSet、テストはローカル鍵）。
 */
export async function resolveDevAccessEmail(
  request: Request,
  env: { DEV_ACCESS_TEAM_DOMAIN?: string; DEV_ACCESS_AUD?: string },
  keysFactory: (issuer: string) => Parameters<typeof jwtVerify>[1],
): Promise<string | null> {
  const team = env.DEV_ACCESS_TEAM_DOMAIN;
  const aud = env.DEV_ACCESS_AUD;
  if (!team || !aud) return null; // fail-closed: env 不足
  const issuer = devAccessIssuer(team);
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  return verifyDevAccessEmail(token, { issuer, audience: aud, keys: keysFactory(issuer) });
}
