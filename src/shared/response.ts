/**
 * 共通JSONレスポンス骨格
 *
 * プラットフォーム全APIで共通のレスポンス形式を定義する。
 * result フィールドで成功("OK")・失敗("NG")を統一する。
 *
 * 設計根拠: api/API.md 4「共通レスポンス」
 *   成功       : { "result": "OK", "data": {} }
 *   業務エラー : { "result": "NG", "error": { "code", "message" } }
 *   入力エラー : { "result": "NG", "error": { "code", "message", "fields": {} } }
 */

/** 成功レスポンスの型 */
export interface SuccessBody<T> {
  result: "OK";
  data: T;
}

/** 失敗レスポンスの型 */
export interface ErrorBody {
  result: "NG";
  error: {
    /** 業務エラーコード（利用者向けではなく分岐・ログ用） */
    code: string;
    /** 利用者向けの短いメッセージ（内部詳細は含めない） */
    message: string;
    /** 入力エラー時のフィールド別メッセージ（任意。API.md 4「入力エラー」） */
    fields?: Record<string, string>;
  };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/**
 * 成功レスポンスを生成する。
 * @param data レスポンスに含めるデータ
 * @param status HTTPステータス（既定200）
 */
export function jsonOk<T>(data: T, status = 200): Response {
  const body: SuccessBody<T> = { result: "OK", data };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * 失敗レスポンスを生成する。
 *
 * 利用者へは内部詳細を返さない（api/API.md 4 末尾, SECURITY.md 10）。
 * message は短い業務メッセージに限定する。
 *
 * @param code 業務エラーコード
 * @param message 利用者向けメッセージ
 * @param status HTTPステータス（既定400）
 * @param fields 入力エラー時のフィールド別メッセージ（任意）
 */
export function jsonError(
  code: string,
  message: string,
  status = 400,
  fields?: Record<string, string>,
): Response {
  const error: ErrorBody["error"] = { code, message };
  if (fields) {
    error.fields = fields;
  }
  const body: ErrorBody = { result: "NG", error };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
