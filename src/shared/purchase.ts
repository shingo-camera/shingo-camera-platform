/**
 * 購入系共通ロジック
 *
 * - Checkout Session 作成の前提確認（ユーザー有効・商品存在・二重購入防止）
 * - 特定商品の available 判定（status 用）
 * - Webhook 受信時の T_PURCHASE / T_USER_PRODUCT への反映（D1 batch・冪等）
 *
 * 設計根拠: api/PURCHASE_API.md 2/3/4/5, api/API.md 8/9, adr/ADR-007
 *
 * 権限付与の正本は署名検証済み Webhook のみ（完了画面から付与しない）。
 */

import { getDb } from "./db";
import { nowIso } from "./datetime";
import { getMUser } from "./account";
import { getActiveProductByCode, type ProductRow } from "./entitlement";
import { AppError } from "./errors";
import type { Env } from "../index";

/** 買い切りの終了日時（JST） */
const FOREVER_END = "9999-12-31T23:59:59+09:00";

/** T_PURCHASE.PURCHASE_SOURCE: Stripe */
const PURCHASE_SOURCE_STRIPE = 0;
/** T_PURCHASE.PAYMENT_STATUS: 支払済 */
const PAYMENT_STATUS_PAID = 1;
/** T_USER_PRODUCT.GRANT_TYPE: 購入 */
const GRANT_TYPE_PURCHASE = 0;

/** ISO 文字列を時刻数値へ（不正は NaN） */
function toTime(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * 商品コードから期待 Price ID を解決する（サーバー側 env / Cloudflare Secret）。
 * 現状は SUN_AND_MOON のみ。商品追加時はここに追加する（新 SETTING_KEY は使わない）。
 *
 * @returns Price ID、未設定・未対応商品は undefined
 */
export function resolvePriceId(env: Env, productCode: string): string | undefined {
  switch (productCode) {
    case "SUN_AND_MOON":
      return env.STRIPE_PRICE_SUN_AND_MOON;
    default:
      return undefined;
  }
}

/**
 * 指定商品が現在 available かを判定する（二重購入チェック・status 用）。
 * available 条件は WORK-005 と同一（M_USER/M_PRODUCT/T_USER_PRODUCT の状態 + 期間内）。
 *
 * @returns available（true=利用可能）
 */
export async function isProductAvailable(
  env: Env,
  authUserId: string,
  productCode: string,
): Promise<boolean> {
  const db = getDb(env);

  // M_USER 有効
  const user = await getMUser(env, authUserId);
  if (!user || user.STATUS !== 1 || user.DEL_FLG !== 0) return false;

  // M_PRODUCT 有効
  const product = await getActiveProductByCode(env, productCode);
  if (!product) return false;

  // T_USER_PRODUCT 有効 + 期間内
  const up = await db
    .prepare(
      "SELECT STATUS, START_DATE, END_DATE, DEL_FLG FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?",
    )
    .bind(authUserId, product.PRODUCT_ID)
    .first<{ STATUS: number; START_DATE: string; END_DATE: string; DEL_FLG: number }>();
  if (!up || up.STATUS !== 1 || up.DEL_FLG !== 0) return false;

  const nowMs = toTime(nowIso());
  const s = toTime(up.START_DATE);
  const e = toTime(up.END_DATE);
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  return s <= nowMs && nowMs <= e;
}

/** Checkout 作成の前提確認結果 */
export interface CheckoutPrecheck {
  product: ProductRow;
}

/**
 * Checkout Session 作成の前提を確認する。
 *
 * 1. M_USER 有効（停止・退会・仮登録は不可）
 * 2. M_PRODUCT 存在（有効商品）
 * 3. 二重購入防止: 既に available ならエラー
 *
 * @throws AppError USER_SUSPENDED(403) / PRODUCT_NOT_FOUND(404) / ALREADY_PURCHASED(409)
 */
export async function precheckCheckout(
  env: Env,
  authUserId: string,
  productCode: string,
): Promise<CheckoutPrecheck> {
  const user = await getMUser(env, authUserId);
  if (!user || user.STATUS !== 1 || user.DEL_FLG !== 0) {
    throw new AppError("USER_SUSPENDED", "このアカウントは現在利用できません。", 403);
  }

  const product = await getActiveProductByCode(env, productCode);
  if (!product) {
    throw new AppError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
  }

  // 二重購入防止（既に有効権限があれば Checkout を作成しない）
  const available = await isProductAvailable(env, authUserId, productCode);
  if (available) {
    throw new AppError("ALREADY_PURCHASED", "この商品は既に利用可能です。", 409);
  }

  return { product };
}

/** Webhook 反映の入力（検証済み値） */
export interface FulfillInput {
  authUserId: string;
  productCode: string;
  sessionId: string;
  amountTotal: number;
  purchaseDate: string; // JST ISO
}

/** Webhook 反映の結果 */
export interface FulfillResult {
  /** 既に処理済み（冪等スキップ） */
  alreadyProcessed: boolean;
}

/**
 * Webhook（checkout.session.completed かつ payment_status=paid）の内容を
 * T_PURCHASE / T_USER_PRODUCT へ反映する。
 *
 * 冪等性:
 * - UX_T_PURCHASE_EXTERNAL（PURCHASE_SOURCE, EXTERNAL_PURCHASE_ID）で二重 INSERT を防ぐ。
 * - 反映前に同一 EXTERNAL_PURCHASE_ID の既存 T_PURCHASE を確認し、あれば処理済みとして
 *   何もせず返す（再送で 200 を返すため）。
 *
 * 整合性:
 * - T_PURCHASE INSERT と T_USER_PRODUCT INSERT/UPDATE を D1 batch で一括実行（API.md 8）。
 *   現在の D1 batch はアトミック（1 文でも失敗すればシーケンス全体をロールバック）。
 * - T_USER_PRODUCT は T_PURCHASE の AUTOINCREMENT PURCHASE_ID を必要とするため、
 *   batch 2 文目の SQL 内で last_insert_rowid() を用いて直前 INSERT の PURCHASE_ID を参照する
 *   （同一 batch は順次・非並行実行のため、直前 INSERT の rowid を安全に引き継げる）。
 * - INSERT / UPDATE の分岐（既存 T_USER_PRODUCT の有無）は batch 実行前に SELECT で判定する。
 *
 * 不整合（AppError で内部エラー扱い、権限付与しない）:
 * - AUTH_USER_ID が存在しない
 * - PRODUCT_CODE が存在しない
 *
 * @throws AppError 不整合時（呼出側で内部エラーとして記録）
 */
export async function fulfillCheckout(env: Env, input: FulfillInput): Promise<FulfillResult> {
  const db = getDb(env);
  const now = nowIso();

  // 冪等: 同一 Session ID の T_PURCHASE が既にあれば処理済み
  const existingPurchase = await db
    .prepare(
      "SELECT PURCHASE_ID FROM T_PURCHASE WHERE PURCHASE_SOURCE = ? AND EXTERNAL_PURCHASE_ID = ?",
    )
    .bind(PURCHASE_SOURCE_STRIPE, input.sessionId)
    .first<{ PURCHASE_ID: number }>();
  if (existingPurchase) {
    return { alreadyProcessed: true };
  }

  // AUTH_USER_ID 存在確認
  const user = await getMUser(env, input.authUserId);
  if (!user) {
    throw new AppError("USER_NOT_FOUND", "アカウントが見つかりません。", 404);
  }

  // PRODUCT_CODE 存在確認（有効商品）
  const product = await getActiveProductByCode(env, input.productCode);
  if (!product) {
    throw new AppError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
  }

  // 既存 T_USER_PRODUCT の有無を判定（batch の INSERT/UPDATE 分岐）
  const existingUp = await db
    .prepare("SELECT AUTH_USER_ID FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?")
    .bind(input.authUserId, product.PRODUCT_ID)
    .first<{ AUTH_USER_ID: string }>();

  // 1 文目: T_PURCHASE INSERT（UNIQUE 制約で冪等）
  const insertPurchase = db
    .prepare(
      `INSERT INTO T_PURCHASE
         (AUTH_USER_ID, PRODUCT_ID, PURCHASE_SOURCE, EXTERNAL_PURCHASE_ID, PURCHASE_DATE,
          AMOUNT, PAYMENT_STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      input.authUserId,
      product.PRODUCT_ID,
      PURCHASE_SOURCE_STRIPE,
      input.sessionId,
      input.purchaseDate,
      input.amountTotal,
      PAYMENT_STATUS_PAID,
      now,
      now,
    );

  // 2 文目: T_USER_PRODUCT を last_insert_rowid() で PURCHASE_ID 参照して INSERT/UPDATE。
  // 同一 batch は順次・非並行実行のため、直前 INSERT の rowid を安全に引き継げる。
  const upsertUserProduct = existingUp
    ? db
        .prepare(
          `UPDATE T_USER_PRODUCT
             SET STATUS = 1, START_DATE = ?, END_DATE = ?, GRANT_TYPE = ?,
                 PURCHASE_ID = last_insert_rowid(), DEL_FLG = 0, UPDATE_DATE = ?
           WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?`,
        )
        .bind(input.purchaseDate, FOREVER_END, GRANT_TYPE_PURCHASE, now, input.authUserId, product.PRODUCT_ID)
    : db
        .prepare(
          `INSERT INTO T_USER_PRODUCT
             (AUTH_USER_ID, PRODUCT_ID, STATUS, START_DATE, END_DATE, GRANT_TYPE, PURCHASE_ID, DEL_FLG, CREATE_DATE, UPDATE_DATE)
           VALUES (?, ?, 1, ?, ?, ?, last_insert_rowid(), 0, ?, ?)`,
        )
        .bind(
          input.authUserId,
          product.PRODUCT_ID,
          input.purchaseDate,
          FOREVER_END,
          GRANT_TYPE_PURCHASE,
          now,
          now,
        );

  // D1 batch でアトミック実行（T_PURCHASE → T_USER_PRODUCT の順）。
  // 現在の D1 batch は 1 文でも失敗すればシーケンス全体をロールバックする。
  await db.batch([insertPurchase, upsertUserProduct]);

  return { alreadyProcessed: false };
}
