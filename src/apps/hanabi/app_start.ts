/**
 * HANABI アプリ起動記録（WORK-010 SUN AND MOON の app_start を HANABI へ写像）
 *
 * パス: POST /api/apps/hanabi/app-start
 *
 * アプリ画面（/apps/hanabi/）の起動時に1回だけ呼ぶ。
 * - requireProduct(HANABI) で権限確認（未ログイン/未購入/停止を拒否）。
 * - recordAppStartAccess で ACCESS_TYPE=0 (APP_START) を抑制付きで記録。
 *
 * SUN AND MOON と同一方式。新しい認証・権限・ログ方式は追加しない。
 * HANABI の中核計算は個別の計算エンドポイント（scene-solve / terrain-solve、
 * いずれも requireProduct(HANABI) 保護）へ分離しており、SAM のような汎用の
 * 計算 API ルーター（/api/apps/{app}/{name} 形式の router.ts）は用意していない。
 */

import type { Env } from "../../index";
import { requireProduct, recordAppStartAccess, AccessLogSettingError } from "../../shared/entitlement";
import { AuthError } from "../../shared/auth";
import { AppError } from "../../shared/errors";
import { jsonOk, jsonError } from "../../shared/response";

const HANABI = "HANABI";

export async function handleHanabiAppStart(request: Request, env: Env): Promise<Response> {
  let result;
  try {
    result = await requireProduct(request, env, HANABI);
  } catch (e) {
    if (e instanceof AuthError) {
      return jsonError(e.code, e.message, e.status);
    }
    if (e instanceof AppError) {
      return jsonError(e.code, e.message, e.status);
    }
    throw e;
  }

  // APP_START アクセスログ（抑制付き）。設定値異常は握って処理継続（利用は妨げない）。
  try {
    await recordAppStartAccess(
      request,
      env,
      result.auth.authUserId,
      result.product.PRODUCT_ID,
      result.auth.sessionId,
    );
  } catch (e) {
    if (!(e instanceof AccessLogSettingError)) {
      throw e;
    }
    // 設定エラーは記録をスキップするのみ（利用者へ内部詳細を返さない）。
  }

  // 管理者判定（フロントの表示制御用）。判定正本は既存 requireAdmin（src/shared/admin.ts）と
  // 同一：「検証済み AUTH_USER_ID === env.ADMIN_AUTH_USER_ID（未設定時は非管理者）」。
  // 既存レスポンスへの後方互換なフィールド追加のみ。
  const isAdmin =
    !!env.ADMIN_AUTH_USER_ID && result.auth.authUserId === env.ADMIN_AUTH_USER_ID;

  return jsonOk({ started: true, isAdmin });
}
