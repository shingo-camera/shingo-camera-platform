/**
 * note 移行 公開ルート
 *   POST /api/migrations/note/apply   移行申請（認証必須）
 *   GET  /api/migrations/note/status  自分の移行済み商品（認証必須）
 *
 * 設計根拠: api/NOTE_MIGRATION_API.md 3/4/5, WORK-008 確定事項 12
 *
 * 利用者へはエラー理由を区別しない（正本共通文言）。購入者名は入力させない。
 */

import { requireUser, AuthError } from "../shared/auth";
import { AppError, ValidationError } from "../shared/errors";
import { jsonOk, jsonError } from "../shared/response";
import { validateJson, type Schema } from "../shared/validate";
import { applyNoteMigration, listNoteMigrations } from "../shared/note_migration";
import type { Env } from "../index";

/** 利用者向け共通エラー文言（理由を区別しない） */
const COMMON_FAIL_MESSAGE = "購入情報を確認できませんでした。入力内容をご確認ください。";

/** 移行対象として受け付ける商品（SUN_AND_MOON は対象外） */
const MIGRATABLE_CODES = ["HANABI", "HANABI_GOOGLE_EARTH"];

function toErrorResponse(err: unknown): Response {
  if (err instanceof ValidationError) {
    return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, err.fields);
  }
  if (err instanceof AuthError) {
    return jsonError(err.code, err.message, err.status);
  }
  if (err instanceof AppError) {
    // note 移行の失敗は理由を区別せず共通文言へ（USER_SUSPENDED は除く）
    if (err.code === "NOTE_MIGRATION_FAILED") {
      return jsonError("NOTE_MIGRATION_FAILED", COMMON_FAIL_MESSAGE, 400);
    }
    return jsonError(err.code, err.message, err.status);
  }
  throw err;
}

/** POST /api/migrations/note/apply の入力 */
const APPLY_SCHEMA: Schema = {
  productCode: { type: "string", required: true, maxLength: 64 },
  transactionId: { type: "string", required: true, maxLength: 128 },
};

/** POST /api/migrations/note/apply */
export async function handleNoteApply(request: Request, env: Env): Promise<Response> {
  try {
    const auth = await requireUser(request, env);
    const data = await validateJson(request, APPLY_SCHEMA);
    const productCode = data.productCode as string;
    const transactionId = (data.transactionId as string).trim();

    // 移行対象商品のみ受け付ける（対象外は理由を区別せず共通文言）
    if (!MIGRATABLE_CODES.includes(productCode)) {
      return jsonError("NOTE_MIGRATION_FAILED", COMMON_FAIL_MESSAGE, 400);
    }

    await applyNoteMigration(env, auth.authUserId, productCode, transactionId);
    return jsonOk({ migrated: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** GET /api/migrations/note/status */
export async function handleNoteStatus(request: Request, env: Env): Promise<Response> {
  try {
    const auth = await requireUser(request, env);
    const migrations = await listNoteMigrations(env, auth.authUserId);
    return jsonOk({ migrations });
  } catch (err) {
    return toErrorResponse(err);
  }
}
