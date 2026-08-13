/**
 * SUN AND MOON 継続利用中の低頻度セッション観測（heartbeat）
 *
 * パス: POST /api/apps/sun-and-moon/heartbeat
 *
 * ログイン状態を維持したまま長時間利用していても、利用地点・セッションを再観測できるようにする。
 * 強制的なセッション期限・定期再ログインは導入せず、通常利用中の観測で不正検知（多地点利用等）を成立させる。
 *
 * 方針:
 * - requireProduct(SUN_AND_MOON) で権限確認（未ログイン/無効JWT/未購入/停止を拒否）。
 * - recordPeriodicAccess で ACCESS_TYPE=2 (PERIODIC_CHECK) を「既存の抑制機構」付きで append 記録。
 *   新しい LAST_SEEN 型集約は導入せず、ACCESS_LOG_INTERVAL_MIN（既定60分）で低頻度化する。
 * - authUserId / session_id は検証済み JWT を正本にする（リクエスト本文は信用しない）。
 * - session_id はサーバー鍵で HMAC 化して SESSION_ID_HASH に保存（生 session_id は保存しない）。
 * - DEVICE_ID は既存 X-Device-Id、IP/国/地域/市/UA は既存 Cloudflare request 情報を再利用。
 * - GPS 等は取得しない。
 * - entitlement / 購入権限は一切変更しない（観測のみ）。
 * - 記録失敗・設定エラーでもアプリ本体の利用を妨げない（利用者へ内部詳細を返さない）。
 */

import type { Env } from "../../index";
import { requireProduct, recordPeriodicAccess, AccessLogSettingError } from "../../shared/entitlement";
import { AuthError } from "../../shared/auth";
import { AppError } from "../../shared/errors";
import { jsonOk, jsonError } from "../../shared/response";

const SUN_AND_MOON = "SUN_AND_MOON";

export async function handleSunAndMoonHeartbeat(request: Request, env: Env): Promise<Response> {
  let result;
  try {
    // 権限確認（entitlement は変更せず、確認のみ）。未ログイン/無効JWT/未購入/停止は拒否。
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

  // PERIODIC_CHECK アクセスログ（既存抑制付き・append 型）。
  // 設定値異常でも観測をスキップするだけで、アプリ本体の利用は妨げない。
  try {
    await recordPeriodicAccess(
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

  // 観測が成立したことだけを返す。entitlement 状態やセッション詳細は返さない。
  return jsonOk({ observed: true });
}
