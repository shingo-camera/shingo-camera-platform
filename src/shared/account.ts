/**
 * M_USER 同期共通ロジック
 *
 * POST /api/account/sync と GET /api/account/me が共用する。
 * me と sync で別々の INSERT/UPDATE SQL を持たないため、ここへ集約する。
 *
 * 設計根拠:
 * - api/AUTH_API.md 3「M_USER 同期」（新規INSERT: STATUS=1、既存UPDATE: STATUS維持）
 * - api/AUTH_API.md 2「me は M_USER が無ければ同期処理」
 * - WORK-003 実機確認済みロジックを維持
 *
 * 正本:
 * - AUTH_USER_ID / LOGIN_MAIL は検証済み JWT を正本にする。
 * - ブラウザ送信のメールは使わない。
 */

import type { AuthContext } from "./auth";
import { getDb } from "./db";
import { nowIso } from "./datetime";
import type { Env } from "../index";

/** M_USER 行（必要カラム） */
export interface MUserRow {
  AUTH_USER_ID: string;
  LOGIN_MAIL: string;
  STATUS: number;
  MAIL_AUTH_DATE: string | null;
  PASSWORD_CHANGE_DATE: string | null;
  LAST_LOGIN_DATE: string | null;
  DEL_FLG: number;
  CREATE_DATE: string;
  UPDATE_DATE: string;
}

/**
 * M_USER を同期し、同期後の行を返す。
 *
 * - 既存: LOGIN_MAIL（JWTにemailがある場合）/ LAST_LOGIN_DATE / UPDATE_DATE を更新。
 *   STATUS は変更しない（停止2・退会9を維持）。
 * - 新規: STATUS=1、MAIL_AUTH_DATE=now で INSERT。
 *   検証済みトークンに email が無い場合、新規作成できないため null を返す。
 *
 * @param env 環境
 * @param auth 検証済み認証コンテキスト
 * @returns 同期後の M_USER 行。email 欠落で新規作成不能なら null。
 */
export async function syncMUser(env: Env, auth: AuthContext): Promise<MUserRow | null> {
  const db = getDb(env);
  const now = nowIso();
  const email = auth.email;

  const existing = await db
    .prepare("SELECT AUTH_USER_ID FROM M_USER WHERE AUTH_USER_ID = ?")
    .bind(auth.authUserId)
    .first<{ AUTH_USER_ID: string }>();

  if (existing) {
    if (email !== null) {
      await db
        .prepare(
          "UPDATE M_USER SET LOGIN_MAIL = ?, LAST_LOGIN_DATE = ?, UPDATE_DATE = ? WHERE AUTH_USER_ID = ?",
        )
        .bind(email, now, now, auth.authUserId)
        .run();
    } else {
      await db
        .prepare("UPDATE M_USER SET LAST_LOGIN_DATE = ?, UPDATE_DATE = ? WHERE AUTH_USER_ID = ?")
        .bind(now, now, auth.authUserId)
        .run();
    }
  } else {
    if (email === null) {
      console.error("[account] verified token has no email and no existing M_USER");
      return null;
    }
    await db
      .prepare(
        `INSERT INTO M_USER
           (AUTH_USER_ID, LOGIN_MAIL, STATUS, MAIL_AUTH_DATE, LAST_LOGIN_DATE, DEL_FLG, CREATE_DATE, UPDATE_DATE)
         VALUES (?, ?, 1, ?, ?, 0, ?, ?)`,
      )
      .bind(auth.authUserId, email, now, now, now, now)
      .run();
  }

  // 同期後の行を返す
  const row = await db
    .prepare(
      `SELECT AUTH_USER_ID, LOGIN_MAIL, STATUS, MAIL_AUTH_DATE, PASSWORD_CHANGE_DATE,
              LAST_LOGIN_DATE, DEL_FLG, CREATE_DATE, UPDATE_DATE
       FROM M_USER WHERE AUTH_USER_ID = ?`,
    )
    .bind(auth.authUserId)
    .first<MUserRow>();

  return row ?? null;
}

/**
 * M_USER を取得する（同期しない）。
 * @param env 環境
 * @param authUserId AUTH_USER_ID
 * @returns 行または null
 */
export async function getMUser(env: Env, authUserId: string): Promise<MUserRow | null> {
  const db = getDb(env);
  const row = await db
    .prepare(
      `SELECT AUTH_USER_ID, LOGIN_MAIL, STATUS, MAIL_AUTH_DATE, PASSWORD_CHANGE_DATE,
              LAST_LOGIN_DATE, DEL_FLG, CREATE_DATE, UPDATE_DATE
       FROM M_USER WHERE AUTH_USER_ID = ?`,
    )
    .bind(authUserId)
    .first<MUserRow>();
  return row ?? null;
}
