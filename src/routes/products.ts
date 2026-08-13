/**
 * Products 系 API（認証任意）
 *   GET /api/products         有効商品一覧（code/name/sortNo に加え販売情報 purchaseEnabled/saleType/displayPrice/billingInterval を返す）
 *   GET /api/products/{code}  商品詳細（不在/停止/削除は PRODUCT_NOT_FOUND）
 *
 * 設計根拠: api/PRODUCT_API.md 1/2
 *
 * 注意:
 * - 公開APIのため、STRIPE_PRICE_ID・Stripe Secret・内部 PRODUCT_ID・ユーザー権限情報は返さない。
 * - DISPLAY_PRICE は表示専用の公開情報（実課金額の正本は Stripe Price）。
 */

import { getDb } from "../shared/db";
import { jsonOk, jsonError } from "../shared/response";
import { getActiveProductByCode } from "../shared/entitlement";
import { getAllProductDependencyGroups } from "../shared/purchase";
import type { Env } from "../index";

/**
 * GET /api/products
 * 有効商品（STATUS=1, DEL_FLG=0）を SORT_NO 昇順で返す。
 * STORE が販売状態（購入可否・販売方式・表示価格）を DB 正本から取得するための公開情報を含む。
 * 内部 PRODUCT_ID・Stripe Price ID・Secret は返さない。DISPLAY_PRICE は表示専用の公開情報。
 */
export async function handleProductList(_request: Request, env: Env): Promise<Response> {
  const db = getDb(env);
  const rows = await db
    .prepare(
      `SELECT PRODUCT_CODE AS code, PRODUCT_NAME AS name, SORT_NO AS sortNo,
              PURCHASE_ENABLED AS purchaseEnabled, SALE_TYPE AS saleType,
              DISPLAY_PRICE AS displayPrice, BILLING_INTERVAL AS billingInterval
       FROM M_PRODUCT WHERE STATUS = 1 AND DEL_FLG = 0
       ORDER BY SORT_NO ASC`,
    )
    .all<{
      code: string;
      name: string;
      sortNo: number;
      purchaseEnabled: number;
      saleType: string;
      displayPrice: number | null;
      billingInterval: string | null;
    }>();
  // 各商品の依存グループ（M_PRODUCT_DEPENDENCY 正本）をまとめて取得し、公開情報として付与する。
  // Store カードの依存案内はこれを正本にする（site-config の固定 dependsOn は使わない）。
  const depsByCode = await getAllProductDependencyGroups(env);
  // purchaseEnabled は boolean へ正規化して返す（公開情報のみ）。
  const products = (rows.results ?? []).map((r) => ({
    code: r.code,
    name: r.name,
    sortNo: r.sortNo,
    purchaseEnabled: r.purchaseEnabled === 1,
    saleType: r.saleType,
    displayPrice: r.displayPrice,
    billingInterval: r.billingInterval,
    // 依存グループ（ANY_OF＋satisfyMode）。依存なしは空配列。商品コードのみ（PRODUCT_NAME 変換はフロント）。
    dependencies: depsByCode[r.code] ?? [],
  }));
  return jsonOk({ products });
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
