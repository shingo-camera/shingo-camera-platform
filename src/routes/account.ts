/**
 * Account 系 API
 *   POST /api/account/sync             M_USER 同期
 *   GET  /api/account/me               ログイン中ユーザーの業務情報
 *   GET  /api/account/products         ログイン後ホーム用 全商品一覧
 *   POST /api/account/password-changed パスワード変更日時更新
 *
 * 設計根拠: api/AUTH_API.md 2/3/4/5, api/PRODUCT_API.md
 *
 * 同期ロジックは shared/account.ts の syncMUser に集約し、
 * sync と me で別々の INSERT/UPDATE を持たない。
 */

import { requireUser, AuthError } from "../shared/auth";
import { getDb } from "../shared/db";
import { nowIso } from "../shared/datetime";
import { jsonOk, jsonError } from "../shared/response";
import { syncMUser, getMUser } from "../shared/account";
import { listProductEntitlements, listMeProducts } from "../shared/entitlement";
import type { Env } from "../index";

/** M_USER 停止・退会 → USER_SUSPENDED(403) を投げる共通チェック */
function assertUserActive(status: number): void {
  if (status === 2 || status === 9) {
    throw new AuthError("USER_SUSPENDED", "このアカウントは現在利用できません。", 403);
  }
}

/** AuthError を共通レスポンスへ変換して返す */
function authErrorResponse(err: unknown): Response | null {
  if (err instanceof AuthError) {
    return jsonError(err.code, err.message, err.status);
  }
  return null;
}

/**
 * POST /api/account/sync
 */
export async function handleAccountSync(request: Request, env: Env): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const user = await syncMUser(env, auth);
  if (!user) {
    return jsonError("UNAUTHORIZED", "認証に失敗しました。", 401);
  }
  return jsonOk({ synced: true });
}

/**
 * GET /api/account/me
 */
export async function handleAccountMe(request: Request, env: Env): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  // M_USER 取得。無ければ同期作成（検証済み JWT のみ使用）。
  let user = await getMUser(env, auth.authUserId);
  if (!user) {
    user = await syncMUser(env, auth);
    if (!user) {
      return jsonError("UNAUTHORIZED", "認証に失敗しました。", 401);
    }
  }

  // 停止・退会は 403
  try {
    assertUserActive(user.STATUS);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const products = await listMeProducts(env, auth.authUserId);

  return jsonOk({
    email: user.LOGIN_MAIL,
    status: user.STATUS,
    mailAuthenticatedAt: user.MAIL_AUTH_DATE,
    passwordChangedAt: user.PASSWORD_CHANGE_DATE,
    lastLoginAt: user.LAST_LOGIN_DATE,
    products,
  });
}

/**
 * GET /api/account/products
 * 全有効商品を granted/available 付きで返す（未購入も含む）。
 */
export async function handleAccountProducts(request: Request, env: Env): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  // 停止・退会でも商品一覧自体は返す設計（me で状態は判定）。
  // ここでは全商品の granted/available を返す。
  const products = await listProductEntitlements(env, auth.authUserId);
  return jsonOk({ products });
}

/**
 * POST /api/account/password-changed
 * Supabase Auth でのパスワード変更成功後に呼ばれ、日時のみ更新する。
 * このAPI単体でパスワード変更成功とはみなさない（呼出前提）。
 */
export async function handleAccountPasswordChanged(request: Request, env: Env): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const db = getDb(env);
  const now = nowIso();
  // M_USER が存在しなければ、まだ同期されていない異常系。
  // 正本整合: 業務日時更新対象が無いため 404 相当を返す（内部詳細は返さない）。
  const user = await getMUser(env, auth.authUserId);
  if (!user) {
    return jsonError("USER_NOT_FOUND", "アカウントが見つかりません。", 404);
  }

  await db
    .prepare("UPDATE M_USER SET PASSWORD_CHANGE_DATE = ?, UPDATE_DATE = ? WHERE AUTH_USER_ID = ?")
    .bind(now, now, auth.authUserId)
    .run();

  return jsonOk({ updated: true });
}
