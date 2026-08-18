/**
 * HANABI 中核計算 API エンドポイント（HANABI 本体 entitlement で保護）。
 *
 * - POST /api/apps/hanabi/scene-solve   : renderSim の答え計算（独自 elAng/wind/号数内部param 適用の結果値）
 * - POST /api/apps/hanabi/terrain-solve : 地形遮蔽・稜線（サーバ完結・単一 phase。sampling/tile取得/decode/計算すべて server）
 *
 * いずれも既存 requireProduct(request, env, "HANABI") で認可（新しい認可機構は作らない）。
 * fail-closed: 認可失敗・入力不正時は結果を返さずエラー。client は旧計算へ fallback しない。
 * 独自係数・独自式そのものは応答に含めない（適用済み結果値のみ返す）。
 *
 * 入力検証（core/validate.ts）: 認証済みでも client 入力を無制限に信用しない。
 * 数値有限性・緯度経度範囲・配列長・nAzimuths・距離・各種数値上限を検証し、Worker の
 * CPU/メモリを保護する。不正値は BAD_REQUEST（fail-closed）。
 */

import type { Env } from "../../index";
import { requireProduct } from "../../shared/entitlement";
import { AuthError } from "../../shared/auth";
import { AppError } from "../../shared/errors";
import { jsonOk, jsonError } from "../../shared/response";
import { solveScene } from "./core/scene";
import { solveTerrain } from "./core/terrain";
import { TerrainElevationProvider } from "./core/terrain_tiles";
import {
  ValidationError,
  validateSceneRequest,
  validateTerrainSolve,
} from "./core/validate";

const HANABI = "HANABI";

async function authorizeHanabi(request: Request, env: Env): Promise<Response | null> {
  try {
    await requireProduct(request, env, HANABI);
    return null;
  } catch (e) {
    if (e instanceof AuthError) return jsonError(e.code, e.message, e.status);
    if (e instanceof AppError) return jsonError(e.code, e.message, e.status);
    throw e;
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** POST /api/apps/hanabi/scene-solve */
export async function handleHanabiSceneSolve(request: Request, env: Env): Promise<Response> {
  const denied = await authorizeHanabi(request, env);
  if (denied) return denied; // fail-closed（認可失敗）

  const body = await readJson(request);
  if (body === null) return jsonError("BAD_REQUEST", "リクエスト本文が不正です。", 400);

  let req;
  try {
    req = validateSceneRequest(body);
  } catch (e) {
    if (e instanceof ValidationError) return jsonError("BAD_REQUEST", e.message, 400);
    throw e;
  }

  const result = solveScene(req);
  // solveScene の ok:false（視点/筒場未確定）は正当な計算結果（描画不能状態）であり 200 で返す。
  // fail-closed の対象は認可・入力不正・サーバ異常であり、シーン未確定はエラーではない。
  return jsonOk(result);
}

/** POST /api/apps/hanabi/terrain-solve （phase=plan | compute） */
export async function handleHanabiTerrainSolve(request: Request, env: Env): Promise<Response> {
  const denied = await authorizeHanabi(request, env);
  if (denied) return denied; // fail-closed（認可失敗）

  const body = await readJson(request);
  if (body === null) return jsonError("BAD_REQUEST", "リクエスト本文が不正です。", 400);

  let req;
  try {
    req = validateTerrainSolve(body);
  } catch (e) {
    if (e instanceof ValidationError) return jsonError("BAD_REQUEST", e.message, 400);
    throw e;
  }

  // サーバ完結: サンプリング位置の内部生成・tile 取得/decode・遮蔽/稜線計算まで行い、最終結果のみ返す。
  // tile 取得中の PngError（未対応形式）・過大 tile 等は fail-closed（terrain 表示のみエラー）。
  const provider = new TerrainElevationProvider();
  try {
    const result = await solveTerrain(req, provider);
    if (provider.hadFailure()) {
      // 未対応 PNG・tile 過多など、地形取得に致命的失敗 → fail-closed（client は旧計算へ fallback しない）。
      return jsonError("TERRAIN_UNAVAILABLE", "地形データの取得に失敗しました。", 502);
    }
    return jsonOk(result);
  } catch (e) {
    if (e instanceof ValidationError) return jsonError("BAD_REQUEST", e.message, 400);
    return jsonError("TERRAIN_UNAVAILABLE", "地形データの取得に失敗しました。", 502);
  }
}
