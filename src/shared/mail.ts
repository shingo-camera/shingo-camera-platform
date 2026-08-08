/**
 * WORK-009 Warning 管理者メール通知（Resend）
 *
 * 仕様（正本）:
 * - サービス: Resend。用途は Warning 発生時の管理者通知のみ。
 * - API Key: env.MAIL_API_KEY（既存 Secret）。実値をコード/Git に書かない。
 * - From: warning@shingo-camera.com
 * - To: env.ADMIN_AUTH_USER_ID に対応する M_USER.LOGIN_MAIL
 *       （ADMIN_AUTH_USER_ID は管理者識別の基準。LOGIN_MAIL は通知先取得にのみ使う。
 *        メールアドレスだけで管理者判定はしない。）
 * - 本文に Password / JWT / Secret / API Key 等を含めない。
 */

import { getDb } from "./db";
import type { Env } from "../index";

/** Warning 通知メールの送信元（正本で確定）*/
export const WARNING_MAIL_FROM = "warning@shingo-camera.com";

/** 件名（operation/WARNING.md 7 の例）*/
export const WARNING_MAIL_SUBJECT = "【要確認】利用状況の確認が必要です";

/**
 * 管理者（ADMIN_AUTH_USER_ID）の通知先メールアドレスを取得する。
 * M_USER.LOGIN_MAIL を宛先取得にのみ使用する。存在しなければ null。
 */
export async function getAdminNotifyEmail(env: Env): Promise<string | null> {
  const adminId = env.ADMIN_AUTH_USER_ID;
  if (!adminId || adminId.trim() === "") {
    return null;
  }
  const db = getDb(env);
  const row = await db
    .prepare("SELECT LOGIN_MAIL FROM M_USER WHERE AUTH_USER_ID = ? AND DEL_FLG = 0")
    .bind(adminId)
    .first<{ LOGIN_MAIL: string }>();
  if (!row || !row.LOGIN_MAIL || row.LOGIN_MAIL.trim() === "") {
    return null;
  }
  return row.LOGIN_MAIL;
}

/** メール送信の依存を注入可能にするための型（テストでモックする）*/
export type MailSender = (args: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}) => Promise<{ ok: boolean; status: number; error?: string }>;

/**
 * 実際に Resend API を呼ぶ送信関数。
 * fetch 失敗・非 2xx は ok:false を返す（例外を投げない）。
 */
export const resendSender: MailSender = async ({ apiKey, from, to, subject, text }) => {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `resend_http_${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "resend_fetch_failed" };
  }
};

/**
 * 管理者へ Warning 通知メールを送信する。
 * - API Key 未設定・宛先不明の場合は送信せず ok:false を返す。
 * - 送信可否のみを返し、NOTIFIED_DATE 更新は呼出側（送信成功時のみ）で行う。
 * @param sender 送信関数（省略時 resendSender。テストでモック注入）
 */
export async function sendWarningMail(
  env: Env,
  to: string,
  subject: string,
  text: string,
  sender: MailSender = resendSender,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const apiKey = env.MAIL_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    return { ok: false, status: 0, error: "mail_api_key_missing" };
  }
  if (!to || to.trim() === "") {
    return { ok: false, status: 0, error: "recipient_missing" };
  }
  return sender({ apiKey, from: WARNING_MAIL_FROM, to, subject, text });
}
