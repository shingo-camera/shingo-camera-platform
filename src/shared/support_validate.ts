/**
 * SUPPORT 問い合わせフォームの入力検証（純関数）。
 *
 * DOM・env・DB に依存しない再実行可能ロジックとして切り出し、node --test で検証する。
 * ルート側（support.ts）はこの関数の結果に従ってメール送信可否を決める。
 *
 * 方針:
 * - 問い合わせ者のメールアドレスはフォームから受け取らない。認証済みユーザーの登録メールを
 *   サーバー側（support.ts）が確定する。本モジュールは email を検証対象にしない。
 * - 種別は allowlist（サーバー側で固定）。クライアント値をそのまま信用しない。
 * - 本文長・空本文を検証。
 * - ヘッダインジェクション対策として、件名・対象商品に改行/制御文字を許さない。
 * - honeypot（bot 用の隠しフィールド）に値があれば拒否。
 */

export const SUPPORT_CATEGORIES = [
  "purchase", // 購入・利用権
  "bug", // 不具合
  "disclosure", // 販売事業者情報の開示請求
  "account", // アカウント・セキュリティ
  "other", // その他
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
  purchase: "購入・利用権",
  bug: "不具合",
  disclosure: "販売事業者情報の開示請求",
  account: "アカウント・セキュリティ",
  other: "その他",
};

export const SUPPORT_LIMITS = {
  subjectMax: 120,
  productMax: 80,
  bodyMin: 1,
  bodyMax: 4000,
} as const;

export interface SupportInput {
  category?: unknown;
  product?: unknown;
  subject?: unknown;
  body?: unknown;
  // honeypot（正規利用者は空。bot が埋めることを期待する隠しフィールド）
  website?: unknown;
}

export interface SupportValidatedValue {
  category: SupportCategory;
  categoryLabel: string;
  product: string; // 空文字可
  subject: string; // 空文字可
  body: string;
}

export interface SupportValidationOk {
  ok: true;
  value: SupportValidatedValue;
}

export interface SupportValidationErr {
  ok: false;
  code: string; // 呼出側で一般化メッセージへ変換
  field?: string;
}

export type SupportValidationResult = SupportValidationOk | SupportValidationErr;

// 制御文字（改行・タブ以外の C0、および CR/LF）を含むか。ヘッダインジェクション対策。
function hasControlChars(s: string): boolean {
  return /[\r\n\u0000-\u001f\u007f]/.test(s);
}

/**
 * フォーム入力の検証。email はここでは扱わない（認証から確定するため）。
 */
export function validateSupportInput(input: SupportInput): SupportValidationResult {
  // honeypot: 値があれば bot とみなして拒否（正規フォームでは常に空）
  if (typeof input.website === "string" && input.website.trim() !== "") {
    return { ok: false, code: "SPAM_DETECTED" };
  }

  // category（必須・allowlist）
  if (typeof input.category !== "string" || input.category.trim() === "") {
    return { ok: false, code: "CATEGORY_REQUIRED", field: "category" };
  }
  const category = input.category.trim() as SupportCategory;
  if (!SUPPORT_CATEGORIES.includes(category)) {
    return { ok: false, code: "CATEGORY_INVALID", field: "category" };
  }

  // product（任意）
  let product = "";
  if (input.product != null) {
    if (typeof input.product !== "string") {
      return { ok: false, code: "PRODUCT_INVALID", field: "product" };
    }
    product = input.product.trim();
    if (product.length > SUPPORT_LIMITS.productMax || hasControlChars(product)) {
      return { ok: false, code: "PRODUCT_INVALID", field: "product" };
    }
  }

  // subject（任意）
  let subject = "";
  if (input.subject != null) {
    if (typeof input.subject !== "string") {
      return { ok: false, code: "SUBJECT_INVALID", field: "subject" };
    }
    subject = input.subject.trim();
    if (subject.length > SUPPORT_LIMITS.subjectMax || hasControlChars(subject)) {
      return { ok: false, code: "SUBJECT_INVALID", field: "subject" };
    }
  }

  // body（必須・長さ制限。本文は改行を許すので hasControlChars は使わない）
  if (typeof input.body !== "string") {
    return { ok: false, code: "BODY_REQUIRED", field: "body" };
  }
  const body = input.body.trim();
  if (body.length < SUPPORT_LIMITS.bodyMin) {
    return { ok: false, code: "BODY_REQUIRED", field: "body" };
  }
  if (body.length > SUPPORT_LIMITS.bodyMax) {
    return { ok: false, code: "BODY_TOO_LONG", field: "body" };
  }

  return {
    ok: true,
    value: {
      category,
      categoryLabel: SUPPORT_CATEGORY_LABELS[category],
      product,
      subject,
      body,
    },
  };
}

/**
 * 管理者へ送る通知メール本文（純関数）。
 * 問い合わせ者の登録メール・内部識別子（authUserId）は管理者向けにのみ含める。
 * これらは利用者向け画面／利用者宛メールには出さない。
 */
export function buildAdminMailText(
  v: SupportValidatedValue,
  meta: { email: string; authUserId: string },
): string {
  const lines = [
    "SUPPORT 問い合わせを受信しました。",
    "",
    `種別: ${v.categoryLabel}`,
    `問い合わせ者メール: ${meta.email}`,
    `AUTH_USER_ID: ${meta.authUserId}`,
    `対象商品: ${v.product || "(未記入)"}`,
    `件名: ${v.subject || "(未記入)"}`,
    "",
    "--- 問い合わせ内容 ---",
    v.body,
  ];
  return lines.join("\n");
}

export function buildAdminMailSubject(v: SupportValidatedValue): string {
  return `【SUPPORT】${v.categoryLabel}`;
}

/**
 * 問い合わせ者への受付完了メール本文（純関数）。
 * 内部識別子（authUserId 等）は含めない。返信期限・対応期限は約束しない。
 */
export function buildAckMailText(v: SupportValidatedValue): string {
  const lines = [
    "shingo_camera LABO へのお問い合わせを受け付けました。",
    "",
    "以下の内容で受け付けています。内容を確認のうえ、順次対応いたします。",
    "",
    `種別: ${v.categoryLabel}`,
  ];
  if (v.product) lines.push(`対象商品: ${v.product}`);
  if (v.subject) lines.push(`件名: ${v.subject}`);
  lines.push("", "--- お問い合わせ内容 ---", v.body, "");
  lines.push(
    "※ このメールは送信専用です。",
    "※ パスワード、クレジットカード番号、セキュリティコード等の機密情報は送信しないでください。",
  );
  return lines.join("\n");
}

export function buildAckMailSubject(v: SupportValidatedValue): string {
  return `【shingo_camera LABO】お問い合わせを受け付けました（${v.categoryLabel}）`;
}
