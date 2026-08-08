/**
 * note 管理ルート
 *   POST /api/admin/note/import          CSV取込（multipart/form-data）
 *   GET  /api/admin/note/purchases       note購入一覧
 *   PUT  /api/admin/note/purchases/{id}  手動修正（状態変更）
 *
 * すべて requireAdmin。
 *
 * 設計根拠: api/ADMIN_API.md 10/11/12, api/NOTE_MIGRATION_API.md 7, WORK-008 確定事項 8/16
 *
 * WORK-008 初期スコープ:
 * - 手動修正は MATCH_STATUS の状態変更（要確認化=2 / 無効化=9 / 未移行へ戻す=0）に限定する。
 *   正本 §12「初期は複雑な自動巻戻しを作らず、対象データを明示した管理APIを用意する」に従い、
 *   T_PURCHASE / T_USER_PRODUCT を伴う紐付け解除の自動巻戻しは行わない
 *   （必要時は既存のユーザー商品権限APIで別途対応）。
 */

import { requireAdmin } from "../shared/admin";
import { AuthError } from "../shared/auth";
import { AppError, ValidationError } from "../shared/errors";
import { jsonOk, jsonError } from "../shared/response";
import { validateJson, type Schema } from "../shared/validate";
import { getDb } from "../shared/db";
import { importNoteCsv } from "../shared/note_import";
import {
  adminLinkNotePurchase,
  adminUnlinkNotePurchase,
  getUnlinkImpact,
  adminSetNoteMatchStatus,
} from "../shared/note_migration";
import type { Env } from "../index";

function toErrorResponse(err: unknown): Response {
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

/** POST /api/admin/note/import（multipart/form-data、CSV ファイル） */
export async function handleNoteImport(request: Request, env: Env): Promise<Response> {
  try {
    await requireAdmin(request, env);

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return jsonError("VALIDATION_ERROR", "multipart/form-data で送信してください。", 400, {
        _root: "Content-Type が不正です。",
      });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return jsonError("VALIDATION_ERROR", "CSV ファイルを指定してください。", 400, {
        file: "ファイルが必要です。",
      });
    }

    // File/Blob からテキスト取得（UTF-8。BOM は importNoteCsv で除去）
    const csvText = await (file as File).text();

    const result = await importNoteCsv(env, csvText);
    return jsonOk(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** MATCH_STATUS 許可値 */
const MATCH_STATUS_VALUES = [0, 1, 2, 9];
/** productCode 形式 */
const PRODUCT_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 整数クエリ（未指定は default、不正は 400） */
function reqInt(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new ValidationError({ [key]: "整数で指定してください。" });
  const n = Number.parseInt(raw, 10);
  if (n < min || n > max) throw new ValidationError({ [key]: `${min}〜${max} の範囲で指定してください。` });
  return n;
}
/** 任意 enum 整数（未指定は null、不正は 400） */
function optIntEnum(url: URL, key: string, allowed: number[]): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (!/^-?\d+$/.test(raw)) throw new ValidationError({ [key]: "整数で指定してください。" });
  const n = Number.parseInt(raw, 10);
  if (!allowed.includes(n)) throw new ValidationError({ [key]: "許可されていない値です。" });
  return n;
}
/** 任意文字列（最大長、未指定は null） */
function optStr(url: URL, key: string, maxLen: number): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (raw.length > maxLen) throw new ValidationError({ [key]: `${maxLen}文字以内で指定してください。` });
  return raw;
}
/** 任意 productCode（未指定は null、不正形式は 400） */
function optProductCode(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  if (!PRODUCT_CODE_RE.test(raw)) throw new ValidationError({ [key]: "商品コードの形式が正しくありません。" });
  return raw;
}

/** GET /api/admin/note/purchases */
export async function handleNoteList(request: Request, env: Env): Promise<Response> {
  try {
    await requireAdmin(request, env);
    const url = new URL(request.url);

    const noteId = optStr(url, "noteId", 128);
    const transactionId = optStr(url, "transactionId", 128);
    const productCode = optProductCode(url, "productCode");
    const matchStatus = optIntEnum(url, "matchStatus", MATCH_STATUS_VALUES);
    const limit = reqInt(url, "limit", 100, 1, 200);
    const offset = reqInt(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);

    const db = getDb(env);
    const where: string[] = ["n.DEL_FLG = 0"];
    const binds: Array<string | number> = [];
    if (noteId) {
      where.push("n.NOTE_ID LIKE ?");
      binds.push("%" + noteId + "%");
    }
    if (transactionId) {
      where.push("n.NOTE_TRANSACTION_ID = ?");
      binds.push(transactionId);
    }
    if (productCode) {
      where.push("p.PRODUCT_CODE = ?");
      binds.push(productCode);
    }
    if (matchStatus !== null) {
      where.push("n.MATCH_STATUS = ?");
      binds.push(matchStatus);
    }

    const sql =
      `SELECT n.NOTE_PURCHASE_ID AS notePurchaseId, p.PRODUCT_CODE AS productCode,
              n.NOTE_ID AS noteId, n.NOTE_TRANSACTION_ID AS transactionId,
              n.PURCHASE_DATE AS purchaseDate, n.PURCHASE_AMOUNT AS amount,
              n.MATCH_STATUS AS matchStatus, n.MATCH_AUTH_USER_ID AS matchAuthUserId,
              n.MATCH_DATE AS matchDate, n.PURCHASE_ID AS purchaseId
       FROM T_NOTE_PURCHASE n JOIN M_PRODUCT p ON p.PRODUCT_ID = n.PRODUCT_ID
       WHERE ${where.join(" AND ")}
       ORDER BY n.PURCHASE_DATE DESC, n.NOTE_PURCHASE_ID DESC
       LIMIT ? OFFSET ?`;
    binds.push(limit, offset);

    const rows = await db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
    return jsonOk({ purchases: rows.results ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/admin/note/purchases/{id} の入力
 * action で用途を分岐（api/ADMIN_API.md 12）:
 * - link       手動紐付け（authUserId 必須）
 * - unlink     紐付け解除（confirm=true で実行、false は影響のみ返す）
 * - flag       要確認化（MATCH_STATUS=2）
 * - invalidate 無効化（MATCH_STATUS=9）
 * - reset      未移行へ戻す（MATCH_STATUS=0、未移行系のみ）
 */
const NOTE_UPDATE_SCHEMA: Schema = {
  action: { type: "string", required: true, maxLength: 16 },
  authUserId: { type: "string", required: false, maxLength: 64 },
  confirm: { type: "boolean", required: false },
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * PUT /api/admin/note/purchases/{id}
 *
 * 手動補正（手動紐付け / 紐付け解除 / 要確認化 / 無効化）。api/ADMIN_API.md 12。
 */
export async function handleNoteUpdate(
  request: Request,
  env: Env,
  idRaw: string,
): Promise<Response> {
  try {
    await requireAdmin(request, env);
    if (!/^\d+$/.test(idRaw)) {
      return jsonError("NOTE_PURCHASE_NOT_FOUND", "対象が見つかりません。", 404);
    }
    const id = Number.parseInt(idRaw, 10);
    const data = await validateJson(request, NOTE_UPDATE_SCHEMA);
    const action = data.action as string;

    switch (action) {
      case "link": {
        const authUserId = (data.authUserId as string | undefined)?.trim();
        if (!authUserId || !UUID_RE.test(authUserId)) {
          return jsonError("VALIDATION_ERROR", "紐付け先ユーザーを指定してください。", 400, {
            authUserId: "UUID 形式で指定してください。",
          });
        }
        await adminLinkNotePurchase(env, id, authUserId);
        return jsonOk({ linked: true });
      }
      case "unlink": {
        const confirm = data.confirm === true;
        if (!confirm) {
          // 影響を返す（確認用）。実際の解除は行わない。
          const impact = await getUnlinkImpact(env, id);
          if (!impact) {
            return jsonError("NOTE_PURCHASE_NOT_FOUND", "対象が見つかりません。", 404);
          }
          return jsonOk({ requiresConfirm: true, impact });
        }
        await adminUnlinkNotePurchase(env, id, true);
        return jsonOk({ unlinked: true });
      }
      case "flag": {
        await adminSetNoteMatchStatus(env, id, 2);
        return jsonOk({ updated: true });
      }
      case "invalidate": {
        await adminSetNoteMatchStatus(env, id, 9);
        return jsonOk({ updated: true });
      }
      case "reset": {
        await adminSetNoteMatchStatus(env, id, 0);
        return jsonOk({ updated: true });
      }
      default:
        return jsonError("VALIDATION_ERROR", "action が不正です。", 400, {
          action: "link / unlink / flag / invalidate / reset のいずれかを指定してください。",
        });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
