/**
 * WORK-010 SUN AND MOON 固有APIルーター
 *
 * パス: /api/apps/sun-and-moon/{name}
 *
 * 方針（確定仕様）:
 * - 各計算APIは既存 requireProduct(request, env, "SUN_AND_MOON") を必ず通す（新認証方式を作らない）。
 * - 計算ロジックは sun-and-moon.zip の Pages Functions を無改変移植した .js を呼ぶ
 *   （src/apps/sun-and-moon/api/*.js）。計算結果を一切変えない。
 * - 各計算APIではアクセスログを記録しない（requireProduct のみ）。
 *   アプリ起動時の ACCESS_TYPE=0 (APP_START) 記録は別ルート（app_access.ts）で1回だけ行う。
 * - CORS はPlatForm統合で同一オリジン利用のため router では付与しない
 *   （移植した .js の onRequest 内に元のCORSヘッダは残るが、同一オリジンでは無害。
 *    計算結果・レスポンス本体の同一性を守るため .js は改変しない）。
 * - prefecture の Cache API 用に Worker の ExecutionContext.waitUntil を渡す。
 */

import type { Env } from "../../index";
import { requireProduct } from "../../shared/entitlement";
import { AuthError } from "../../shared/auth";
import { jsonError } from "../../shared/response";
import { AppError } from "../../shared/errors";

// 無改変移植した計算API（Pages Functions 形式 onRequest）
import { onRequest as chance } from "./api/chance.js";
import { onRequest as events } from "./api/events.js";
import { onRequest as fans } from "./api/fans.js";
import { onRequest as fullmoon } from "./api/fullmoon.js";
import { onRequest as instant } from "./api/instant.js";
import { onRequest as kmzastro } from "./api/kmzastro.js";
import { onRequest as mooncalendar } from "./api/mooncalendar.js";
import { onRequest as pinpoint } from "./api/pinpoint.js";
import { onRequest as prefecture } from "./api/prefecture.js";
import { onRequest as trajectory } from "./api/trajectory.js";
import { onRequest as weatherbody } from "./api/weatherbody.js";

const SUN_AND_MOON = "SUN_AND_MOON";

/** name → onRequest ハンドラ（無改変移植） */
type ApiHandler = (context: {
  request: Request;
  waitUntil?: (p: Promise<unknown>) => void;
}) => Response | Promise<Response>;

const HANDLERS: Record<string, ApiHandler> = {
  chance,
  events,
  fans,
  fullmoon,
  instant,
  kmzastro,
  mooncalendar,
  pinpoint,
  prefecture,
  trajectory,
  weatherbody,
};

/**
 * /api/apps/sun-and-moon/{name} を処理する。
 * 一致しなければ null を返す（呼出側で 404 継続）。
 */
export async function handleSunAndMoonApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  name: string,
): Promise<Response | null> {
  const handler = HANDLERS[name];
  if (!handler) {
    return null;
  }

  // OPTIONS（CORSプリフライト）は移植した onRequest 側で処理させる（権限確認不要）。
  // 認証を要求するとプリフライトが失敗するため、ここでは通す。
  if (request.method === "OPTIONS") {
    return Promise.resolve(handler({ request }));
  }

  // 権限確認（アクセスログは記録しない = requireProduct のみ）。
  try {
    await requireProduct(request, env, SUN_AND_MOON);
  } catch (e) {
    if (e instanceof AuthError) {
      return jsonError(e.code, e.message, e.status);
    }
    if (e instanceof AppError) {
      return jsonError(e.code, e.message, e.status);
    }
    throw e;
  }

  // 計算API本体（無改変）を呼ぶ。prefecture のキャッシュ put 用に waitUntil を渡す。
  return handler({
    request,
    waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
  });
}
