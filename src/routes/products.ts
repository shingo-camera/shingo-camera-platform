/**
 * Products 系 API（認証任意）
 *   GET /api/products         有効商品一覧（code/name/sortNo のみ）
 *   GET /api/products/{code}  商品詳細（不在/停止/削除は PRODUCT_NOT_FOUND）
 *
 * 設計根拠: api/PRODUCT_API.md 1/2
 *
 * 注意:
 * - 公開APIのため、ユーザー権限情報・価格・Stripe情報・内部 PRODUCT_ID を返さない。
 */

import { getDb } from "../shared/db";
import { jsonOk, jsonError } from "../shared/response";
import { getActiveProductByCode } from "../shared/entitlement";
import type { Env } from "../index";

/**
 * GET /api/products
 * 有効商品（STATUS=1, DEL_FLG=0）の code/name/sortNo を SORT_NO 昇順で返す。
 */
export async function handleProductList(_request: Request, env: Env): Promise<Response> {
  const db = getDb(env);
  const rows = await db
    .prepare(
      `SELECT PRODUCT_CODE AS code, PRODUCT_NAME AS name, SORT_NO AS sortNo
       FROM M_PRODUCT WHERE STATUS = 1 AND DEL_FLG = 0
       ORDER BY SORT_NO ASC`,
    )
    .all<{ code: string; name: string; sortNo: number }>();
  return jsonOk({ products: rows.results ?? [] });
}

/**
 * GET /api/products/{code}
 * PRODUCT_CODE で有効商品を取得。無ければ PRODUCT_NOT_FOUND(404)。
 * 内部 PRODUCT_ID は返さない。
 *
 * @param code URL から解析済みの PRODUCT_CODE（呼出側で decode・空チェック済み）
 */
export async function handleProductDetail(_request: Request, env: Env, code: string): Promise<Response> {
  const product = await getActiveProductByCode(env, code);
  if (!product) {
    return jsonError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
  }
  return jsonOk({
    code: product.PRODUCT_CODE,
    name: product.PRODUCT_NAME,
    sortNo: product.SORT_NO,
  });
}
