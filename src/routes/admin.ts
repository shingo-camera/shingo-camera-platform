/**
 * 管理 API ルートハンドラ
 *
 * すべて requireAdmin を通す（一般ユーザーは 403、未認証は 401）。
 * 商品管理は閲覧のみ（編集 API は今回作らない）。note 取込・紐付けは実装しない。
 *
 * 設計根拠: api/ADMIN_API.md 3/4/5/6/7/8/9, screen/ADMIN.md
 *
 * Query parameter は「未指定なら default、指定されたが不正なら 400 VALIDATION_ERROR」。
 * 黙って補正・丸めをしない（確定仕様「入力を必ず検証」）。
 */

import { requireAdmin } from "../shared/admin";
import { AuthError } from "../shared/auth";
import { AppError, ValidationError } from "../shared/errors";
import { jsonOk, jsonError } from "../shared/response";
import { validateJson, type Schema } from "../shared/validate";
import { getDb } from "../shared/db";
import { getDashboard, searchUsers, searchWarnings } from "../shared/admin_queries";
import { getUserDetail } from "../shared/admin_detail";
import {
  updateUserStatus,
  upsertUserProduct,
  updateWarning,
  ALLOWED_USER_STATUS,
} from "../shared/admin_update";
import type { Env } from "../index";

/** UUID 形式 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 商品コード形式（英数字・アンダースコア・ハイフン、1〜64） */
const PRODUCT_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** email 検索文字列の最大長 */
const EMAIL_MAX = 254;
/** warningType の最大長 */
const WARNING_TYPE_MAX = 64;
/** M_USER.STATUS 許可値 */
const USER_STATUS_VALUES = [0, 1, 2, 9];
/** T_WARNING.STATUS 許可値 */
const WARNING_STATUS_VALUES = [0, 1, 2, 9];

/** クエリ検証エラー（フィールド付き 400） */
class QueryError extends Error {
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super("VALIDATION_ERROR");
    this.fields = fields;
  }
}

/** AuthError / AppError / ValidationError / QueryError を共通レスポンスへ変換 */
function toErrorResponse(err: unknown): Response {
  if (err instanceof QueryError) {
    return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, err.fields);
  }
  if (err instanceof ValidationError) {
    return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, err.fields);
  }
  if (err instanceof AuthError) {
    return jsonError(err.code, err.message, err.status);
  }
  if (err instanceof AppError) {
    return jsonError(err.code, err.message, err.status);
  }
  throw err;
}

/**
 * 整数パラメータ: 未指定は fallback、指定ありは整数・範囲を検証。
 * 不正なら QueryError を throw（黙って補正しない）。
 */
function reqInt(
  url: URL,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback; // 未指定
  if (!/^-?\d+$/.test(raw)) {
    throw new QueryError({ [key]: "整数で指定してください。" });
  }
  const n = Number.parseInt(raw, 10);
  if (n < min || n > max) {
    throw new QueryError({ [key]: `${min}〜${max} の範囲で指定してください。` });
  }
  return n;
}

/** 整数 or null（任意フィルタ）: 未指定は null、指定ありは整数・enum を検証。 */
function optIntEnum(url: URL, key: string, allowed: number[]): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (!/^-?\d+$/.test(raw)) {
    throw new QueryError({ [key]: "整数で指定してください。" });
  }
  const n = Number.parseInt(raw, 10);
  if (!allowed.includes(n)) {
    throw new QueryError({ [key]: "許可されていない値です。" });
  }
  return n;
}

/** 任意文字列（最大長）。未指定は null。 */
function optStr(url: URL, key: string, maxLen: number): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (raw.length > maxLen) {
    throw new QueryError({ [key]: `${maxLen}文字以内で指定してください。` });
  }
  return raw;
}

/** 任意 UUID。未指定は null、指定ありは形式検証。 */
function optUuid(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (!UUID_RE.test(raw)) {
    throw new QueryError({ [key]: "IDの形式が正しくありません。" });
  }
  return raw;
}

/** 任意 productCode。未指定は null、指定ありは形式検証。 */
function optProductCode(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (!PRODUCT_CODE_RE.test(raw)) {
    throw new QueryError({ [key]: "商品コードの形式が正しくありません。" });
  }
  return raw;
}

/** 任意 ISO 日時。未指定は null、指定ありは Date parse 検証。 */
function optIso(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (raw.length > 40 || Number.isNaN(new Date(raw).getTime())) {
    throw new QueryError({ [key]: "日時の形式が正しくありません。" });
  }
  return raw;
}

/** GET /api/admin/dashboard */
export async function handleAdminDashboard(request: Request, env: Env): Promise<Response> {
  try {
    await requireAdmin(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
  const data = await getDashboard(env);
  return jsonOk(data);
}

/** GET /api/admin/users */
export async function handleAdminUsers(request: Request, env: Env): Promise<Response> {
  try {
    await requireAdmin(request, env);
    const url = new URL(request.url);
    const users = await searchUsers(env, {
      email: optStr(url, "email", EMAIL_MAX),
      status: optIntEnum(url, "status", USER_STATUS_VALUES),
      productCode: optProductCode(url, "productCode"),
      limit: reqInt(url, "limit", 100, 1, 200),
      offset: reqInt(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    });
    return jsonOk({ users });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** GET /api/admin/users/{authUserId} */
export async function handleAdminUserDetail(
  request: Request,
  env: Env,
  authUserId: string,
): Promise<Response> {
  try {
    await requireAdmin(request, env);
    const url = new URL(request.url);
    const logLimit = reqInt(url, "logLimit", 50, 1, 200);
    const logOffset = reqInt(url, "logOffset", 0, 0, Number.MAX_SAFE_INTEGER);
    const detail = await getUserDetail(env, authUserId, logLimit, logOffset);
    if (!detail.user) {
      return jsonError("USER_NOT_FOUND", "アカウントが見つかりません。", 404);
    }
    return jsonOk(detail);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PUT /api/admin/users/{authUserId}/status */
const STATUS_SCHEMA: Schema = {
  status: { type: "integer", required: true, enum: [...ALLOWED_USER_STATUS] },
};
export async function handleAdminUserStatus(
  request: Request,
  env: Env,
  authUserId: string,
): Promise<Response> {
  try {
    await requireAdmin(request, env);
    const data = await validateJson(request, STATUS_SCHEMA);
    await updateUserStatus(env, authUserId, data.status as number);
    return jsonOk({ updated: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PUT /api/admin/users/{authUserId}/products/{productCode} */
const PRODUCT_GRANT_SCHEMA: Schema = {
  status: { type: "integer", required: true, enum: [0, 1, 2, 9] },
  grantType: { type: "integer", required: false, enum: [0, 1, 2, 3, 4] },
  startAt: { type: "string", required: false, maxLength: 40 },
  endAt: { type: "string", required: false, maxLength: 40 },
  memo: { type: "string", required: false, maxLength: 500 },
};
export async function handleAdminUserProduct(
  request: Request,
  env: Env,
  authUserId: string,
  productCode: string,
): Promise<Response> {
  try {
    await requireAdmin(request, env);

    // productCode の形式検証（不正はそもそも商品解決しない）
    if (!PRODUCT_CODE_RE.test(productCode)) {
      return jsonError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
    }

    const data = await validateJson(request, PRODUCT_GRANT_SCHEMA);

    // PRODUCT_CODE → PRODUCT_ID 解決。
    // 注意: 正本 ADMIN_API.md 7 は付与時の M_PRODUCT.STATUS/DEL_FLG の扱いを明記していない。
    // 勝手に「有効商品のみ」に絞ると仕様追加になるため、ここでは PRODUCT_CODE で解決し、
    // 商品が存在しなければ PRODUCT_NOT_FOUND とする（STATUS/DEL_FLG での追加制限はしない）。
    const db = getDb(env);
    const product = await db
      .prepare("SELECT PRODUCT_ID FROM M_PRODUCT WHERE PRODUCT_CODE = ?")
      .bind(productCode)
      .first<{ PRODUCT_ID: number }>();
    if (!product) {
      return jsonError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
    }

    // 日時・必須・存在確認は upsertUserProduct 内で新規/既存を分けて検証する
    await upsertUserProduct(env, authUserId, product.PRODUCT_ID, {
      status: data.status as number,
      grantType: (data.grantType as number | undefined) ?? null,
      startAt: (data.startAt as string | undefined) ?? null,
      endAt: (data.endAt as string | undefined) ?? null,
      memo: (data.memo as string | undefined) ?? null,
    });
    return jsonOk({ updated: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** GET /api/admin/warnings */
export async function handleAdminWarnings(request: Request, env: Env): Promise<Response> {
  try {
    await requireAdmin(request, env);
    const url = new URL(request.url);
    const from = optIso(url, "from");
    const to = optIso(url, "to");
    if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
      throw new QueryError({ to: "to は from 以降にしてください。" });
    }
    const warnings = await searchWarnings(env, {
      status: optIntEnum(url, "status", WARNING_STATUS_VALUES),
      warningType: optStr(url, "warningType", WARNING_TYPE_MAX),
      authUserId: optUuid(url, "authUserId"),
      from,
      to,
      limit: reqInt(url, "limit", 100, 1, 200),
      offset: reqInt(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    });
    return jsonOk({ warnings });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PUT /api/admin/warnings/{warningId} */
const WARNING_SCHEMA: Schema = {
  status: { type: "integer", required: true, enum: [0, 1, 2, 9] },
  memo: { type: "string", required: false, maxLength: 500 },
};
export async function handleAdminWarningUpdate(
  request: Request,
  env: Env,
  warningIdRaw: string,
): Promise<Response> {
  try {
    await requireAdmin(request, env);
    if (!/^\d+$/.test(warningIdRaw)) {
      return jsonError("WARNING_NOT_FOUND", "対象が見つかりません。", 404);
    }
    const warningId = Number.parseInt(warningIdRaw, 10);
    const data = await validateJson(request, WARNING_SCHEMA);
    await updateWarning(env, warningId, {
      status: data.status as number,
      memo: (data.memo as string | undefined) ?? null,
    });
    return jsonOk({ updated: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * テスト用エクスポート（本番コードからは使用しない）。
 * Query 検証ロジックを実コードのまま単体検証するために公開する。
 */
export const __testonly = {
  reqInt,
  optIntEnum,
  optStr,
  optUuid,
  optProductCode,
  optIso,
  QueryError,
  USER_STATUS_VALUES,
  WARNING_STATUS_VALUES,
  EMAIL_MAX,
  WARNING_TYPE_MAX,
};
