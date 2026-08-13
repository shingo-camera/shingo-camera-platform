/**
 * 共通エラーハンドラ骨格
 *
 * ルート処理で送出された例外を捕捉し、利用者へは内部詳細を返さず
 * 短い業務メッセージのみを返す。内部詳細は Cloudflare ログへ出力する。
 *
 * 設計根拠:
 * - SECURITY.md 10「外部サービスやDBの詳細を利用者へ返さない。内部詳細はログへ記録」
 * - SECURITY.md 7「パスワード・完全なJWT・秘密キー等はログに保存しない」
 */

import { jsonError } from "./response";

/**
 * 業務エラー。
 * ルート処理内で「利用者へ返してよい」エラーを表現するために用いる。
 * これ以外の未捕捉例外は内部エラー扱いとし、詳細を利用者へ返さない。
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

/**
 * 入力検証エラー。
 * フィールド別のエラーメッセージを持ち、VALIDATION_ERROR(400) として返す。
 * ルート全体に関わるエラーは fields に "_root" キーで表現する。
 *
 * 設計根拠: api/API.md 4「入力エラーは VALIDATION_ERROR + fields」
 */
export class ValidationError extends Error {
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super("VALIDATION_ERROR");
    this.name = "ValidationError";
    this.fields = fields;
  }
}

/**
 * 商品依存の未充足エラー（DEPENDENCY_REQUIRED(409)）。
 *
 * AppError を継承しつつ、フロントが「何を買うには何が必要か」を表示できるよう
 * 機械可読な details（購入対象コード＋不足している前提グループ）を持つ。
 * 商品コードは公開情報（/api/products で開示済み）なので details に載せてよい。
 *
 * details 構造（ANY_OF / ALL_OF / SATISFY_MODE 対応）:
 *   { productCode: string, missingGroups: { requiresAnyOf: string[], satisfyMode: "ENTITLEMENT_ONLY" | "ENTITLEMENT_OR_CART" }[] }
 * - missingGroups は「すべて充足が必要」（グループ間 ALL_OF）。未充足のグループのみを含む。
 * - 各 group.requiresAnyOf は「いずれか1つ所有/同時購入で充足」（グループ内 ANY_OF）。
 * - 各 group.satisfyMode は充足方式（グループ単位で異なりうる）。
 *   ENTITLEMENT_ONLY=事前購入必須（同時カート不可） / ENTITLEMENT_OR_CART=既所有または同時選択で充足。
 * - フロントは商品コードを PRODUCT_NAME へ変換して表示する（コードはユーザー向けに出さない）。
 */
export interface DependencyMissingGroup {
  /** このグループを充足しうる前提商品コード群（いずれか1つで充足＝ANY_OF） */
  requiresAnyOf: string[];
  /**
   * このグループの充足方式。
   * - "ENTITLEMENT_ONLY": 事前購入（既所有）が必要。同時カートでは充足できない。
   * - "ENTITLEMENT_OR_CART": 既所有または同時選択（同時購入）で充足できる。
   * フロントはこの値で「事前購入が必要」か「同時選択でもよい」かを文言に反映する。
   */
  satisfyMode: "ENTITLEMENT_ONLY" | "ENTITLEMENT_OR_CART";
}
export interface DependencyRequiredDetails {
  /** 依存を満たせなかった購入対象の商品コード */
  productCode: string;
  /** 未充足グループ（すべて充足が必要＝ALL_OF） */
  missingGroups: DependencyMissingGroup[];
}
export class DependencyRequiredError extends AppError {
  readonly details: DependencyRequiredDetails;

  constructor(details: DependencyRequiredDetails, message = "この商品は、前提となる商品の購入が必要です。") {
    super("DEPENDENCY_REQUIRED", message, 409);
    this.name = "DependencyRequiredError";
    this.details = details;
  }
}

/**
 * ルートハンドラを共通エラーハンドリングで包む。
 *
 * - ValidationError: VALIDATION_ERROR(400) + fields
 * - AppError / AuthError 等 code+status を持つ既知エラー: その code/message/status
 * - それ以外: 内部詳細を隠し、利用者へは汎用メッセージのみ返す（500）
 *
 * AuthError は auth.ts 定義だが、循環 import を避けるため型名では判定せず、
 * code(string) と status(number) を持つオブジェクトかで判定する（ダックタイピング）。
 *
 * @param handler 元のルートハンドラ
 * @returns 例外を捕捉するラップ済みハンドラ
 */
export function withErrorHandling(
  handler: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof ValidationError) {
        return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, err.fields);
      }
      if (err instanceof DependencyRequiredError) {
        return jsonError(err.code, err.message, err.status, undefined, err.details);
      }
      if (err instanceof AppError) {
        return jsonError(err.code, err.message, err.status);
      }
      // AuthError 等、code(string)+status(number) を持つ既知エラー
      if (isCodedError(err)) {
        return jsonError(err.code, err.message, err.status);
      }
      // 未捕捉例外: 内部詳細はログのみに残し、利用者へは汎用メッセージを返す
      console.error("[unhandled_error]", err instanceof Error ? err.stack ?? err.message : String(err));
      return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
    }
  };
}

/** code(string) + message(string) + status(number) を持つエラーか（AuthError 等） */
function isCodedError(err: unknown): err is { code: string; message: string; status: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { message?: unknown }).message === "string" &&
    typeof (err as { status?: unknown }).status === "number"
  );
}
