/**
 * ログ書き込み共通関数
 *
 * T_LOGIN_LOG / T_ACCESS_LOG への記録を共通化する。
 *
 * 設計根拠:
 * - database/TABLES.md T_LOGIN_LOG / T_ACCESS_LOG（カラム定義）
 * - database/DDL.sql（LOGIN_RESULT IN (0,1,2), ACCESS_TYPE IN (0,1,2)）
 * - api/API.md 10 / SECURITY.md 7「パスワード・完全なJWT・秘密情報をログへ出さない」
 * - REVIEW_RULE.md 5「Prepared Statement」
 *
 * 方針:
 * - 日時は nowIso()（JST +09:00）。
 * - SQL は Prepared Statement + bind。
 * - Cloudflare で取得できる接続情報（IP / 国 / 地域 / 市 / UA）は存在するものだけ保存。
 * - OS・ブラウザ等は推測生成しない。取得できない値は NULL。
 * - パスワード・完全な JWT・外部サービスの秘密詳細は保存しない。
 */

import { getDb } from "./db";
import { getDeviceId } from "./device";
import { nowIso } from "./datetime";
import type { Env } from "../index";

/** ログイン結果コード */
export const LOGIN_RESULT = {
  FAILURE: 0,
  SUCCESS: 1,
  LOGOUT: 2,
} as const;
export type LoginResult = (typeof LOGIN_RESULT)[keyof typeof LOGIN_RESULT];

/** アクセス種別コード */
export const ACCESS_TYPE = {
  APP_START: 0,
  ENTITLEMENT_CHECK: 1,
  PERIODIC_CHECK: 2,
} as const;
export type AccessType = (typeof ACCESS_TYPE)[keyof typeof ACCESS_TYPE];

/** Cloudflare リクエストから取得できる接続情報（存在するものだけ） */
interface ConnInfo {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  deviceId: string | null;
  userAgent: string | null;
}

/**
 * リクエストから接続情報を抽出する。
 * 取得できない値は null。OS/ブラウザは推測しないため含めない。
 */
function extractConnInfo(request: Request): ConnInfo {
  // Cloudflare の地理情報は request.cf に入る（ローカルや非CF環境では undefined）。
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf;
  const cfStr = (k: string): string | null => {
    const v = cf?.[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("CF-Connecting-IP") ??
    null;
  const ua = request.headers.get("user-agent");
  return {
    ip: ip && ip.length > 0 ? ip : null,
    country: cfStr("country"),
    region: cfStr("region"),
    city: cfStr("city"),
    deviceId: getDeviceId(request),
    userAgent: ua && ua.length > 0 ? ua : null,
  };
}

/** writeLoginLog の引数 */
export interface WriteLoginLogInput {
  /** 成功/ログアウトは AUTH_USER_ID を渡す。失敗で特定不能なら null。 */
  authUserId: string | null;
  result: LoginResult;
  /** 失敗理由（外部サービスの秘密詳細を含めない短い理由）。任意。 */
  failureReason?: string | null;
}

/**
 * T_LOGIN_LOG へ1件記録する。
 *
 * @param request 受信リクエスト（接続情報の抽出に使用）
 * @param env 環境
 * @param input 記録内容
 */
export async function writeLoginLog(
  request: Request,
  env: Env,
  input: WriteLoginLogInput,
): Promise<void> {
  const db = getDb(env);
  const now = nowIso();
  const c = extractConnInfo(request);
  // OS_NAME / BROWSER_NAME は推測生成しないため NULL 固定。
  await db
    .prepare(
      `INSERT INTO T_LOGIN_LOG
         (AUTH_USER_ID, LOGIN_DATE, LOGIN_RESULT, IP_ADDRESS, COUNTRY_CODE, REGION, CITY,
          DEVICE_ID, USER_AGENT, OS_NAME, BROWSER_NAME, FAILURE_REASON, CREATE_DATE)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      input.authUserId,
      now,
      input.result,
      c.ip,
      c.country,
      c.region,
      c.city,
      c.deviceId,
      c.userAgent,
      input.failureReason ?? null,
      now,
    )
    .run();
}

/** writeAccessLog の引数 */
export interface WriteAccessLogInput {
  authUserId: string;
  productId: number;
  accessType: AccessType;
}

/**
 * T_ACCESS_LOG へ1件記録する。
 *
 * 全 API 呼出しを記録してはならない。呼出側が「アプリ起動 / 権限確認 /
 * 定期確認」に絞って呼ぶ（自動記録を広範囲へ追加しない）。
 *
 * @param request 受信リクエスト
 * @param env 環境
 * @param input 記録内容
 */
export async function writeAccessLog(
  request: Request,
  env: Env,
  input: WriteAccessLogInput,
): Promise<void> {
  const db = getDb(env);
  const now = nowIso();
  const c = extractConnInfo(request);
  // OS_NAME / BROWSER_NAME / SESSION_ID_HASH は推測生成しないため NULL 固定。
  await db
    .prepare(
      `INSERT INTO T_ACCESS_LOG
         (AUTH_USER_ID, PRODUCT_ID, ACCESS_DATE, ACCESS_TYPE, IP_ADDRESS, COUNTRY_CODE, REGION, CITY,
          DEVICE_ID, USER_AGENT, OS_NAME, BROWSER_NAME, SESSION_ID_HASH, CREATE_DATE)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .bind(
      input.authUserId,
      input.productId,
      now,
      input.accessType,
      c.ip,
      c.country,
      c.region,
      c.city,
      c.deviceId,
      c.userAgent,
      now,
    )
    .run();
}
