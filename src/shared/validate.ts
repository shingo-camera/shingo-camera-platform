/**
 * 入力検証共通関数
 *
 * 追加ライブラリを使わず、今回必要な最小の共通入力検証を提供する。
 * Content-Type / JSON 構文 / root object / 必須 / 型 / 文字数 / UUID /
 * コード値 / 想定外項目 を検証し、VALIDATION_ERROR 形式へ統一する。
 *
 * 設計根拠:
 * - api/API.md 7「入力検証」（Content-Type・JSON構文・必須・型・文字数・
 *   コード値・UUID・日時・想定外項目はエラーまたは明示除外）
 * - api/API.md 4「入力エラーは VALIDATION_ERROR + fields」
 * - REVIEW_RULE.md 6「入力値を検証」
 *
 * 方針:
 * - Zod 等は追加しない（依存最小）。
 * - 現時点で実 API から使われない過剰な汎用基盤は作らない。必要十分のみ。
 * - 想定外項目は黙って受け入れず、既定でエラーにする。
 */

import { ValidationError } from "./errors";

/** UUID 形式（一般形。v4 に限定しない） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 1フィールドの検証ルール */
export interface FieldRule {
  /** 期待する型 */
  type: "string" | "number" | "integer" | "boolean";
  /** 必須か（既定 true） */
  required?: boolean;
  /** 文字列の最大長（type=string のとき） */
  maxLength?: number;
  /** 文字列の最小長（type=string のとき） */
  minLength?: number;
  /** UUID 形式であること（type=string のとき） */
  uuid?: boolean;
  /** 許可するコード値の集合（string/number どちらも可） */
  enum?: ReadonlyArray<string | number>;
}

/** スキーマ: フィールド名 -> ルール */
export type Schema = Record<string, FieldRule>;

/** 検証済みデータ（呼出側で型注釈して使う） */
export type ValidatedData = Record<string, unknown>;

/** フィールド別エラーメッセージ */
type FieldErrors = Record<string, string>;

/**
 * リクエストボディを検証して、検証済みオブジェクトを返す。
 *
 * @param request 受信リクエスト
 * @param schema 検証スキーマ
 * @returns 検証済みデータ
 * @throws ValidationError 検証失敗時（呼出側で 400 + VALIDATION_ERROR へ変換）
 */
export async function validateJson(request: Request, schema: Schema): Promise<ValidatedData> {
  // 1. Content-Type 確認（application/json）
  const contentType = request.headers.get("content-type") ?? "";
  if (!/application\/json/i.test(contentType)) {
    throw new ValidationError({ _root: "Content-Type は application/json を指定してください。" });
  }

  // 2. JSON 構文確認
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError({ _root: "リクエストの形式が正しくありません。" });
  }

  // 3. root が object であること（配列・null・プリミティブを弾く）
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError({ _root: "リクエストの形式が正しくありません。" });
  }

  const input = body as Record<string, unknown>;
  const errors: FieldErrors = {};
  const result: ValidatedData = {};

  // 4. 想定外項目の検出（スキーマにないキー）
  for (const key of Object.keys(input)) {
    if (!(key in schema)) {
      errors[key] = "指定できない項目です。";
    }
  }

  // 5. 各フィールドの検証
  for (const [name, rule] of Object.entries(schema)) {
    const required = rule.required !== false;
    const has = Object.prototype.hasOwnProperty.call(input, name);
    const value = input[name];

    if (!has || value === undefined || value === null) {
      if (required) {
        errors[name] = "必須項目です。";
      }
      continue;
    }

    // 型チェック
    if (rule.type === "string") {
      if (typeof value !== "string") {
        errors[name] = "文字列で指定してください。";
        continue;
      }
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        errors[name] = `${rule.minLength}文字以上で入力してください。`;
        continue;
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        errors[name] = `${rule.maxLength}文字以内で入力してください。`;
        continue;
      }
      if (rule.uuid && !UUID_RE.test(value)) {
        errors[name] = "形式が正しくありません。";
        continue;
      }
      if (rule.enum && !rule.enum.includes(value)) {
        errors[name] = "指定できない値です。";
        continue;
      }
    } else if (rule.type === "number" || rule.type === "integer") {
      if (typeof value !== "number" || Number.isNaN(value)) {
        errors[name] = "数値で指定してください。";
        continue;
      }
      if (rule.type === "integer" && !Number.isInteger(value)) {
        errors[name] = "整数で指定してください。";
        continue;
      }
      if (rule.enum && !rule.enum.includes(value)) {
        errors[name] = "指定できない値です。";
        continue;
      }
    } else if (rule.type === "boolean") {
      if (typeof value !== "boolean") {
        errors[name] = "真偽値で指定してください。";
        continue;
      }
    }

    result[name] = value;
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }

  return result;
}
