/**
 * 認証共通関数（Supabase JWT 検証）
 *
 * Supabase Auth が発行する JWT を Worker 内でローカル検証する。
 * 非対称署名（RS256 / ES256 等）を前提とし、JWKS で公開鍵を取得して検証する。
 * Legacy の共通 secret（HS256）は前提にしない。
 *
 * 設計根拠:
 * - SECURITY.md 3「API側で署名・有効期限を検証」「検証済み sub を AUTH_USER_ID として利用」
 *   「リクエスト本文の AUTH_USER_ID は信用しない」「完全な JWT をログ出力しない」
 * - api/API.md 3「Authorization: Bearer <SUPABASE_ACCESS_TOKEN>」
 * - api/API.md 12「共通サーバー関数: requireUser()」
 *
 * 方針:
 * - SUPABASE_URL から JWKS URL を生成
 * - createRemoteJWKSet() で JWKS を取得・キャッシュ（リクエスト毎の Supabase 往復を避ける）
 * - jwtVerify() で署名・有効期限・issuer・audience を検証
 * - audience は "authenticated" を必須とし、role/is_anonymous も検証する
 * - 検証済み payload.sub のみを AUTH_USER_ID として使用
 * - 不正・失効・改竄・欠落は AuthError(401) として扱う
 * - JWKS 取得失敗や想定外例外は内部ログのみ、利用者へ詳細を返さない
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "../index";

/** 認証・認可の失敗を表す。呼び出し側で status に応じた応答へ変換する。 */
export class AuthError extends Error {
  readonly code: string;
  /** HTTP ステータス。認証失敗は 401、認可失敗（管理者でない等）は 403。既定 401。 */
  readonly status: number;
  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

/** 検証済みの認証コンテキスト */
export interface AuthContext {
  /** 検証済み JWT の sub。これのみを AUTH_USER_ID として使用する */
  authUserId: string;
  /** JWT に含まれるメール（存在すれば）。同期時の参考にする（正本判定は sub） */
  email: string | null;
  /** 検証済みの生 payload（必要な追加クレーム参照用） */
  payload: JWTPayload;
}

/**
 * SUPABASE_URL から JWKS の URL を生成する。
 * Supabase の JWKS は `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` に公開される。
 */
function buildJwksUrl(supabaseUrl: string): URL {
  const base = supabaseUrl.replace(/\/+$/, "");
  return new URL(`${base}/auth/v1/.well-known/jwks.json`);
}

/**
 * SUPABASE_URL から期待する issuer を生成する。
 * Supabase の access token の iss は `${SUPABASE_URL}/auth/v1`。
 */
function buildIssuer(supabaseUrl: string): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/auth/v1`;
}

/**
 * JWKS セットのキャッシュ。
 * createRemoteJWKSet は内部で鍵をキャッシュし、鍵ローテーションにも追随する。
 * SUPABASE_URL 単位で使い回す（通常は1つ）。
 */
type JwksFn = ReturnType<typeof createRemoteJWKSet>;
const jwksCache = new Map<string, JwksFn>();

function getJwks(supabaseUrl: string): JwksFn {
  const key = supabaseUrl.replace(/\/+$/, "");
  let jwks = jwksCache.get(key);
  if (!jwks) {
    jwks = createRemoteJWKSet(buildJwksUrl(supabaseUrl));
    jwksCache.set(key, jwks);
  }
  return jwks;
}

/**
 * Authorization ヘッダーから Bearer トークンを取り出す。
 * 形式不正・欠落は AuthError(401)。
 */
function extractBearer(request: Request): string {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) {
    throw new AuthError("UNAUTHORIZED", "認証が必要です。");
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) {
    throw new AuthError("UNAUTHORIZED", "認証が必要です。");
  }
  return match[1].trim();
}

/**
 * リクエストの JWT を検証し、認証コンテキストを返す。
 *
 * 検証内容:
 * - 署名（JWKS 公開鍵）
 * - 有効期限 exp / nbf（jose が既定で検証）
 * - issuer（SUPABASE_URL から導出した iss と一致）
 * - audience は "authenticated" を必須として検証する
 * - role は "authenticated"、is_anonymous は true でないことを検証する
 *
 * 失敗時は AuthError を throw する（呼び出し側で 401 化）。
 *
 * @param request 受信リクエスト
 * @param env 環境（SUPABASE_URL 必須）
 * @returns 検証済み AuthContext
 */
export async function requireUser(request: Request, env: Env): Promise<AuthContext> {
  if (!env.SUPABASE_URL) {
    // 設定不備は内部エラー。利用者には汎用の認証エラーに丸める。
    console.error("[auth] SUPABASE_URL is not configured");
    throw new AuthError("UNAUTHORIZED", "認証に失敗しました。");
  }

  const token = extractBearer(request);
  const jwks = getJwks(env.SUPABASE_URL);
  const issuer = buildIssuer(env.SUPABASE_URL);

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, jwks, {
      issuer,
      // Supabase の認証済みアクセストークンは aud = "authenticated"。必須で検証する。
      audience: "authenticated",
    });
    payload = result.payload;
  } catch (err) {
    // 署名不正・失効・改竄・issuer/audience 不一致・JWKS 取得失敗などをここで捕捉。
    // 完全な JWT やスタックの機微情報は出さず、種別のみをログへ。
    console.error("[auth] jwt verification failed:", err instanceof Error ? err.name : "unknown");
    throw new AuthError("UNAUTHORIZED", "認証に失敗しました。");
  }

  // 必須クレーム検証:
  // - role は "authenticated" であること（anon ロールを拒否）
  // - is_anonymous が true でないこと（匿名ユーザーを拒否）
  if (payload["role"] !== "authenticated") {
    console.error("[auth] rejected: role is not authenticated");
    throw new AuthError("UNAUTHORIZED", "認証に失敗しました。");
  }
  if (payload["is_anonymous"] === true) {
    console.error("[auth] rejected: anonymous user");
    throw new AuthError("UNAUTHORIZED", "認証に失敗しました。");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) {
    console.error("[auth] verified token has no sub");
    throw new AuthError("UNAUTHORIZED", "認証に失敗しました。");
  }

  const email =
    typeof payload.email === "string"
      ? payload.email
      : null;

  return { authUserId: sub, email, payload };
}
