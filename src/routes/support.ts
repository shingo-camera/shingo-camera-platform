/**
 * SUPPORT 問い合わせ送信 API（POST /api/support/contact）。
 *
 * 認証: 既存の Platform 認証（requireUser / 検証済み Supabase JWT）を再利用する。
 *   新しい認証方式は追加しない。未認証 request は API 側で拒否する（UI で隠すだけにしない）。
 *   問い合わせ者メールは request body から受け取らず、認証済み JWT の email を正本とする。
 *
 * メール: 既存の Resend 基盤（src/shared/mail.ts / resendSender）を再利用する。
 *   新しいメールサービスは導入しない。Secret はコードに書かず env を参照する。
 *   - 管理者通知（宛先: env.SUPPORT_NOTIFY_EMAIL 優先、なければ getAdminNotifyEmail）
 *   - 問い合わせ者への受付完了メール（宛先: 認証ユーザーの登録メール）
 *
 * セキュリティ:
 * - server-side validation（support_validate.ts の純関数）。種別 allowlist・本文長・空拒否・
 *   ヘッダインジェクション回避・honeypot。email はフォームから受け取らない。
 * - 失敗時に stack trace / 内部 API / Secret / メール送信内部エラーをブラウザへ出さない。
 * - 管理者通知が成功して初めて「受理」とする（受理できていないのに受付済み表示にしない）。
 */
import type { Env } from "../index";
import { jsonOk, jsonError } from "../shared/response";
import { requireUser } from "../shared/auth";
import { resendSender, getAdminNotifyEmail, type MailSender } from "../shared/mail";
import {
  validateSupportInput,
  buildAdminMailText,
  buildAdminMailSubject,
  buildAckMailText,
  buildAckMailSubject,
  type SupportInput,
} from "../shared/support_validate";

// SUPPORT 送信元（Warning と同じ検証済みドメイン。実アドレスは設定不要な固定 From）
export const SUPPORT_MAIL_FROM = "support@shingo-camera.com";

/** 管理者通知の宛先を決定する（SUPPORT_NOTIFY_EMAIL 優先、なければ管理者通知先）。 */
async function resolveSupportRecipient(
  env: Env,
  getAdmin: (env: Env) => Promise<string | null>,
): Promise<string | null> {
  const explicit = env.SUPPORT_NOTIFY_EMAIL;
  if (explicit && explicit.trim() !== "") return explicit.trim();
  return getAdmin(env);
}

/**
 * @param deps テスト用の依存注入（メール送信・管理者宛先取得）。省略時は本番実装。
 */
export async function handleSupportContact(
  request: Request,
  env: Env,
  deps?: {
    sender?: MailSender;
    getAdminNotifyEmail?: (env: Env) => Promise<string | null>;
  },
): Promise<Response> {
  // 認証必須（未認証は 401）。既存の requireUser を再利用する。
  // requireUser が throw する AuthError は、index.ts の withErrorHandling が
  // code/message/status で安全に返す（全ルート共通の既存パターン）。
  const auth = await requireUser(request, env);

  // 問い合わせ者メール = 認証済み JWT の email（body の email は使わない）
  const buyerEmail = auth.email;
  if (!buyerEmail || buyerEmail.trim() === "") {
    return jsonError(
      "AUTH_EMAIL_REQUIRED",
      "アカウントのメールアドレスを確認できませんでした。再度ログインのうえお試しください。",
      403,
    );
  }

  // body パース（不正 JSON は一般エラー）
  let input: SupportInput;
  try {
    input = (await request.json()) as SupportInput;
  } catch {
    return jsonError("INVALID_REQUEST", "リクエストの形式が正しくありません。", 400);
  }

  // server-side validation（email はここでは扱わない）
  const v = validateSupportInput(input);
  if (!v.ok) {
    // honeypot 命中は 200 で握って bot に成否を悟らせない（正規利用者には無害）
    if (v.code === "SPAM_DETECTED") {
      return jsonOk({ accepted: true });
    }
    const msg =
      v.field === "body"
        ? "お問い合わせ内容をご確認ください。"
        : v.field === "category"
          ? "お問い合わせ種別を選択してください。"
          : "入力内容をご確認ください。";
    return jsonError("VALIDATION_ERROR", msg, 400, v.field ? { [v.field]: msg } : undefined);
  }

  // API Key 未設定時は送信不可（内部理由は露出しない）
  const apiKey = env.MAIL_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    return jsonError(
      "SEND_UNAVAILABLE",
      "現在お問い合わせを送信できません。時間をおいて再度お試しください。",
      503,
    );
  }

  // 管理者通知の宛先解決
  const getAdmin = deps?.getAdminNotifyEmail ?? getAdminNotifyEmail;
  const adminTo = await resolveSupportRecipient(env, getAdmin);
  if (!adminTo) {
    return jsonError(
      "SEND_UNAVAILABLE",
      "現在お問い合わせを送信できません。時間をおいて再度お試しください。",
      503,
    );
  }

  const sender = deps?.sender ?? resendSender;

  // 1) 管理者通知を先に送る。これが「受理」の基準（成功しなければ受付済みにしない）。
  const adminResult = await sender({
    apiKey,
    from: SUPPORT_MAIL_FROM,
    to: adminTo,
    subject: buildAdminMailSubject(v.value),
    text: buildAdminMailText(v.value, { email: buyerEmail, authUserId: auth.authUserId }),
  });

  if (!adminResult.ok) {
    // 管理者へ届いていない = 受理できていない。受付済みにはしない。内部詳細は返さない。
    return jsonError(
      "SEND_FAILED",
      "送信に失敗しました。時間をおいて再度お試しください。",
      502,
    );
  }

  // 2) 利用者への受付完了メール。管理者通知は成功済みなので、こちらが失敗しても
  //    「受理」は取り消さない（受付は成立している）。ただし ack 未達を控えめに伝える。
  const ackResult = await sender({
    apiKey,
    from: SUPPORT_MAIL_FROM,
    to: buyerEmail,
    subject: buildAckMailSubject(v.value),
    text: buildAckMailText(v.value),
  });

  // 受理は成立。ack の成否のみ boolean で返す（内部エラー詳細は出さない）。
  return jsonOk({ accepted: true, acknowledgementSent: ackResult.ok });
}
