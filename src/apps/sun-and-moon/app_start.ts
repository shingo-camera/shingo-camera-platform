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
    await recordAppStartAccess(request, env, result.auth.authUserId, result.product.PRODUCT_ID);
  } catch (e) {
    if (!(e instanceof AccessLogSettingError)) {
      throw e;
    }
    // 設定エラーは記録をスキップするのみ（利用者へ内部詳細を返さない）。
  }

  return jsonOk({ started: true });
}
