/**
 * note 移行成立ロジック
 *
 * 利用者が「商品 + note 取引ID」で移行を申請し、CSV 取込済みの T_NOTE_PURCHASE と
 * 照合できた場合に、T_PURCHASE / T_USER_PRODUCT / T_NOTE_PURCHASE を D1 batch で
 * 一括更新して権限を付与する。
 *
 * 設計根拠:
 * - WORK-008 確定事項 11/12
 * - api/NOTE_MIGRATION_API.md 3, api/API.md 8/9
 * - WORK-007 で確定・Production E2E 済みの D1 batch + last_insert_rowid 方式を再利用
 *
 * 権限付与値:
 * - T_PURCHASE: PURCHASE_SOURCE=1 / EXTERNAL_PURCHASE_ID=NOTE_TRANSACTION_ID /
 *   PURCHASE_DATE=元note購入日時 / AMOUNT=T_NOTE_PURCHASE.PURCHASE_AMOUNT / PAYMENT_STATUS=1
 * - T_USER_PRODUCT: GRANT_TYPE=1 / START_DATE=元note購入日時 /
 *   END_DATE=9999-12-31T23:59:59+09:00 / STATUS=1 / PURCHASE_ID=新規PURCHASE_ID
 * - T_NOTE_PURCHASE: MATCH_STATUS=1 / MATCH_AUTH_USER_ID / MATCH_DATE=移行実行日時 / PURCHASE_ID
 *
 * 冪等・整合:
 * - 対象 T_NOTE_PURCHASE は MATCH_STATUS=0（未移行）のみ成立。移行済み/要確認/無効は不成立。
 * - UX_T_PURCHASE_EXTERNAL(PURCHASE_SOURCE, EXTERNAL_PURCHASE_ID) で二重 T_PURCHASE を防止。
 * - 利用者へは理由を区別しない共通エラー（呼出側で共通文言に変換）。
 */

import { getDb } from "./db";
import { nowIso } from "./datetime";
import { getMUser } from "./account";
import { getActiveProductByCode } from "./entitlement";
import { AppError } from "./errors";
import type { Env } from "../index";

/** 買い切りの終了日時（JST、WORK-007 と同一） */
const FOREVER_END = "9999-12-31T23:59:59+09:00";
/** T_PURCHASE.PURCHASE_SOURCE: note 移行 */
const PURCHASE_SOURCE_NOTE = 1;
/** T_PURCHASE.PAYMENT_STATUS: 支払済 */
const PAYMENT_STATUS_PAID = 1;
/** T_USER_PRODUCT.GRANT_TYPE: note 移行 */
const GRANT_TYPE_NOTE = 1;
/** T_NOTE_PURCHASE.MATCH_STATUS: 未移行 / 移行済 */
const MATCH_STATUS_UNMIGRATED = 0;
const MATCH_STATUS_MIGRATED = 1;

/**
 * 移行を成立させる。
 *
 * @param authUserId ログイン中ユーザー
 * @param productCode 選択商品（HANABI / HANABI_GOOGLE_EARTH）
 * @param transactionId note 取引ID
 * @throws AppError NOTE_MIGRATION_FAILED（理由を区別しない共通エラー）/ USER_SUSPENDED
 */
export async function applyNoteMigration(
  env: Env,
  authUserId: string,
  productCode: string,
  transactionId: string,
): Promise<void> {
  const db = getDb(env);
  const now = nowIso();

  // M_USER 有効確認
  const user = await getMUser(env, authUserId);
  if (!user || user.STATUS !== 1 || user.DEL_FLG !== 0) {
    throw new AppError("USER_SUSPENDED", "このアカウントは現在利用できません。", 403);
  }

  // 選択商品の存在確認
  const product = await getActiveProductByCode(env, productCode);
  if (!product) {
    // 商品違い等は利用者へ理由を区別しない
    throw new AppError("NOTE_MIGRATION_FAILED", "購入情報を確認できませんでした。", 400);
  }

  // 取引ID で T_NOTE_PURCHASE を照合（未移行のみ、選択商品と一致）
  const note = await db
    .prepare(
      `SELECT NOTE_PURCHASE_ID, PRODUCT_ID, PURCHASE_DATE, PURCHASE_AMOUNT, MATCH_STATUS, DEL_FLG
       FROM T_NOTE_PURCHASE WHERE NOTE_TRANSACTION_ID = ?`,
    )
    .bind(transactionId)
    .first<{
      NOTE_PURCHASE_ID: number;
      PRODUCT_ID: number;
      PURCHASE_DATE: string;
      PURCHASE_AMOUNT: number;
      MATCH_STATUS: number;
      DEL_FLG: number;
    }>();

  // 不存在 / 商品違い / 移行済み / 無効 いずれも同一の共通エラー（理由を区別しない）
  if (
    !note ||
    note.DEL_FLG !== 0 ||
    note.MATCH_STATUS !== MATCH_STATUS_UNMIGRATED ||
    note.PRODUCT_ID !== product.PRODUCT_ID
  ) {
    throw new AppError("NOTE_MIGRATION_FAILED", "購入情報を確認できませんでした。", 400);
  }

  // 冪等: 既に同一 note 取引で T_PURCHASE がある場合は二重付与しない
  // 同一 note 取引（PURCHASE_SOURCE=1 + EXTERNAL_PURCHASE_ID）の既存 T_PURCHASE を DEL_FLG 込みで取得。
  // adminLinkNotePurchase と同じ復活ルールに揃える:
  //   - 不存在        → 新規 INSERT
  //   - DEL_FLG=0     → 既に有効な購入がある。共通エラーで重複拒否
  //   - DEL_FLG=1     → 物理 DELETE せず、既存 PURCHASE_ID を UPDATE で復活
  const existingPurchase = await db
    .prepare(
      "SELECT PURCHASE_ID, DEL_FLG FROM T_PURCHASE WHERE PURCHASE_SOURCE = ? AND EXTERNAL_PURCHASE_ID = ?",
    )
    .bind(PURCHASE_SOURCE_NOTE, transactionId)
    .first<{ PURCHASE_ID: number; DEL_FLG: number }>();
  if (existingPurchase && existingPurchase.DEL_FLG === 0) {
    // 既に有効な購入がある（処理済み）。利用者へは理由を区別しない共通エラー。
    throw new AppError("NOTE_MIGRATION_FAILED", "購入情報を確認できませんでした。", 400);
  }

  // 利用者自身による note 移行では、対象商品の「非削除の権限行」を既に保持している場合は移行を拒否する。
  // 拒否条件 = DEL_FLG=0（STATUS・GRANT_TYPE は問わない）。
  // これにより、権限が増えないのに別 note 取引 ID だけを消費する操作を防ぐ。
  //   - DEL_FLG=0 / STATUS=1     → 拒否
  //   - DEL_FLG=0 / STATUS=2 他  → 拒否（STATUS に関係なく DEL_FLG=0 なら拒否）
  //   - DEL_FLG=1（unlink 済み等）→ 拒否しない（正当な再 apply を許可）
  //   - 行が存在しない            → 拒否しない
  // Stripe/note/テスター/管理者付与など GRANT_TYPE による区別もしない。
  // 拒否時は何も変更しない（T_PURCHASE 新規作成/復活なし・T_NOTE_PURCHASE 更新なし・T_USER_PRODUCT 変更なし）。
  const existingActiveRow = await db
    .prepare(
      "SELECT AUTH_USER_ID FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ? AND DEL_FLG = 0",
    )
    .bind(authUserId, product.PRODUCT_ID)
    .first<{ AUTH_USER_ID: string }>();
  if (existingActiveRow) {
    throw new AppError("NOTE_MIGRATION_FAILED", "購入情報を確認できませんでした。", 400);
  }

  // T_USER_PRODUCT の判定は「有効行（DEL_FLG=0）」を基準にする。
  // unlink で論理削除された note 由来行（DEL_FLG=1）を「既存の有効権限」と誤認しないこと。
  //   - activeUp（DEL_FLG=0）あり → Stripe/テスター/管理者付与等。一切上書きしない
  //   - activeUp なし + 物理行あり（DEL_FLG=1 の残骸）→ note 由来として UPDATE で再有効化
  //   - activeUp なし + 物理行なし → note 由来として新規 INSERT
  const activeUp = await db
    .prepare(
      "SELECT AUTH_USER_ID FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ? AND DEL_FLG = 0",
    )
    .bind(authUserId, product.PRODUCT_ID)
    .first<{ AUTH_USER_ID: string }>();
  const anyUpRow = await db
    .prepare("SELECT AUTH_USER_ID FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?")
    .bind(authUserId, product.PRODUCT_ID)
    .first<{ AUTH_USER_ID: string }>();

  const notePurchaseDate = note.PURCHASE_DATE; // 元 note 購入日時（START_DATE/PURCHASE_DATE に使用）

  if (existingPurchase && existingPurchase.DEL_FLG === 1) {
    // ---- 復活 UPDATE パス（unlink 後の再 apply）----
    // 新規 INSERT しないため last_insert_rowid() は使えない。既存 PURCHASE_ID を固定バインドする。
    const purchaseId = existingPurchase.PURCHASE_ID;

    const revivePurchase = db
      .prepare(
        `UPDATE T_PURCHASE
           SET AUTH_USER_ID = ?, PRODUCT_ID = ?, PURCHASE_DATE = ?, AMOUNT = ?,
               PAYMENT_STATUS = ?, DEL_FLG = 0, UPDATE_DATE = ?
         WHERE PURCHASE_ID = ?`,
      )
      .bind(authUserId, product.PRODUCT_ID, notePurchaseDate, note.PURCHASE_AMOUNT, PAYMENT_STATUS_PAID, now, purchaseId);

    const updateNoteRevive = db
      .prepare(
        `UPDATE T_NOTE_PURCHASE
           SET MATCH_STATUS = ?, MATCH_AUTH_USER_ID = ?, MATCH_DATE = ?,
               PURCHASE_ID = ?, UPDATE_DATE = ?
         WHERE NOTE_PURCHASE_ID = ?`,
      )
      .bind(MATCH_STATUS_MIGRATED, authUserId, now, purchaseId, now, note.NOTE_PURCHASE_ID);

    const stmts = [revivePurchase];
    if (!activeUp) {
      // 有効権限なし → note 由来権限を再有効化（物理行あり）または新規作成（物理行なし）
      if (anyUpRow) {
        stmts.push(
          db
            .prepare(
              `UPDATE T_USER_PRODUCT
                 SET STATUS = 1, START_DATE = ?, END_DATE = ?, GRANT_TYPE = ?,
                     PURCHASE_ID = ?, DEL_FLG = 0, UPDATE_DATE = ?
               WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?`,
            )
            .bind(notePurchaseDate, FOREVER_END, GRANT_TYPE_NOTE, purchaseId, now, authUserId, product.PRODUCT_ID),
        );
      } else {
        stmts.push(
          db
            .prepare(
              `INSERT INTO T_USER_PRODUCT
                 (AUTH_USER_ID, PRODUCT_ID, STATUS, START_DATE, END_DATE, GRANT_TYPE, PURCHASE_ID, DEL_FLG, CREATE_DATE, UPDATE_DATE)
               VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?)`,
            )
            .bind(authUserId, product.PRODUCT_ID, notePurchaseDate, FOREVER_END, GRANT_TYPE_NOTE, purchaseId, now, now),
        );
      }
    }
    stmts.push(updateNoteRevive);
    await db.batch(stmts);
    return;
  }

  // ---- 新規 INSERT パス（初回 apply）----
  // 1 文目: T_PURCHASE INSERT（note購入履歴。常に登録する）
  const insertPurchase = db
    .prepare(
      `INSERT INTO T_PURCHASE
         (AUTH_USER_ID, PRODUCT_ID, PURCHASE_SOURCE, EXTERNAL_PURCHASE_ID, PURCHASE_DATE,
          AMOUNT, PAYMENT_STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      authUserId,
      product.PRODUCT_ID,
      PURCHASE_SOURCE_NOTE,
      transactionId,
      notePurchaseDate,
      note.PURCHASE_AMOUNT,
      PAYMENT_STATUS_PAID,
      now,
      now,
    );

  // T_NOTE_PURCHASE を移行済みへ更新し、note側 T_PURCHASE（last_insert_rowid）へ紐付ける。
  const updateNote = db
    .prepare(
      `UPDATE T_NOTE_PURCHASE
         SET MATCH_STATUS = ?, MATCH_AUTH_USER_ID = ?, MATCH_DATE = ?,
             PURCHASE_ID = last_insert_rowid(), UPDATE_DATE = ?
       WHERE NOTE_PURCHASE_ID = ?`,
    )
    .bind(MATCH_STATUS_MIGRATED, authUserId, now, now, note.NOTE_PURCHASE_ID);

  if (activeUp) {
    // 既存の有効権限あり → T_USER_PRODUCT は触らず、note購入履歴のみ登録・紐付け。
    await db.batch([insertPurchase, updateNote]);
    return;
  }

  // 有効権限なし → note 由来権限を再有効化（DEL_FLG=1 残骸あり）または新規作成（残骸なし）
  const upsertUserProduct = anyUpRow
    ? db
        .prepare(
          `UPDATE T_USER_PRODUCT
             SET STATUS = 1, START_DATE = ?, END_DATE = ?, GRANT_TYPE = ?,
                 PURCHASE_ID = last_insert_rowid(), DEL_FLG = 0, UPDATE_DATE = ?
           WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?`,
        )
        .bind(notePurchaseDate, FOREVER_END, GRANT_TYPE_NOTE, now, authUserId, product.PRODUCT_ID)
    : db
        .prepare(
          `INSERT INTO T_USER_PRODUCT
             (AUTH_USER_ID, PRODUCT_ID, STATUS, START_DATE, END_DATE, GRANT_TYPE, PURCHASE_ID, DEL_FLG, CREATE_DATE, UPDATE_DATE)
           VALUES (?, ?, 1, ?, ?, ?, last_insert_rowid(), 0, ?, ?)`,
        )
        .bind(authUserId, product.PRODUCT_ID, notePurchaseDate, FOREVER_END, GRANT_TYPE_NOTE, now, now);

  // batch 順序に注意: T_USER_PRODUCT への INSERT は通常テーブルの rowid を新規採番し
  // last_insert_rowid() を書き換える。updateNote が last_insert_rowid() で T_PURCHASE.ID を
  // 参照するため、updateNote を T_USER_PRODUCT より前に実行する。
  // （insertPurchase → updateNote(UPDATE, rowid不変) → upsertUserProduct の順）
  await db.batch([insertPurchase, updateNote, upsertUserProduct]);
}

/** 移行済み商品の1件 */
export interface NoteMigrationStatusItem {
  productCode: string;
  matchedAt: string;
}

/**
 * ログイン中ユーザーの note 移行済み商品を返す。
 */
export async function listNoteMigrations(
  env: Env,
  authUserId: string,
): Promise<NoteMigrationStatusItem[]> {
  const db = getDb(env);
  const rows = await db
    .prepare(
      `SELECT p.PRODUCT_CODE AS productCode, n.MATCH_DATE AS matchedAt
       FROM T_NOTE_PURCHASE n JOIN M_PRODUCT p ON p.PRODUCT_ID = n.PRODUCT_ID
       WHERE n.MATCH_AUTH_USER_ID = ? AND n.MATCH_STATUS = ? AND n.DEL_FLG = 0
       ORDER BY n.MATCH_DATE DESC`,
    )
    .bind(authUserId, MATCH_STATUS_MIGRATED)
    .all<NoteMigrationStatusItem>();
  return rows.results ?? [];
}

/**
 * 管理者による手動紐付け（api/ADMIN_API.md 12「手動紐付け」）。
 *
 * 指定した note 購入行（未移行）を、指定した認証ユーザーへ紐付けて移行を成立させる。
 * 利用者 apply と同じ D1 batch 権限付与を管理者代行で行う。
 * 管理者へは実際の理由を返す（利用者向けの共通文言化はしない）。
 *
 * @throws AppError NOTE_PURCHASE_NOT_FOUND / NOTE_ALREADY_MIGRATED /
 *   NOTE_PRODUCT_MISMATCH / USER_NOT_FOUND / NOTE_ALREADY_LINKED
 */
export async function adminLinkNotePurchase(
  env: Env,
  notePurchaseId: number,
  targetAuthUserId: string,
): Promise<void> {
  const db = getDb(env);
  const now = nowIso();

  const note = await db
    .prepare(
      `SELECT NOTE_PURCHASE_ID, PRODUCT_ID, NOTE_TRANSACTION_ID, PURCHASE_DATE, PURCHASE_AMOUNT, MATCH_STATUS, DEL_FLG
       FROM T_NOTE_PURCHASE WHERE NOTE_PURCHASE_ID = ?`,
    )
    .bind(notePurchaseId)
    .first<{
      NOTE_PURCHASE_ID: number;
      PRODUCT_ID: number;
      NOTE_TRANSACTION_ID: string;
      PURCHASE_DATE: string;
      PURCHASE_AMOUNT: number;
      MATCH_STATUS: number;
      DEL_FLG: number;
    }>();
  if (!note || note.DEL_FLG !== 0) {
    throw new AppError("NOTE_PURCHASE_NOT_FOUND", "対象が見つかりません。", 404);
  }
  if (note.MATCH_STATUS === MATCH_STATUS_MIGRATED) {
    throw new AppError("NOTE_ALREADY_MIGRATED", "すでに移行済みです。", 409);
  }

  // 紐付け先ユーザーの存在確認（管理者操作なので停止中でも紐付け自体は許可、存在のみ確認）
  const user = await getMUser(env, targetAuthUserId);
  if (!user || user.DEL_FLG !== 0) {
    throw new AppError("USER_NOT_FOUND", "紐付け先ユーザーが見つかりません。", 404);
  }

  // 同一 note 取引（PURCHASE_SOURCE=1 + EXTERNAL_PURCHASE_ID）の既存 T_PURCHASE を DEL_FLG 込みで取得。
  // UNIQUE UX_T_PURCHASE_EXTERNAL(PURCHASE_SOURCE, EXTERNAL_PURCHASE_ID) を維持するため、
  // 物理 DELETE は行わず、論理削除済み(DEL_FLG=1)行は復活 UPDATE で再利用する。
  const existingPurchase = await db
    .prepare(
      "SELECT PURCHASE_ID, DEL_FLG FROM T_PURCHASE WHERE PURCHASE_SOURCE = ? AND EXTERNAL_PURCHASE_ID = ?",
    )
    .bind(PURCHASE_SOURCE_NOTE, note.NOTE_TRANSACTION_ID)
    .first<{ PURCHASE_ID: number; DEL_FLG: number }>();

  if (existingPurchase && existingPurchase.DEL_FLG === 0) {
    // 有効な購入が既にある → 重複拒否
    throw new AppError("NOTE_ALREADY_LINKED", "この取引は既に紐付け済みです。", 409);
  }

  // T_USER_PRODUCT の判定は「有効行（DEL_FLG=0）」を基準にする。
  // unlink で論理削除された note 由来行（DEL_FLG=1）を「既存の有効権限」と誤認しないこと。
  const activeUp = await db
    .prepare(
      "SELECT AUTH_USER_ID FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ? AND DEL_FLG = 0",
    )
    .bind(targetAuthUserId, note.PRODUCT_ID)
    .first<{ AUTH_USER_ID: string }>();
  const anyUpRow = await db
    .prepare("SELECT AUTH_USER_ID FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?")
    .bind(targetAuthUserId, note.PRODUCT_ID)
    .first<{ AUTH_USER_ID: string }>();

  if (existingPurchase && existingPurchase.DEL_FLG === 1) {
    // ---- 復活 UPDATE パス（誤紐付け解除後の再 link）----
    // 新規 INSERT しないため last_insert_rowid() は使えない。既存 PURCHASE_ID を固定バインドする。
    const purchaseId = existingPurchase.PURCHASE_ID;

    // note 購入データを正として T_PURCHASE を復活・更新
    const revivePurchase = db
      .prepare(
        `UPDATE T_PURCHASE
           SET AUTH_USER_ID = ?, PRODUCT_ID = ?, PURCHASE_DATE = ?, AMOUNT = ?,
               PAYMENT_STATUS = ?, DEL_FLG = 0, UPDATE_DATE = ?
         WHERE PURCHASE_ID = ?`,
      )
      .bind(
        targetAuthUserId,
        note.PRODUCT_ID,
        note.PURCHASE_DATE,
        note.PURCHASE_AMOUNT,
        PAYMENT_STATUS_PAID,
        now,
        purchaseId,
      );

    const updateNoteRevive = db
      .prepare(
        `UPDATE T_NOTE_PURCHASE
           SET MATCH_STATUS = ?, MATCH_AUTH_USER_ID = ?, MATCH_DATE = ?,
               PURCHASE_ID = ?, UPDATE_DATE = ?
         WHERE NOTE_PURCHASE_ID = ?`,
      )
      .bind(MATCH_STATUS_MIGRATED, targetAuthUserId, now, purchaseId, now, note.NOTE_PURCHASE_ID);

    if (activeUp) {
      // 既存の有効権限あり → T_USER_PRODUCT は上書きせず、note購入履歴のみ復活・紐付け。
      await db.batch([revivePurchase, updateNoteRevive]);
      return;
    }

    // 有効権限なし → note 由来権限を再有効化（DEL_FLG=1 残骸あり）または新規作成（残骸なし）
    const upUserProductRevive = anyUpRow
      ? db
          .prepare(
            `UPDATE T_USER_PRODUCT
               SET STATUS = 1, START_DATE = ?, END_DATE = ?, GRANT_TYPE = ?,
                   PURCHASE_ID = ?, DEL_FLG = 0, UPDATE_DATE = ?
             WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?`,
          )
          .bind(note.PURCHASE_DATE, FOREVER_END, GRANT_TYPE_NOTE, purchaseId, now, targetAuthUserId, note.PRODUCT_ID)
      : db
          .prepare(
            `INSERT INTO T_USER_PRODUCT
               (AUTH_USER_ID, PRODUCT_ID, STATUS, START_DATE, END_DATE, GRANT_TYPE, PURCHASE_ID, DEL_FLG, CREATE_DATE, UPDATE_DATE)
             VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .bind(targetAuthUserId, note.PRODUCT_ID, note.PURCHASE_DATE, FOREVER_END, GRANT_TYPE_NOTE, purchaseId, now, now);

    await db.batch([revivePurchase, upUserProductRevive, updateNoteRevive]);
    return;
  }

  // ---- 新規 INSERT パス（初回 link）----
  const insertPurchase = db
    .prepare(
      `INSERT INTO T_PURCHASE
         (AUTH_USER_ID, PRODUCT_ID, PURCHASE_SOURCE, EXTERNAL_PURCHASE_ID, PURCHASE_DATE,
          AMOUNT, PAYMENT_STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      targetAuthUserId,
      note.PRODUCT_ID,
      PURCHASE_SOURCE_NOTE,
      note.NOTE_TRANSACTION_ID,
      note.PURCHASE_DATE,
      note.PURCHASE_AMOUNT,
      PAYMENT_STATUS_PAID,
      now,
      now,
    );

  const updateNoteInsert = db
    .prepare(
      `UPDATE T_NOTE_PURCHASE
         SET MATCH_STATUS = ?, MATCH_AUTH_USER_ID = ?, MATCH_DATE = ?,
             PURCHASE_ID = last_insert_rowid(), UPDATE_DATE = ?
       WHERE NOTE_PURCHASE_ID = ?`,
    )
    .bind(MATCH_STATUS_MIGRATED, targetAuthUserId, now, now, note.NOTE_PURCHASE_ID);

  if (activeUp) {
    // 既存の有効権限あり → T_USER_PRODUCT は上書きせず、note購入履歴のみ登録・紐付け。
    await db.batch([insertPurchase, updateNoteInsert]);
    return;
  }

  // 有効権限なし → note 由来権限を再有効化（DEL_FLG=1 残骸あり）または新規作成（残骸なし）
  const upsertUserProduct = anyUpRow
    ? db
        .prepare(
          `UPDATE T_USER_PRODUCT
             SET STATUS = 1, START_DATE = ?, END_DATE = ?, GRANT_TYPE = ?,
                 PURCHASE_ID = last_insert_rowid(), DEL_FLG = 0, UPDATE_DATE = ?
           WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?`,
        )
        .bind(note.PURCHASE_DATE, FOREVER_END, GRANT_TYPE_NOTE, now, targetAuthUserId, note.PRODUCT_ID)
    : db
        .prepare(
          `INSERT INTO T_USER_PRODUCT
             (AUTH_USER_ID, PRODUCT_ID, STATUS, START_DATE, END_DATE, GRANT_TYPE, PURCHASE_ID, DEL_FLG, CREATE_DATE, UPDATE_DATE)
           VALUES (?, ?, 1, ?, ?, ?, last_insert_rowid(), 0, ?, ?)`,
        )
        .bind(targetAuthUserId, note.PRODUCT_ID, note.PURCHASE_DATE, FOREVER_END, GRANT_TYPE_NOTE, now, now);

  // batch 順序に注意（apply と同じ）: updateNoteInsert を T_USER_PRODUCT より前に置き、
  // last_insert_rowid() が T_PURCHASE.ID を正しく指すようにする。
  await db.batch([insertPurchase, updateNoteInsert, upsertUserProduct]);
}

/** 紐付け解除時の影響（画面表示用） */
export interface UnlinkImpact {
  notePurchaseId: number;
  affectedPurchaseId: number | null; // 影響する T_PURCHASE.PURCHASE_ID
  affectedAuthUserId: string | null; // 影響する T_USER_PRODUCT の対象ユーザー
  productId: number;
}

/**
 * 紐付け解除の影響を取得する（api/ADMIN_API.md 12「対象データを明示」）。
 * 実際の巻戻しは行わず、T_PURCHASE / T_USER_PRODUCT への影響のみ返す。
 */
export async function getUnlinkImpact(
  env: Env,
  notePurchaseId: number,
): Promise<UnlinkImpact | null> {
  const db = getDb(env);
  const note = await db
    .prepare(
      `SELECT NOTE_PURCHASE_ID, PRODUCT_ID, PURCHASE_ID, MATCH_AUTH_USER_ID, MATCH_STATUS, DEL_FLG
       FROM T_NOTE_PURCHASE WHERE NOTE_PURCHASE_ID = ?`,
    )
    .bind(notePurchaseId)
    .first<{
      NOTE_PURCHASE_ID: number;
      PRODUCT_ID: number;
      PURCHASE_ID: number | null;
      MATCH_AUTH_USER_ID: string | null;
      MATCH_STATUS: number;
      DEL_FLG: number;
    }>();
  if (!note || note.DEL_FLG !== 0) return null;
  return {
    notePurchaseId: note.NOTE_PURCHASE_ID,
    affectedPurchaseId: note.PURCHASE_ID,
    affectedAuthUserId: note.MATCH_AUTH_USER_ID,
    productId: note.PRODUCT_ID,
  };
}

/**
 * 管理者による紐付け解除（api/ADMIN_API.md 12「紐付け解除」）。
 *
 * 初期実装は「複雑な自動巻戻しを作らない」方針に従い、影響を確認したうえで
 * 明示的な最小限の巻戻し（T_PURCHASE 論理削除・T_USER_PRODUCT 停止・
 * T_NOTE_PURCHASE を未移行へ戻す）を D1 batch で行う。
 *
 * @param confirmed 影響を確認済みか。false の場合は解除せず影響のみ取得させる
 * @throws AppError NOTE_PURCHASE_NOT_FOUND / NOTE_NOT_MIGRATED / UNLINK_NOT_CONFIRMED
 */
export async function adminUnlinkNotePurchase(
  env: Env,
  notePurchaseId: number,
  confirmed: boolean,
): Promise<void> {
  const db = getDb(env);
  const now = nowIso();

  const note = await db
    .prepare(
      `SELECT NOTE_PURCHASE_ID, PRODUCT_ID, PURCHASE_ID, MATCH_AUTH_USER_ID, MATCH_STATUS, DEL_FLG
       FROM T_NOTE_PURCHASE WHERE NOTE_PURCHASE_ID = ?`,
    )
    .bind(notePurchaseId)
    .first<{
      NOTE_PURCHASE_ID: number;
      PRODUCT_ID: number;
      PURCHASE_ID: number | null;
      MATCH_AUTH_USER_ID: string | null;
      MATCH_STATUS: number;
      DEL_FLG: number;
    }>();
  if (!note || note.DEL_FLG !== 0) {
    throw new AppError("NOTE_PURCHASE_NOT_FOUND", "対象が見つかりません。", 404);
  }
  if (note.MATCH_STATUS !== MATCH_STATUS_MIGRATED) {
    throw new AppError("NOTE_NOT_MIGRATED", "移行済みではないため解除できません。", 409);
  }
  if (!confirmed) {
    // 影響未確認では解除しない（呼出側で getUnlinkImpact を提示してから confirmed=true で再実行）
    throw new AppError("UNLINK_NOT_CONFIRMED", "影響を確認してから解除してください。", 409);
  }

  const stmts = [];
  // T_PURCHASE を論理削除（存在する場合。選択肢B: 物理DELETEしない）
  if (note.PURCHASE_ID !== null) {
    stmts.push(
      db
        .prepare("UPDATE T_PURCHASE SET DEL_FLG = 1, UPDATE_DATE = ? WHERE PURCHASE_ID = ?")
        .bind(now, note.PURCHASE_ID),
    );
  }
  // T_USER_PRODUCT を変更してよいのは「今回のnote移行で作成された権限」だけ。
  // すなわち GRANT_TYPE = 1（note移行）かつ PURCHASE_ID = 対象note購入のPURCHASE_ID の
  // 両方を満たす行に限る。Stripe・テスター・管理者付与等の既存権限は変更しない。
  // 対象行は無効化し（DEL_FLG=1, STATUS=2）、PURCHASE_ID を NULL クリアして、
  // relink で復活する T_PURCHASE を旧ユーザーが参照し続けない状態にする。
  if (note.MATCH_AUTH_USER_ID !== null && note.PURCHASE_ID !== null) {
    stmts.push(
      db
        .prepare(
          `UPDATE T_USER_PRODUCT
             SET STATUS = 2, DEL_FLG = 1, PURCHASE_ID = NULL, UPDATE_DATE = ?
           WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ? AND PURCHASE_ID = ? AND GRANT_TYPE = ?`,
        )
        .bind(now, note.MATCH_AUTH_USER_ID, note.PRODUCT_ID, note.PURCHASE_ID, GRANT_TYPE_NOTE),
    );
  }
  // T_NOTE_PURCHASE を未移行へ戻す（紐付け情報をクリア）
  stmts.push(
    db
      .prepare(
        `UPDATE T_NOTE_PURCHASE
           SET MATCH_STATUS = ?, MATCH_AUTH_USER_ID = NULL, MATCH_DATE = NULL, PURCHASE_ID = NULL, UPDATE_DATE = ?
         WHERE NOTE_PURCHASE_ID = ?`,
      )
      .bind(MATCH_STATUS_UNMIGRATED, now, note.NOTE_PURCHASE_ID),
  );

  await db.batch(stmts);
}

/**
 * 管理者による状態変更（要確認化=2 / 無効化=9 / 未移行へ戻す=0）。
 * 移行済み(1)への変更は紐付け系 API（link/unlink）で扱うため、ここでは拒否する。
 *
 * @throws AppError NOTE_PURCHASE_NOT_FOUND / NOTE_ALREADY_MIGRATED
 */
export async function adminSetNoteMatchStatus(
  env: Env,
  notePurchaseId: number,
  matchStatus: number,
): Promise<void> {
  const db = getDb(env);
  const existing = await db
    .prepare("SELECT NOTE_PURCHASE_ID, MATCH_STATUS FROM T_NOTE_PURCHASE WHERE NOTE_PURCHASE_ID = ? AND DEL_FLG = 0")
    .bind(notePurchaseId)
    .first<{ NOTE_PURCHASE_ID: number; MATCH_STATUS: number }>();
  if (!existing) {
    throw new AppError("NOTE_PURCHASE_NOT_FOUND", "対象が見つかりません。", 404);
  }
  if (existing.MATCH_STATUS === MATCH_STATUS_MIGRATED) {
    throw new AppError("NOTE_ALREADY_MIGRATED", "移行済みのため、この操作では変更できません。解除してから行ってください。", 409);
  }
  await db
    .prepare("UPDATE T_NOTE_PURCHASE SET MATCH_STATUS = ?, UPDATE_DATE = ? WHERE NOTE_PURCHASE_ID = ?")
    .bind(matchStatus, nowIso(), notePurchaseId)
    .run();
}
