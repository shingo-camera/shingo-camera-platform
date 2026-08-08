/**
 * 管理者判定共通関数
 *
 * 認証済みユーザーが管理者かを判定する。
 * 判定は「検証済み AUTH_USER_ID === env.ADMIN_AUTH_USER_ID」のみを正本とする。
 * メールアドレスでは判定しない。
 *
 * 設計根拠:
 * - SECURITY.md 5「管理者AUTH_USER_IDをサーバー側環境設定で管理」
 *   「管理者メールアドレスのみで判定しない」「管理者APIはすべて requireAdmin を通す」
 * - api/API.md 3「管理者APIは認証済みユーザーが管理者として許可されているか共通処理で確認」
 *
 * 注意:
 * - ADMIN_AUTH_USER_ID 未設定時は管理者として許可しない（内部設定エラー扱い）。
 * - 管理画面・管理API本体は WORK-006 の範囲。ここは判定関数のみ。
 */

import { requireUser, AuthError, type AuthContext } from "./auth";
import type { Env } from "../index";

/**
 * リクエストが管理者によるものかを検証する。
 *
 * 1. requireUser() で JWT 検証（署名・issuer・audience・role・is_anonymous）
 * 2. 検証済み AUTH_USER_ID を env.ADMIN_AUTH_USER_ID と厳密一致で比較
 *
 * 失敗時は AuthError を throw する（呼び出し側で HTTP 化）。
 * - 未認証・トークン不正: requireUser が UNAUTHORIZED(401 相当) を throw
 * - 管理者でない一般ユーザー: FORBIDDEN(403 相当) を throw
 * - ADMIN_AUTH_USER_ID 未設定: FORBIDDEN（内部設定エラーはログのみ、利用者へは 403）
 *
 * @param request 受信リクエスト（Authorization 必須）
 * @param env 環境（ADMIN_AUTH_USER_ID 必須）
 * @returns 検証済み AuthContext（管理者）
 */
export async function requireAdmin(request: Request, env: Env): Promise<AuthContext> {
  // まず通常のユーザー認証（ここで 401 系は throw される）
  const auth = await requireUser(request, env);

  // 管理者IDが未設定なら、誰も管理者として許可しない（安全側）。
  const adminId = env.ADMIN_AUTH_USER_ID;
  if (!adminId) {
    console.error("[admin] ADMIN_AUTH_USER_ID is not configured");
    throw new AuthError("FORBIDDEN", "権限がありません。", 403);
  }

  // 検証済み AUTH_USER_ID と厳密一致（メールでは判定しない）
  if (auth.authUserId !== adminId) {
    throw new AuthError("FORBIDDEN", "権限がありません。", 403);
  }

  return auth;
}
