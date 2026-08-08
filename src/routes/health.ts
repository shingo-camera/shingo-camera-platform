/**
 * GET /api/health
 *
 * 稼働確認用エンドポイント。共通レスポンス骨格を通して 200 を返す。
 * 認証・DB・外部サービスには依存しない（WORK-001 の範囲）。
 *
 * 設計根拠:
 * - implementation/WORK-001_PLATFORM_FOUNDATION.md「/api/health が 200 を返す」
 * - api/API.md 4「共通レスポンス」（result: "OK"）
 * - 返却内容 service / environment は本 WORK での確定仕様
 */

import { jsonOk } from "../shared/response";
import type { Env } from "../index";

/** サービス識別子（固定） */
const SERVICE_NAME = "shingo-camera-platform";

/** ヘルスチェックの応答データ型 */
export interface HealthData {
  service: string;
  /** 実行環境。APP_ENV で切り替える（既定は production） */
  environment: string;
}

/**
 * ヘルスチェックを処理する。
 *
 * environment は環境変数 APP_ENV を参照する。
 * 未設定時は production を既定とする（本番で未設定でも安全側に倒す）。
 * APP_ENV は秘密情報ではないため通常の環境変数として扱う。
 *
 * @param env Workers 環境バインディング
 * @returns 200 の共通成功レスポンス
 */
export function handleHealth(env: Env): Response {
  const data: HealthData = {
    service: SERVICE_NAME,
    environment: env.APP_ENV ?? "production",
  };
  return jsonOk(data);
}
