/**
 * WORK-009 Warning ジョブ（Cron 1 回分の処理）
 *
 * 設計（正本確定仕様）:
 * 1. 4 種の Warning を検知（種別ごと独立、スコア合算なし）。
 * 2. 継続事象は 1 行を再利用する。
 *    - 同一 AUTH_USER_ID + WARNING_TYPE で PERIOD_END が GAP（=判定窓）以内の既存行があれば、
 *      STATUS(0/1/2/9) を問わず同一の継続事象としてその行を UPDATE（PERIOD_END/SCORE/UPDATE_DATE）。
 *    - DETECT_DATE / PERIOD_START は初回値を固定し更新しない。
 *    - STATUS / MEMO / LAST_ACTION_DATE は Cron から変更しない（管理者領域）。
 *    - 継続行がなければ（初回 or GAP 超過後の再発）新規 INSERT（新 WARNING_ID）。
 * 3. メール再通知は行の継続とは分離し、STATUS と NOTIFIED_DATE で判定する。
 *    - STATUS=0（未対応）かつ NOTIFIED_DATE が NULL または 60 分以上前 → 再通知可。
 *    - STATUS=1/2/9 → 同一継続事象について再通知しない（PERIOD_END は更新する）。
 *    - 送信成功時のみ、その行の NOTIFIED_DATE を更新する。
 *    - 送信失敗時も新規行を作らず、NOTIFIED_DATE も更新しない。
 *
 * 堅牢性:
 * - 1 ユーザー / 1 Warning の失敗で全体が不整合にならないよう、各件を独立処理する。
 * - Warning 検知を理由に M_USER / T_USER_PRODUCT の STATUS を変更しない。
 */

import {
  detectWarnings,
  findActiveWarning,
  touchActiveWarning,
  insertWarning,
  updateNotifiedDate,
  jstIsoFromMs,
  type WarningDetection,
} from "./warning";
import {
  getAdminNotifyEmail,
  sendWarningMail,
  WARNING_MAIL_SUBJECT,
  type MailSender,
  resendSender,
} from "./mail";
import type { Env } from "../index";

/** T_WARNING.STATUS = 0（未対応）。メール再通知が許可される唯一の STATUS。*/
const WARNING_STATUS_OPEN = 0;

export interface WarningJobResult {
  detected: number;
  /** 新規 INSERT した T_WARNING 行数 */
  inserted: number;
  /** 継続事象として既存行を UPDATE した数 */
  reused: number;
  /** メール送信に成功して NOTIFIED_DATE を更新した数 */
  notified: number;
  /** メール抑止（STATUS!=0、または 60 分以内に通知済み）でスキップした数 */
  mailSuppressed: number;
  /** メール送信失敗数 */
  mailFailed: number;
  /** 宛先不明でメール送信できなかったか */
  mailSkippedNoRecipient: boolean;
}

/** 通知対象 1 件（行の確定後、メール送信判定に使う）*/
interface NotifyTarget {
  warningId: number;
  detection: WarningDetection;
}

/** メール本文を組み立てる（秘密情報は含めない）。*/
function buildMailBody(targets: NotifyTarget[]): string {
  const lines: string[] = [];
  lines.push("利用状況の確認が必要な事象を検知しました。");
  lines.push("");
  for (const t of targets) {
    const d = t.detection;
    lines.push(`- Warning種別: ${d.warningType}`);
    lines.push(`  対象ユーザー(AUTH_USER_ID): ${d.authUserId}`);
    lines.push(`  検知日時: ${d.periodEnd}`);
    lines.push(`  判定根拠: ${d.detail}`);
    lines.push(`  管理画面で warningId=${t.warningId} を確認してください。`);
    lines.push("");
  }
  lines.push("※本メールは自動送信です。停止・再開・最終判断は管理画面から管理者が行ってください。");
  return lines.join("\n");
}

/**
 * Cron 1 回分の Warning 処理を実行する。
 * @param sender メール送信関数（省略時 resendSender。テストでモック注入）
 * @param nowMs 現在時刻（テスト用に固定可能）
 */
export async function runWarningJob(
  env: Env,
  sender: MailSender = resendSender,
  nowMs: number = Date.now(),
): Promise<WarningJobResult> {
  const result: WarningJobResult = {
    detected: 0,
    inserted: 0,
    reused: 0,
    notified: 0,
    mailSuppressed: 0,
    mailFailed: 0,
    mailSkippedNoRecipient: false,
  };

  const detections = await detectWarnings(env, nowMs);
  result.detected = detections.length;

  // Warning が 0 件ならメールを送らない（正本）。
  if (detections.length === 0) {
    return result;
  }

  const nowIsoStr = jstIsoFromMs(nowMs);

  // 各検知について、継続行の再利用 or 新規登録で WARNING_ID を確定する。
  // そのうえで、メール送信対象（STATUS=0 かつ 60 分間隔経過）を選別する。
  const notifyTargets: NotifyTarget[] = [];
  for (const d of detections) {
    // 継続事象の既存行を探す（GAP = 種別の判定窓 windowMin、STATUS 問わず）。
    const active = await findActiveWarning(env, d.authUserId, d.warningType, d.windowMin, nowMs);

    let warningId: number;
    let status: number;
    let notifiedDate: string | null;

    if (active) {
      // 継続 → 既存行を UPDATE（PERIOD_END / SCORE / UPDATE_DATE）。DETECT_DATE / PERIOD_START 固定。
      try {
        await touchActiveWarning(env, active.warningId, d.score, d.periodEnd, nowIsoStr);
        result.reused += 1;
      } catch {
        // UPDATE 失敗は 1 件スキップ（全体を止めない）。
        continue;
      }
      warningId = active.warningId;
      status = active.status;
      notifiedDate = active.notifiedDate;
    } else {
      // 新規事象（初回 or GAP 超過後の再発）→ INSERT（STATUS=0 / NOTIFIED_DATE=NULL）。
      try {
        warningId = await insertWarning(env, d, nowIsoStr);
        result.inserted += 1;
      } catch {
        continue;
      }
      status = WARNING_STATUS_OPEN;
      notifiedDate = null;
    }

    // メール送信可否（WORK-009 初版: 1 事象 = 1 通）:
    //   - STATUS=0（未対応）であること。STATUS=1/2/9 は送信しない。
    //   - NOTIFIED_DATE が未設定（NULL）であること。既に送信済みなら同一 WARNING_ID では再送しない。
    // WARNING_MAIL_INTERVAL_MIN は同一 WARNING_ID の再送条件には使用しない（既存キーは維持）。
    // メール失敗時は NOTIFIED_DATE が NULL のまま残るため、次 Cron で同一 WARNING_ID の再送を試行できる。
    if (status !== WARNING_STATUS_OPEN) {
      result.mailSuppressed += 1;
      continue;
    }
    if (notifiedDate !== null && notifiedDate.trim() !== "") {
      result.mailSuppressed += 1;
      continue;
    }
    notifyTargets.push({ warningId, detection: d });
  }

  if (notifyTargets.length === 0) {
    return result;
  }

  // 宛先取得（ADMIN_AUTH_USER_ID に対応する LOGIN_MAIL）。
  const to = await getAdminNotifyEmail(env);
  if (!to) {
    result.mailSkippedNoRecipient = true;
    return result;
  }

  // メール送信（1 通に集約）。送信成功時のみ、対象行の NOTIFIED_DATE を更新する。
  const body = buildMailBody(notifyTargets);
  const sent = await sendWarningMail(env, to, WARNING_MAIL_SUBJECT, body, sender);
  if (!sent.ok) {
    // 送信失敗時は NOTIFIED_DATE を更新しない（行は既に確定済み。新規行は作らない）。
    result.mailFailed = notifyTargets.length;
    return result;
  }

  const notifiedIso = jstIsoFromMs(nowMs);
  for (const t of notifyTargets) {
    try {
      await updateNotifiedDate(env, t.warningId, notifiedIso);
      result.notified += 1;
    } catch {
      // NOTIFIED_DATE 更新の 1 件失敗で全体を止めない。
    }
  }

  return result;
}
