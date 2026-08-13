/**
 * Entitlement API
 *   GET /api/entitlements/{code}  商品利用可否判定（認証必須）
 *
 * 設計根拠: api/PRODUCT_API.md 3, architecture/AUTH.md 9
 *
 * 処理:
 * 1. requireProduct（JWT検証 / M_USER状態 / M_PRODUCT / T_USER_PRODUCT / 日付範囲）
 * 2. 権限確認アクセスログ（ACCESS_TYPE=1）を抑制付きで記録
 * 3. available=true を返す
 *
 * 権限なしは requireProduct が PRODUCT_NOT_GRANTED(403) を throw。
 * 未購入/停止/期限前/期限切れを区別しない。
 * 商品不在/停止/削除は PRODUCT_NOT_FOUND(404)。
 */

import { jsonOk, jsonError } from "../shared/response";
import { AuthError } from "../shared/auth";
import {
  requireProduct,
  recordEntitlementAccess,
  AccessLogSettingError,
} from "../shared/entitlement";
import type { Env } from "../index";

/**
 * GET /api/entitlements/{code}
 * @param code URL から解析済みの PRODUCT_CODE（呼出側で decode・空チェック済み）
 */
export async function handleEntitlement(request: Request, env: Env, code: string): Promise<Response> {
  let result;
  try {
    result = await requireProduct(request, env, code);
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonError(err.code, err.message, err.status);
    }
    throw err;
  }

  // 権限確認アクセスログを抑制付きで記録。
  // 設定値異常は内部設定エラー。利用者へ詳細を返さず 500（判定自体は成功しているが
  // 記録の一貫性を欠くため内部エラーとして扱い、内部詳細は返さない）。
  try {
    await recordEntitlementAccess(
      request,
      env,
      result.auth.authUserId,
      result.product.PRODUCT_ID,
      result.auth.sessionId,
    );
  } catch (err) {
    if (err instanceof AccessLogSettingError) {
      console.error("[entitlement] access log setting error:", err.message);
      return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
    }
    throw err;
  }

  return jsonOk({
    productCode: result.product.PRODUCT_CODE,
    available: true,
    startAt: result.startAt,
    endAt: result.endAt,
  });
}
