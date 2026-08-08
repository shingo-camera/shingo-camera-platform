/**
 * 管理: 更新系ロジック（ユーザー状態 / 商品権限）
 *
 * 設計根拠: api/ADMIN_API.md 6/7, database/DATABASE.md（コード値）
 *
 * 方針:
 * - 破壊的更新はすべて Prepared Statement + bind。
 * - 商品権限は「同一ユーザー・同一商品」を主キーとし、既存は UPDATE、
 *   新規のみ INSERT（DATABASE.md 4.3）。T_PURCHASE の偽造はしない。
 * - 管理者自身（env.ADMIN_AUTH_USER_ID）を停止(2)/退会(9)にはできない
 *   （管理不能を避ける安全策。正本未定義のため実装後に設計反映を提案する）。
 */

import { getDb } from "./db";
import { nowIso } from "./datetime";
import { AppError, ValidationError } from "./errors";
import type { Env } from "../index";

/** ユーザー状態更新の許可値 */
export const ALLOWED_USER_STATUS = [1, 2, 9] as const;

/**
 * M_USER.STATUS を更新する。
 *
 * @throws AppError USER_NOT_FOUND(404) / ADMIN_SELF_STATUS_CHANGE_NOT_ALLOWED(400)
 */
export async function updateUserStatus(
  env: Env,
  authUserId: string,
  status: number,
): Promise<void> {
  // 管理者自身を停止・退会にはできない（1=有効 への変更は許可）
  const adminId = env.ADMIN_AUTH_USER_ID;
  if (adminId && authUserId === adminId && (status === 2 || status === 9)) {
    throw new AppError(
      "ADMIN_SELF_STATUS_CHANGE_NOT_ALLOWED",
      "管理者自身を停止または退会状態に変更できません。",
      400,
    );
  }

  const db = getDb(env);
  const now = nowIso();

  const existing = await db
    .prepare("SELECT AUTH_USER_ID FROM M_USER WHERE AUTH_USER_ID = ?")
    .bind(authUserId)
    .first<{ AUTH_USER_ID: string }>();
  if (!existing) {
    throw new AppError("USER_NOT_FOUND", "アカウントが見つかりません。", 404);
  }

  await db
    .prepare("UPDATE M_USER SET STATUS = ?, UPDATE_DATE = ? WHERE AUTH_USER_ID = ?")
    .bind(status, now, authUserId)
    .run();
}

/** 商品権限更新の入力 */
export interface UpsertUserProductInput {
  status: number;
  grantType?: number | null;
  startAt?: string | null;
  endAt?: string | null;
  memo?: string | null;
}

/** ISO 文字列を時刻数値へ（不正は NaN） */
function toTime(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * T_USER_PRODUCT を付与・停止・再開する。
 * 同一ユーザー・同一商品は UPDATE、新規のみ INSERT。
 *
 * 検証（新規と既存で要件を分ける）:
 * - 事前に M_USER の存在を確認（不在は USER_NOT_FOUND 404。FK 任せにしない）。
 * - 新規: status/grantType/startAt/endAt を必須化（ADMIN_API.md 7 の付与 Request）。
 *   startAt/endAt は Date parse 可能かつ startAt <= endAt。
 * - 既存: status のみでの停止・再開を許可（他項目は指定時のみ更新、未指定は現状維持）。
 *   startAt/endAt を単独変更する場合も、既存値と組み合わせて start <= end を検証する。
 *   指定された日時は単独でも Date parse 可能であることを必須とする。
 *
 * @param productId 解決済み PRODUCT_ID
 * @throws AppError USER_NOT_FOUND(404) / VALIDATION_ERROR(400)
 */
export async function upsertUserProduct(
  env: Env,
  authUserId: string,
  productId: number,
  input: UpsertUserProductInput,
): Promise<void> {
  const db = getDb(env);
  const now = nowIso();

  // 対象ユーザーの存在確認（FK 任せにしない）
  const userExists = await db
    .prepare("SELECT AUTH_USER_ID FROM M_USER WHERE AUTH_USER_ID = ?")
    .bind(authUserId)
    .first<{ AUTH_USER_ID: string }>();
  if (!userExists) {
    throw new AppError("USER_NOT_FOUND", "アカウントが見つかりません。", 404);
  }

  const existing = await db
    .prepare(
      "SELECT STATUS, START_DATE, END_DATE, GRANT_TYPE, MEMO, PURCHASE_ID FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?",
    )
    .bind(authUserId, productId)
    .first<{
      STATUS: number;
      START_DATE: string;
      END_DATE: string;
      GRANT_TYPE: number;
      MEMO: string | null;
      PURCHASE_ID: number | null;
    }>();

  // 指定された日時が単独でも parse 可能かを検証（VALIDATION_ERROR）
  function assertParsable(label: string, iso: string): number {
    const t = toTime(iso);
    if (Number.isNaN(t)) {
      throw new ValidationError({
        [label]: "日時の形式が正しくありません。",
      });
    }
    return t;
  }

  if (existing) {
    // 既存更新: status だけでの停止・再開を許可。指定項目のみ更新、未指定は現状維持。
    const sets: string[] = ["STATUS = ?", "UPDATE_DATE = ?"];
    const binds: Array<string | number> = [input.status, now];

    // 実効の start/end を、既存値と入力の組み合わせで決める
    let effStart = existing.START_DATE;
    let effEnd = existing.END_DATE;
    if (input.startAt) {
      assertParsable("startAt", input.startAt);
      effStart = input.startAt;
    }
    if (input.endAt) {
      assertParsable("endAt", input.endAt);
      effEnd = input.endAt;
    }
    // 片側/両側変更いずれでも、実効 start <= end を Date で検証
    if (input.startAt || input.endAt) {
      const s = toTime(effStart);
      const e = toTime(effEnd);
      if (Number.isNaN(s) || Number.isNaN(e) || s > e) {
        throw new ValidationError({
          endAt: "終了日時は開始日時以降にしてください。",
        });
      }
    }

    if (input.grantType !== null && input.grantType !== undefined) {
      sets.push("GRANT_TYPE = ?");
      binds.push(input.grantType);
    }
    if (input.startAt) {
      sets.push("START_DATE = ?");
      binds.push(input.startAt);
    }
    if (input.endAt) {
      sets.push("END_DATE = ?");
      binds.push(input.endAt);
    }
    if (input.memo !== null && input.memo !== undefined) {
      sets.push("MEMO = ?");
      binds.push(input.memo);
    }
    // status だけ更新の場合、GRANT_TYPE/START/END/MEMO/PURCHASE_ID は SET に含めず現状維持
    binds.push(authUserId, productId);
    await db
      .prepare(`UPDATE T_USER_PRODUCT SET ${sets.join(", ")} WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?`)
      .bind(...binds)
      .run();
  } else {
    // 新規付与: status/grantType/startAt/endAt を必須化（ADMIN_API.md 7）
    const missing: Record<string, string> = {};
    if (input.grantType === null || input.grantType === undefined) missing.grantType = "必須項目です。";
    if (!input.startAt) missing.startAt = "必須項目です。";
    if (!input.endAt) missing.endAt = "必須項目です。";
    if (Object.keys(missing).length > 0) {
      throw new ValidationError(missing);
    }
    const s = assertParsable("startAt", input.startAt as string);
    const e = assertParsable("endAt", input.endAt as string);
    if (s > e) {
      throw new ValidationError({
        endAt: "終了日時は開始日時以降にしてください。",
      });
    }
    // 手動付与では PURCHASE_ID は NULL（T_PURCHASE を偽造しない）
    await db
      .prepare(
        `INSERT INTO T_USER_PRODUCT
           (AUTH_USER_ID, PRODUCT_ID, STATUS, START_DATE, END_DATE, GRANT_TYPE, PURCHASE_ID, MEMO, DEL_FLG, CREATE_DATE, UPDATE_DATE)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
      )
      .bind(
        authUserId,
        productId,
        input.status,
        input.startAt as string,
        input.endAt as string,
        input.grantType as number,
        input.memo ?? null,
        now,
        now,
      )
      .run();
  }
}

/** Warning 更新の入力 */
export interface UpdateWarningInput {
  status: number;
  memo?: string | null;
}

/**
 * T_WARNING の対応状態・MEMO を更新する。
 * ユーザー停止はここで自動実行しない（ADMIN_API 9）。
 *
 * @throws AppError WARNING_NOT_FOUND(404)
 */
export async function updateWarning(
  env: Env,
  warningId: number,
  input: UpdateWarningInput,
): Promise<void> {
  const db = getDb(env);
  const now = nowIso();

  const existing = await db
    .prepare("SELECT WARNING_ID FROM T_WARNING WHERE WARNING_ID = ?")
    .bind(warningId)
    .first<{ WARNING_ID: number }>();
  if (!existing) {
    throw new AppError("WARNING_NOT_FOUND", "対象が見つかりません。", 404);
  }

  const sets: string[] = ["STATUS = ?", "LAST_ACTION_DATE = ?", "UPDATE_DATE = ?"];
  const binds: Array<string | number> = [input.status, now, now];
  if (input.memo !== null && input.memo !== undefined) {
    sets.push("MEMO = ?");
    binds.push(input.memo);
  }
  binds.push(warningId);
  await db
    .prepare(`UPDATE T_WARNING SET ${sets.join(", ")} WHERE WARNING_ID = ?`)
    .bind(...binds)
    .run();
}
