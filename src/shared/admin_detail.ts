/**
 * 管理: ユーザー詳細取得（読み取り）
 *
 * M_USER / T_USER_PRODUCT / T_PURCHASE / T_NOTE_PURCHASE /
 * T_LOGIN_LOG / T_ACCESS_LOG / T_WARNING を取得する。
 * ログ・履歴系（LOGIN/ACCESS/WARNING/PURCHASE/NOTE_PURCHASE）は新しい順・件数制限（初期50件、
 * 追加読込は logOffset で対応）。無制限取得はしない。
 *
 * 設計根拠: api/ADMIN_API.md 5, screen/ADMIN.md 5
 *
 * note 履歴は「表示のみ」（WORK-006 では取込・紐付け操作は実装しない）。
 */

import { getDb } from "./db";
import type { Env } from "../index";

/** ログ初期取得件数 */
const LOG_LIMIT = 50;

/** ユーザー詳細の返却型 */
export interface AdminUserDetail {
  user: Record<string, unknown> | null;
  products: Array<Record<string, unknown>>;
  purchases: Array<Record<string, unknown>>;
  notePurchases: Array<Record<string, unknown>>;
  loginLogs: Array<Record<string, unknown>>;
  accessLogs: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
}

/**
 * ユーザー詳細を取得する。
 * @param env 環境
 * @param authUserId 対象ユーザー
 * @param logLimit ログ取得件数（既定 50）
 * @param logOffset ログ取得オフセット（追加読込用、既定 0）
 */
export async function getUserDetail(
  env: Env,
  authUserId: string,
  logLimit: number = LOG_LIMIT,
  logOffset: number = 0,
): Promise<AdminUserDetail> {
  const db = getDb(env);

  const user = await db
    .prepare(
      `SELECT AUTH_USER_ID, LOGIN_MAIL, STATUS, MAIL_AUTH_DATE, PASSWORD_CHANGE_DATE,
              LAST_LOGIN_DATE, DEL_FLG, CREATE_DATE, UPDATE_DATE
       FROM M_USER WHERE AUTH_USER_ID = ?`,
    )
    .bind(authUserId)
    .first<Record<string, unknown>>();

  const products = await db
    .prepare(
      `SELECT p.PRODUCT_CODE AS productCode, p.PRODUCT_NAME AS productName,
              up.STATUS AS status, up.START_DATE AS startDate, up.END_DATE AS endDate,
              up.GRANT_TYPE AS grantType, up.MEMO AS memo, up.DEL_FLG AS delFlg
       FROM T_USER_PRODUCT up JOIN M_PRODUCT p ON p.PRODUCT_ID = up.PRODUCT_ID
       WHERE up.AUTH_USER_ID = ?
       ORDER BY p.SORT_NO ASC`,
    )
    .bind(authUserId)
    .all<Record<string, unknown>>();

  const purchases = await db
    .prepare(
      `SELECT t.PURCHASE_ID AS purchaseId, p.PRODUCT_CODE AS productCode,
              t.PURCHASE_SOURCE AS purchaseSource, t.EXTERNAL_PURCHASE_ID AS externalPurchaseId,
              t.PURCHASE_DATE AS purchaseDate, t.AMOUNT AS amount,
              t.PAYMENT_STATUS AS paymentStatus, t.REFUND_DATE AS refundDate
       FROM T_PURCHASE t JOIN M_PRODUCT p ON p.PRODUCT_ID = t.PRODUCT_ID
       WHERE t.AUTH_USER_ID = ? AND t.DEL_FLG = 0
       ORDER BY t.PURCHASE_DATE DESC LIMIT ? OFFSET ?`,
    )
    .bind(authUserId, logLimit, logOffset)
    .all<Record<string, unknown>>();

  // note 履歴（このユーザーへ紐付いた移行レコードを表示のみ）
  const notePurchases = await db
    .prepare(
      `SELECT n.NOTE_PURCHASE_ID AS notePurchaseId, p.PRODUCT_CODE AS productCode,
              n.NOTE_ID AS noteId, n.NOTE_TRANSACTION_ID AS noteTransactionId,
              n.PURCHASE_DATE AS purchaseDate, n.MATCH_STATUS AS matchStatus,
              n.MATCH_DATE AS matchDate
       FROM T_NOTE_PURCHASE n JOIN M_PRODUCT p ON p.PRODUCT_ID = n.PRODUCT_ID
       WHERE n.MATCH_AUTH_USER_ID = ? AND n.DEL_FLG = 0
       ORDER BY n.PURCHASE_DATE DESC LIMIT ? OFFSET ?`,
    )
    .bind(authUserId, logLimit, logOffset)
    .all<Record<string, unknown>>();

  const loginLogs = await db
    .prepare(
      `SELECT LOGIN_LOG_ID AS loginLogId, LOGIN_DATE AS loginDate, LOGIN_RESULT AS loginResult,
              IP_ADDRESS AS ip, COUNTRY_CODE AS country, REGION AS region, CITY AS city,
              DEVICE_ID AS deviceId, USER_AGENT AS userAgent, FAILURE_REASON AS failureReason
       FROM T_LOGIN_LOG WHERE AUTH_USER_ID = ?
       ORDER BY LOGIN_DATE DESC LIMIT ? OFFSET ?`,
    )
    .bind(authUserId, logLimit, logOffset)
    .all<Record<string, unknown>>();

  const accessLogs = await db
    .prepare(
      `SELECT a.ACCESS_LOG_ID AS accessLogId, p.PRODUCT_CODE AS productCode,
              a.ACCESS_DATE AS accessDate, a.ACCESS_TYPE AS accessType,
              a.IP_ADDRESS AS ip, a.COUNTRY_CODE AS country, a.REGION AS region, a.CITY AS city,
              a.DEVICE_ID AS deviceId, a.USER_AGENT AS userAgent
       FROM T_ACCESS_LOG a LEFT JOIN M_PRODUCT p ON p.PRODUCT_ID = a.PRODUCT_ID
       WHERE a.AUTH_USER_ID = ?
       ORDER BY a.ACCESS_DATE DESC LIMIT ? OFFSET ?`,
    )
    .bind(authUserId, logLimit, logOffset)
    .all<Record<string, unknown>>();

  const warnings = await db
    .prepare(
      `SELECT w.WARNING_ID AS warningId, p.PRODUCT_CODE AS productCode,
              w.WARNING_TYPE AS warningType, w.WARNING_SCORE AS warningScore,
              w.DETECT_DATE AS detectDate, w.NOTIFIED_DATE AS notifiedDate,
              w.STATUS AS status, w.MEMO AS memo
       FROM T_WARNING w LEFT JOIN M_PRODUCT p ON p.PRODUCT_ID = w.PRODUCT_ID
       WHERE w.AUTH_USER_ID = ?
       ORDER BY w.DETECT_DATE DESC LIMIT ? OFFSET ?`,
    )
    .bind(authUserId, logLimit, logOffset)
    .all<Record<string, unknown>>();

  return {
    user: user ?? null,
    products: products.results ?? [],
    purchases: purchases.results ?? [],
    notePurchases: notePurchases.results ?? [],
    loginLogs: loginLogs.results ?? [],
    accessLogs: accessLogs.results ?? [],
    warnings: warnings.results ?? [],
  };
}
