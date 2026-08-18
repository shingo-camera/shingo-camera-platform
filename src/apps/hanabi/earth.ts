/**
 * HANABI Google Earth 追加機能の entitlement 判定
 *
 * パス: GET /api/apps/hanabi/earth-entitlement
 *
 * 役割:
 * - HANABI 本体アプリ画面内の「Google Earth Pro 用 KML/KMZ ダウンロード」機能（GEP 機能）は
 *   追加商品 HANABI_GOOGLE_EARTH の所有者のみ利用可とする。
 * - 旧 HANABI では独自パスワード（/.netlify/functions/check-password type=gep）で解放していたが、
 *   Platform 統合により既存 entitlement へ置換する。新しい Earth 権利判定は作らない。
 *
 * 方針:
 * - 既存 requireProduct(HANABI_GOOGLE_EARTH) をそのまま再利用する。
 *   - 権限あり            → 200 { hasEarth: true }
 *   - 権限なし(403)       → 200 { hasEarth: false }（未購入は「機能なし」であってエラーではない）
 *   - 未ログイン(401)     → 401（呼出側フロントでログイン導線へ）
 *   - アカウント停止(403 USER_SUSPENDED) → その 403 をそのまま返す
 *   - 商品未定義(404)     → その 404 をそのまま返す
 * - アプリ導線上は本体 app-start(HANABI) を先に通過している前提だが、本判定は
 *   HANABI_GOOGLE_EARTH の所有可否を独立に返すため、本体の有無に依存しない。
 * - アクセスログは記録しない（entitlement 判定のみ。ACCESS_TYPE の意味を変えない）。
 */

import type { Env } from "../../index";
import { requireProduct } from "../../shared/entitlement";
import { AuthError } from "../../shared/auth";
import { AppError } from "../../shared/errors";
import { jsonOk, jsonError } from "../../shared/response";

const HANABI_GOOGLE_EARTH = "HANABI_GOOGLE_EARTH";

export async function handleHanabiEarthEntitlement(request: Request, env: Env): Promise<Response> {
  try {
    await requireProduct(request, env, HANABI_GOOGLE_EARTH);
    // 追加商品の権限あり → GEP 機能を解放する。
    return jsonOk({ hasEarth: true });
  } catch (e) {
    if (e instanceof AuthError) {
      // 未購入/停止/期限前/期限切れを区別しない共通コード。
      // 「機能を持っていない」だけの状態（PRODUCT_NOT_GRANTED）は 200 + hasEarth:false で返す
      // （フロントは商品案内へ誘導するだけで、エラー表示にしない）。
      if (e.code === "PRODUCT_NOT_GRANTED") {
        return jsonOk({ hasEarth: false });
      }
      // 未ログイン(401)・アカウント停止(403 USER_SUSPENDED)・商品未定義(404)はそのまま返す。
      return jsonError(e.code, e.message, e.status);
    }
    if (e instanceof AppError) {
      return jsonError(e.code, e.message, e.status);
    }
    throw e;
  }
}
