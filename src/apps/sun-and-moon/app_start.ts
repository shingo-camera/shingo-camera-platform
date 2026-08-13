/**
 * WORK-010 SUN AND MOON アプリ起動記録
 *
 * パス: POST /api/apps/sun-and-moon/app-start
 *
 * アプリ画面（/apps/sun-and-moon/）の起動時に1回だけ呼ぶ。
 * - requireProduct(SUN_AND_MOON) で権限確認（未ログイン/未購入/停止を拒否）。
 * - recordAppStartAccess で ACCESS_TYPE=0 (APP_START) を抑制付きで記録。
 *   → 各計算APIではログを記録しないため、利用開始の記録はここに集約される。
 *
 * 計算APIではないので /api/apps/sun-and-moon/{name} のルーターとは分離する。
 */

import type { Env } from "../../index";
import { requireProduct, recordAppStartAccess, AccessLogSettingError } from "../../shared/entitlement";
import { AuthError } from "../../shared/auth";
import { AppError } from "../../shared/errors";
import { jsonOk, jsonError } from "../../shared/response";

const SUN_AND_MOON = "SUN_AND_MOON";

export async function handleSunAndMoonAppStart(request: Request, env: Env): Promise<Response> {
  let result;
  try {
    result = await requireProduct(request, env, SUN_AND_MOON);
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
  // 新しい判定方式は作らず、既存レスポンスへの後方互換なフィールド追加のみ
  // （既存クライアントは isAdmin を無視してそのまま動作する）。
  const isAdmin =
    !!env.ADMIN_AUTH_USER_ID && result.auth.authUserId === env.ADMIN_AUTH_USER_ID;

  return jsonOk({ started: true, isAdmin });
}
