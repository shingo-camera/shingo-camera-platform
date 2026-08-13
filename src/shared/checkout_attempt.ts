/**
 * 支払い試行層（T_CHECKOUT_ATTEMPT / _ITEM / T_PRODUCT_CHECKOUT_LOCK / T_PAYMENT_EVENT）
 *
 * 確定設計（ORDER_LIFECYCLE_DESIGN_*）の実装:
 * - Stripe Checkout Session = 支払い試行。試行を Platform 側で追跡する。
 * - 二重 Checkout 排他は T_PRODUCT_CHECKOUT_LOCK の PRIMARY KEY を DB 制約の正本とする
 *   （in-memory lock を使わない・「SELECT して無ければ INSERT」に頼らない）。
 * - 新規 attempt 作成は attempt + item + cart 全 lock を 1 batch にし、1 件でも PK 競合したら
 *   batch 全体 rollback（部分ロックを残さない）。ON CONFLICT DO NOTHING は使わない。
 * - operationId は browser 生成の安定キー。単独では正本にせず OPERATION_ID + AUTH_USER_ID + CART_KEY
 *   の 3 一致で同一試行を判定する。
 * - Stripe idempotencyKey は server 生成 namespace 付き（checkout:<authUserId>:<operationId>）。
 * - create 再実行は DB snapshot（ATTEMPT / ATTEMPT_ITEM / BUYER_EMAIL）から同一パラメータで再現。
 */

import { getDb } from "./db";
import { nowIso } from "./datetime";
import { AppError, ValidationError } from "./errors";
import type { ProductRow } from "./entitlement";
import { PURCHASE_SOURCE_STRIPE } from "./purchase";
import type { Env } from "../index";

/* ============================================================
 * 定数（STATUS / EVENT_TYPE）
 * ============================================================ */

/** T_CHECKOUT_ATTEMPT.STATUS */
export const ATTEMPT_STATUS = {
  CREATING: 0,
  OPEN: 1,
  PAID: 2,
  EXPIRED: 3,
  CANCELLED: 4,
} as const;

/** T_PAYMENT_EVENT.EVENT_TYPE */
export const PAYMENT_EVENT_TYPE = {
  DUPLICATE_PAID: 1,
  REFUND: 2,
  DISPUTE: 3,
  FULFILL_FAILURE: 4,
  RECONCILE: 5,
  SERVER_INDETERMINATE: 6,
} as const;

/* ============================================================
 * operationId 検証（browser 入力のため server 側で検証する）
 * ============================================================ */

/** UUID 一般形（v4 に限定せず緩めに許容。長さ・文字種を担保）。 */
const OPERATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * operationId を検証する（UUID 形式・最大長・文字種）。不正は ValidationError。
 * @throws ValidationError
 */
export function validateOperationId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError({ operationId: "購入手続きの識別子が不正です。" });
  }
  const v = raw.trim();
  if (v.length === 0 || v.length > 36 || !OPERATION_ID_RE.test(v)) {
    throw new ValidationError({ operationId: "購入手続きの識別子が不正です。" });
  }
  return v;
}

/* ============================================================
 * CART_KEY（server 正規化した商品構成の安定表現）
 * ============================================================ */

/**
 * 確定した PRODUCT_CODE 群から安定した CART_KEY を作る。
 * browser の価格・商品情報は使わず、server が precheck で確定した PRODUCT_CODE のみを用いる。
 * 安定順序（PRODUCT_CODE 昇順）で連結する（同一商品構成なら常に同一文字列）。
 */
export function buildCartKey(productCodes: string[]): string {
  return [...productCodes].sort().join("|");
}

/* ============================================================
 * idempotencyKey（server 生成・auth user で namespace 分離）
 * ============================================================ */

/**
 * Stripe create の idempotencyKey を生成する。
 * 同一 user + 同一 operation → 同一 key。別 user は同じ browser operationId でも別 key。
 * Stripe の 255 文字制限内（authUserId/operationId は UUID 相当で十分収まる）。
 */
export function buildIdempotencyKey(authUserId: string, operationId: string): string {
  return `checkout:${authUserId}:${operationId}`;
}

/**
 * DB エラーが T_PRODUCT_CHECKOUT_LOCK の PK/UNIQUE 競合（＝並行 Checkout の予約競合）か判定する。
 * これに該当する場合のみ ALREADY_IN_PROGRESS(409) とし、それ以外（D1 障害・SQL エラー・FK 違反・
 * 他テーブルの constraint・想定外）は INTERNAL_ERROR(500) として扱う（「購入手続き中」と誤診しない）。
 *
 * SQLite/D1 のエラーメッセージ形式:
 *   lock 競合    : "UNIQUE constraint failed: T_PRODUCT_CHECKOUT_LOCK.AUTH_USER_ID, ...T_PRODUCT_CHECKOUT_LOCK.PRODUCT_ID"
 *   FK 違反      : "FOREIGN KEY constraint failed"（UNIQUE ではない）
 *   他テーブル   : "UNIQUE constraint failed: T_CHECKOUT_ATTEMPT_ITEM.*"（テーブル名が異なる）
 */
export function isLockConflictError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg) && /T_PRODUCT_CHECKOUT_LOCK/i.test(msg);
}

/* ============================================================
 * 型
 * ============================================================ */

/** T_CHECKOUT_ATTEMPT 行 */
export interface AttemptRow {
  ATTEMPT_ID: number;
  OPERATION_ID: string;
  AUTH_USER_ID: string;
  CART_KEY: string;
  BUYER_EMAIL: string;
  STATUS: number;
  /** Stripe create を呼ぶ直前に 1。0+SID=NULL=未試行 / 1+SID=NULL=結果不明（安全側で lock 維持）。 */
  CREATE_ATTEMPTED: number;
  STRIPE_SESSION_ID: string | null;
  TOTAL_AMOUNT: number;
  EXPIRES_AT: string | null;
}

/** T_CHECKOUT_ATTEMPT_ITEM 行（immutable スナップショット） */
export interface AttemptItemRow {
  PRODUCT_ID: number;
  PRODUCT_CODE: string;
  STRIPE_PRICE_ID: string;
  /**
   * 将来の監査用予約列（試行時点の期待額）。現行の購入フロー
   * （create 再現 / CASE C 照合 / line_items 検証 / 付与）では未使用で 0 を許容する。
   * 金額の正本は Stripe Price / Checkout Session（unit_amount / amount_total）。
   */
  EXPECTED_AMOUNT: number;
  SORT_NO: number;
}

/** attempt 準備の入力（precheck 済みの正規化商品） */
export interface PreparedItem {
  product: ProductRow;
  priceId: string;
  amount: number;
}

/* ============================================================
 * attempt の取得
 * ============================================================ */

/** operationId で attempt を取得（無ければ null）。 */
export async function getAttemptByOperationId(
  env: Env,
  operationId: string,
): Promise<AttemptRow | null> {
  const db = getDb(env);
  const row = await db
    .prepare(
      `SELECT ATTEMPT_ID, OPERATION_ID, AUTH_USER_ID, CART_KEY, BUYER_EMAIL, STATUS,
              CREATE_ATTEMPTED, STRIPE_SESSION_ID, TOTAL_AMOUNT, EXPIRES_AT
       FROM T_CHECKOUT_ATTEMPT WHERE OPERATION_ID = ?`,
    )
    .bind(operationId)
    .first<AttemptRow>();
  return row ?? null;
}

/** attempt の item スナップショットを SORT_NO 昇順で取得。 */
export async function getAttemptItems(env: Env, attemptId: number): Promise<AttemptItemRow[]> {
  const db = getDb(env);
  const res = await db
    .prepare(
      `SELECT PRODUCT_ID, PRODUCT_CODE, STRIPE_PRICE_ID, EXPECTED_AMOUNT, SORT_NO
       FROM T_CHECKOUT_ATTEMPT_ITEM WHERE ATTEMPT_ID = ? ORDER BY SORT_NO ASC`,
    )
    .bind(attemptId)
    .all<AttemptItemRow>();
  return res.results ?? [];
}

/**
 * fulfill 用: Session に紐づく attempt の item snapshot から Price ID → PRODUCT_CODE の逆引き Map を構築する。
 *
 * Price ID の正本は「その Checkout 開始時に保存した snapshot（T_CHECKOUT_ATTEMPT_ITEM.STRIPE_PRICE_ID）」。
 * これにより、Checkout 開始後に運用者が M_PRODUCT.STRIPE_PRICE_ID を変更しても、旧 Session の line item price を
 * snapshot から正しく商品コードへ解決でき、決済済み Session を正常に fulfill できる（unknown price id を防ぐ）。
 *
 * 特定順:
 *   1. STRIPE_SESSION_ID 一致で attempt を特定（SID 保存済みの通常ケース）
 *   2. operationId（client_reference_id）一致で特定（SID 未保存段階の Webpook / CASE C）
 * どちらでも特定できない場合は null を返す（呼出側で「現在の M_PRODUCT へ無条件 fallback しない」を判断）。
 *
 * @returns snapshot 由来の Price→code Map。attempt を特定できなければ null。
 */
/**
 * fulfill 用の Price snapshot 解決結果。
 * - resolved  : attempt を特定でき、snapshot から Price→code Map を構築できた（Map を使う）。
 * - not_found : SID / operationId のどちらでも attempt を特定できなかった（＝新方式 snapshot が無い）。
 *               呼出側はこの場合に限り、限定的に現在の M_PRODUCT 逆引きへ fallback してよい。
 * - invalid   : attempt は特定できたが snapshot が不正（item なし / 空 Price / 同一 Price 重複割当）。
 *               この場合は fallback せず安全側でエラーにする（決済済みでも権限付与しない）。
 */
export type AttemptPriceMapResult =
  | { status: "resolved"; map: Map<string, string> }
  | { status: "not_found" }
  | { status: "invalid"; detail: string };

/**
 * Session に紐づく attempt の item snapshot から Price ID → PRODUCT_CODE の逆引き Map を構築する。
 *
 * Price ID の正本は「その Checkout 開始時に保存した snapshot（T_CHECKOUT_ATTEMPT_ITEM.STRIPE_PRICE_ID）」。
 * これにより、Checkout 開始後に運用者が M_PRODUCT.STRIPE_PRICE_ID を変更しても、旧 Session の line item price を
 * snapshot から正しく商品コードへ解決でき、決済済み Session を正常に fulfill できる（unknown price id を防ぐ）。
 *
 * attempt 特定順:
 *   1. STRIPE_SESSION_ID 一致（SID 保存済みの通常ケース）
 *   2. operationId（client_reference_id）一致（SID 未保存段階の Webhook / CASE C）
 *
 * 戻り値は AttemptPriceMapResult（resolved / not_found / invalid）。
 * attempt を特定できた以上、その snapshot の欠損・不一致は invalid（安全側エラー）として扱い、
 * 現在の M_PRODUCT へ fallback しない。fallback は not_found（attempt 自体が無い）に限る。
 */
export async function buildPriceIdToCodeMapFromAttempt(
  env: Env,
  sessionId: string,
  operationId: string | null,
): Promise<AttemptPriceMapResult> {
  const db = getDb(env);
  let attemptId: number | null = null;

  const bySid = await db
    .prepare("SELECT ATTEMPT_ID FROM T_CHECKOUT_ATTEMPT WHERE STRIPE_SESSION_ID = ?")
    .bind(sessionId)
    .first<{ ATTEMPT_ID: number }>();
  if (bySid) {
    attemptId = bySid.ATTEMPT_ID;
  } else if (operationId) {
    const byOp = await getAttemptByOperationId(env, operationId);
    if (byOp) attemptId = byOp.ATTEMPT_ID;
  }
  if (attemptId === null) return { status: "not_found" }; // attempt 特定不能＝限定 fallback 許可

  // ここから先は attempt が存在する。snapshot が不正なら invalid（fallback せず安全側エラー）。
  const items = await getAttemptItems(env, attemptId);
  if (items.length === 0) {
    return { status: "invalid", detail: "attempt has no item snapshot" };
  }

  const map = new Map<string, string>();
  for (const it of items) {
    if (!it.STRIPE_PRICE_ID) {
      return { status: "invalid", detail: `attempt item has empty price snapshot: ${it.PRODUCT_CODE}` };
    }
    const existing = map.get(it.STRIPE_PRICE_ID);
    if (existing && existing !== it.PRODUCT_CODE) {
      return {
        status: "invalid",
        detail: `price id assigned to multiple products in snapshot: ${existing}, ${it.PRODUCT_CODE}`,
      };
    }
    map.set(it.STRIPE_PRICE_ID, it.PRODUCT_CODE);
  }
  return { status: "resolved", map };
}

/* ============================================================
 * 新規 attempt 作成（attempt + item + cart 全 lock を 1 batch・全 or 無）
 * ============================================================ */

/**
 * 新規 attempt を作成し、cart 全商品の lock を 1 batch で取得する。
 * lock は素 INSERT（ON CONFLICT なし）のため、1 件でも PK 競合したら batch 全体が rollback される
 * （部分ロックを残さない）。競合時は ALREADY_IN_PROGRESS を投げる。
 *
 * @throws AppError ALREADY_IN_PROGRESS(409) 競合（別 attempt が商品を保持）
 */
export async function createAttemptWithLocks(
  env: Env,
  params: {
    operationId: string;
    authUserId: string;
    cartKey: string;
    buyerEmail: string;
    totalAmount: number;
    items: PreparedItem[];
  },
): Promise<AttemptRow> {
  const db = getDb(env);
  const now = nowIso();

  const stmts: D1PreparedStatement[] = [];

  // 1. attempt ヘッダ（CREATING）
  stmts.push(
    db
      .prepare(
        `INSERT INTO T_CHECKOUT_ATTEMPT
           (OPERATION_ID, AUTH_USER_ID, CART_KEY, BUYER_EMAIL, STATUS, TOTAL_AMOUNT, DEL_FLG, CREATE_DATE, UPDATE_DATE)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        params.operationId,
        params.authUserId,
        params.cartKey,
        params.buyerEmail,
        ATTEMPT_STATUS.CREATING,
        params.totalAmount,
        now,
        now,
      ),
  );

  // ATTEMPT_ID は last_insert_rowid を使わず OPERATION_ID サブクエリで参照（ADR-008 パターン）。
  const attemptIdSub = "(SELECT ATTEMPT_ID FROM T_CHECKOUT_ATTEMPT WHERE OPERATION_ID = ?)";

  // 2. item スナップショット（SORT_NO はサーバー確定順）
  let sortNo = 0;
  for (const it of params.items) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO T_CHECKOUT_ATTEMPT_ITEM
             (ATTEMPT_ID, PRODUCT_ID, PRODUCT_CODE, STRIPE_PRICE_ID, EXPECTED_AMOUNT, SORT_NO, CREATE_DATE)
           VALUES (${attemptIdSub}, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          params.operationId,
          it.product.PRODUCT_ID,
          it.product.PRODUCT_CODE,
          it.priceId,
          it.amount,
          sortNo++,
          now,
        ),
    );
  }

  // 3. cart 全 lock（素 INSERT・ON CONFLICT なし → PK 競合で batch 全 rollback）
  for (const it of params.items) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO T_PRODUCT_CHECKOUT_LOCK (AUTH_USER_ID, PRODUCT_ID, ATTEMPT_ID, CREATE_DATE)
           VALUES (?, ?, ${attemptIdSub}, ?)`,
        )
        .bind(params.authUserId, it.product.PRODUCT_ID, params.operationId, now),
    );
  }

  try {
    await db.batch(stmts);
  } catch (e) {
    // batch 失敗は全 rollback 済み（部分ロックは残らない）。原子性は維持される。
    // ただし失敗要因を分類する:
    //   T_PRODUCT_CHECKOUT_LOCK の PK/UNIQUE 競合 = 別試行が進行中 → ALREADY_IN_PROGRESS(409)
    //   それ以外（D1 障害・SQL エラー・FK 違反・他 constraint・想定外）→ INTERNAL_ERROR(500)
    if (isLockConflictError(e)) {
      throw new AppError(
        "ALREADY_IN_PROGRESS",
        "同じ商品の購入手続きが進行中です。しばらくしてからお試しください。",
        409,
      );
    }
    console.error(
      "[checkout] createAttemptWithLocks batch failed (non-lock):",
      e instanceof Error ? e.message : String(e),
    );
    throw new AppError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }

  const created = await getAttemptByOperationId(env, params.operationId);
  if (!created) {
    // batch は成功したのに読み戻せない = 内部不整合
    throw new AppError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
  return created;
}

/* ============================================================
 * 既存 attempt の lock 完備確認（再送分岐）
 * ============================================================ */

/**
 * 既存 attempt が cart 全商品の lock を保持しているか確認する。
 * batch 原子性により通常は完備しているが、安全のため確認する。
 */
export async function attemptHoldsAllLocks(
  env: Env,
  attemptId: number,
  productIds: number[],
): Promise<boolean> {
  const db = getDb(env);
  const res = await db
    .prepare("SELECT PRODUCT_ID FROM T_PRODUCT_CHECKOUT_LOCK WHERE ATTEMPT_ID = ?")
    .bind(attemptId)
    .all<{ PRODUCT_ID: number }>();
  const held = new Set((res.results ?? []).map((r) => r.PRODUCT_ID));
  return productIds.every((pid) => held.has(pid));
}

/**
 * 指定ユーザーについて、与えられた PRODUCT_ID のいずれかを lock で保持している
 * 「未完了（OPEN=1 / CREATING=0）の attempt」を1件返す（無ければ null）。
 *
 * 用途: 購入再開始フロー。別 operationId の残存 Checkout（ブラウザバック等で OPEN のまま
 * 残った attempt）を検出し、409 で即失敗させる代わりにユーザー確認 → 安全終了へ導くため。
 * 商品構成が一部でも重複していれば「旧 Checkout 全体を終了して作り直す」方針（部分再利用しない）
 * のため、いずれかの PRODUCT_ID を保持する attempt を対象にする。
 * excludeOperationId を渡すと、その operationId の attempt は対象から除外する（同一操作の再送を除く）。
 */
export async function findActiveAttemptHoldingAnyProduct(
  env: Env,
  authUserId: string,
  productIds: number[],
  excludeOperationId?: string,
): Promise<AttemptRow | null> {
  if (productIds.length === 0) return null;
  const db = getDb(env);
  const placeholders = productIds.map(() => "?").join(",");
  // exclude は SQL 側で行う（LIMIT の前に除外しないと、除外対象が並び順の先頭に来た場合に
  // 別の active 候補を見逃す）。カートは複数商品を含み得るため、商品ごとに別 attempt が
  // 保持している状況（候補が複数）も起こり得る点に注意。
  const excludeClause = excludeOperationId ? "AND a.OPERATION_ID <> ?" : "";
  // lock(AUTH_USER_ID, PRODUCT_ID) → ATTEMPT_ID → 未完了 attempt。
  // 同一ユーザーの lock のみを見る（他ユーザーの lock は AUTH_USER_ID で除外）。
  const stmt = db.prepare(
    `SELECT a.ATTEMPT_ID, a.OPERATION_ID, a.AUTH_USER_ID, a.CART_KEY, a.BUYER_EMAIL, a.STATUS,
            a.CREATE_ATTEMPTED, a.STRIPE_SESSION_ID, a.TOTAL_AMOUNT, a.EXPIRES_AT
     FROM T_PRODUCT_CHECKOUT_LOCK l
     JOIN T_CHECKOUT_ATTEMPT a ON a.ATTEMPT_ID = l.ATTEMPT_ID
     WHERE l.AUTH_USER_ID = ?
       AND l.PRODUCT_ID IN (${placeholders})
       AND a.STATUS IN (${ATTEMPT_STATUS.CREATING}, ${ATTEMPT_STATUS.OPEN})
       ${excludeClause}
     ORDER BY a.ATTEMPT_ID ASC
     LIMIT 1`,
  );
  const binds = excludeOperationId
    ? [authUserId, ...productIds, excludeOperationId]
    : [authUserId, ...productIds];
  const row = await stmt.bind(...binds).first<AttemptRow>();
  return row ?? null;
}

/**
 * 指定ユーザーについて、与えられた PRODUCT_ID のいずれかを lock で保持している
 * 「未完了（OPEN=1 / CREATING=0）の attempt」を **すべて** 返す（重複は attempt 単位で一意化）。
 *
 * カートは複数商品を含み得るため、商品ごとに別 attempt が保持している状況では候補が複数になる。
 * 単数版（findActiveAttemptHoldingAnyProduct）は 1 件しか返さないため、残った別 attempt の lock で
 * 後続の createAttemptWithLocks が ALREADY_IN_PROGRESS になり得る。再開始フローでは重複する
 * 旧 attempt を漏れなく把握して settle する必要があるため、この複数版を使う。
 * 1 つの attempt が複数商品を保持していても、DISTINCT により 1 件にまとまる。
 * excludeOperationId を渡すと、その operationId の attempt は対象から除外する。
 */
/**
 * 指定ユーザーの未完了（CREATING/OPEN）attempt をすべて取得する（商品非依存・operationId 不要）。
 *
 * 用途: STORE 表示時の状態同期。AUTH_USER_ID（認証情報から取得）を基準に、別端末で開始した
 * 購入手続きも含めて発見する。lock ではなく T_CHECKOUT_ATTEMPT を直接引く（lock を持たない
 * CREATING 段階も拾うため）。ATTEMPT_ID 昇順（＝開始順）で返す。最新判定は呼び出し側で末尾を採用。
 */
export async function getActiveAttemptsForUser(
  env: Env,
  authUserId: string,
): Promise<AttemptRow[]> {
  const db = getDb(env);
  const res = await db
    .prepare(
      `SELECT a.ATTEMPT_ID, a.OPERATION_ID, a.AUTH_USER_ID, a.CART_KEY, a.BUYER_EMAIL, a.STATUS,
              a.CREATE_ATTEMPTED, a.STRIPE_SESSION_ID, a.TOTAL_AMOUNT, a.EXPIRES_AT
       FROM T_CHECKOUT_ATTEMPT a
       WHERE a.AUTH_USER_ID = ?
         AND a.STATUS IN (${ATTEMPT_STATUS.CREATING}, ${ATTEMPT_STATUS.OPEN})
       ORDER BY a.ATTEMPT_ID ASC`,
    )
    .bind(authUserId)
    .all<AttemptRow>();
  return res.results ?? [];
}

export async function findActiveAttemptsHoldingAnyProduct(
  env: Env,
  authUserId: string,
  productIds: number[],
  excludeOperationId?: string,
): Promise<AttemptRow[]> {
  if (productIds.length === 0) return [];
  const db = getDb(env);
  const placeholders = productIds.map(() => "?").join(",");
  const excludeClause = excludeOperationId ? "AND a.OPERATION_ID <> ?" : "";
  const stmt = db.prepare(
    `SELECT DISTINCT a.ATTEMPT_ID, a.OPERATION_ID, a.AUTH_USER_ID, a.CART_KEY, a.BUYER_EMAIL, a.STATUS,
            a.CREATE_ATTEMPTED, a.STRIPE_SESSION_ID, a.TOTAL_AMOUNT, a.EXPIRES_AT
     FROM T_PRODUCT_CHECKOUT_LOCK l
     JOIN T_CHECKOUT_ATTEMPT a ON a.ATTEMPT_ID = l.ATTEMPT_ID
     WHERE l.AUTH_USER_ID = ?
       AND l.PRODUCT_ID IN (${placeholders})
       AND a.STATUS IN (${ATTEMPT_STATUS.CREATING}, ${ATTEMPT_STATUS.OPEN})
       ${excludeClause}
     ORDER BY a.ATTEMPT_ID ASC`,
  );
  const binds = excludeOperationId
    ? [authUserId, ...productIds, excludeOperationId]
    : [authUserId, ...productIds];
  const res = await stmt.bind(...binds).all<AttemptRow>();
  return res.results ?? [];
}

/* ============================================================
 * attempt 状態遷移 / lock 解放
 * ============================================================ */

/** attempt を指定状態へ更新（任意で STRIPE_SESSION_ID / EXPIRES_AT を保存）。 */
export async function updateAttemptStatus(
  env: Env,
  attemptId: number,
  status: number,
  fields?: { stripeSessionId?: string; expiresAt?: string | null },
): Promise<void> {
  const db = getDb(env);
  const now = nowIso();
  if (fields?.stripeSessionId !== undefined) {
    await db
      .prepare(
        `UPDATE T_CHECKOUT_ATTEMPT
           SET STATUS = ?, STRIPE_SESSION_ID = ?, EXPIRES_AT = ?, UPDATE_DATE = ?
         WHERE ATTEMPT_ID = ?`,
      )
      .bind(status, fields.stripeSessionId, fields.expiresAt ?? null, now, attemptId)
      .run();
  } else {
    await db
      .prepare("UPDATE T_CHECKOUT_ATTEMPT SET STATUS = ?, UPDATE_DATE = ? WHERE ATTEMPT_ID = ?")
      .bind(status, now, attemptId)
      .run();
  }
}

/** 指定 attempt の全 lock を解放する（DELETE）。 */
export async function releaseLocksForAttempt(env: Env, attemptId: number): Promise<void> {
  const db = getDb(env);
  await db
    .prepare("DELETE FROM T_PRODUCT_CHECKOUT_LOCK WHERE ATTEMPT_ID = ?")
    .bind(attemptId)
    .run();
}

/**
 * Stripe create を呼ぶ「直前」に CREATE_ATTEMPTED=1 を確定する。
 * これにより、以降 SID=NULL のままでも「create を試みた（結果不明）」と判別でき、
 * cancel だけを理由に lock を解放しない安全側の判断が可能になる。
 */
export async function markCreateAttempted(env: Env, attemptId: number): Promise<void> {
  const db = getDb(env);
  const now = nowIso();
  await db
    .prepare("UPDATE T_CHECKOUT_ATTEMPT SET CREATE_ATTEMPTED = 1, UPDATE_DATE = ? WHERE ATTEMPT_ID = ?")
    .bind(now, attemptId)
    .run();
}

/**
 * create 結果が不明な状態か判定する。
 * SID=NULL かつ CREATE_ATTEMPTED=1 の場合、Stripe create を試みたが結果を DB で確定できておらず、
 * Session が存在する可能性がある。この状態では cancel だけを理由に lock を解放してはいけない。
 * （SID=NULL かつ CREATE_ATTEMPTED=0 は create 未試行が確定＝解放してよい）
 */
export function isCreateResultIndeterminate(attempt: {
  STRIPE_SESSION_ID: string | null;
  CREATE_ATTEMPTED: number;
}): boolean {
  return !attempt.STRIPE_SESSION_ID && attempt.CREATE_ATTEMPTED === 1;
}

/**
 * attempt を PAID にし、STRIPE_SESSION_ID を回収（保存）しつつ lock を解放する。
 * CASE C（SID 保存失敗）で Webhook から operationId 経由で回収する際に使用する。
 */
export async function markAttemptPaidWithSession(
  env: Env,
  attemptId: number,
  sessionId: string,
): Promise<void> {
  await updateAttemptStatus(env, attemptId, ATTEMPT_STATUS.PAID, { stripeSessionId: sessionId });
  await releaseLocksForAttempt(env, attemptId);
}

/** attempt を CANCELLED にし lock を解放する（確定失敗 A / cancel）。 */
export async function cancelAttempt(env: Env, attemptId: number): Promise<void> {
  await updateAttemptStatus(env, attemptId, ATTEMPT_STATUS.CANCELLED);
  await releaseLocksForAttempt(env, attemptId);
}

/** attempt を EXPIRED にし lock を解放する。 */
export async function expireAttempt(env: Env, attemptId: number): Promise<void> {
  await updateAttemptStatus(env, attemptId, ATTEMPT_STATUS.EXPIRED);
  await releaseLocksForAttempt(env, attemptId);
}

/** attempt を PAID にし lock を解放する（fulfill 成立時）。 */
export async function markAttemptPaid(env: Env, attemptId: number): Promise<void> {
  await updateAttemptStatus(env, attemptId, ATTEMPT_STATUS.PAID);
  await releaseLocksForAttempt(env, attemptId);
}

/* ============================================================
 * Stripe create パラメータの DB からの完全再現
 * ============================================================ */

/** Checkout create に渡すパラメータ（DB snapshot から決定的に再構築）。 */
export interface RebuiltCreateParams {
  idempotencyKey: string;
  customerEmail: string;
  lineItems: { price: string; quantity: 1 }[];
  metadata: { auth_user_id: string; product_codes: string };
  clientReferenceId: string;
  successUrl: string;
  cancelUrl: string;
}

/**
 * attempt + item スナップショットから Stripe create パラメータを完全再現する。
 * 実行時の auth.email / resolvePriceId / 時刻を使わず、DB の値のみを用いる。
 * success_url / cancel_url は固定 origin + operationId から決定的に構築する
 * （cancel_url は {CHECKOUT_SESSION_ID} 非依存。success_url は Stripe 公式テンプレートを使用）。
 */
export async function rebuildCreateParams(
  env: Env,
  attempt: AttemptRow,
  origin: string,
): Promise<RebuiltCreateParams> {
  const items = await getAttemptItems(env, attempt.ATTEMPT_ID);
  if (items.length === 0) {
    throw new AppError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
  const lineItems = items.map((it) => ({ price: it.STRIPE_PRICE_ID, quantity: 1 as const }));
  const productCodesCsv = items.map((it) => it.PRODUCT_CODE).join(",");
  const op = encodeURIComponent(attempt.OPERATION_ID);
  return {
    idempotencyKey: buildIdempotencyKey(attempt.AUTH_USER_ID, attempt.OPERATION_ID),
    customerEmail: attempt.BUYER_EMAIL,
    lineItems,
    metadata: { auth_user_id: attempt.AUTH_USER_ID, product_codes: productCodesCsv },
    clientReferenceId: attempt.OPERATION_ID,
    successUrl: `${origin}/purchase/success/?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/purchase/cancel/?operation_id=${op}`,
  };
}

/* ============================================================
 * 二重 paid 検出（fulfill 前の保険）
 * ============================================================ */

/**
 * 付与対象商品について、別注文で既に paid 済み T_PURCHASE が存在するか判定する。
 * 存在すれば二重 paid（同一商品を別 Session/別注文で 2 回支払い）。
 *
 * @param currentSessionId 今回処理中の Session ID（自分の注文は除外）
 * @returns 二重が検出された PRODUCT_ID の配列（空なら二重なし）
 */
export async function detectDuplicatePaidProductIds(
  env: Env,
  authUserId: string,
  productIds: number[],
  currentSessionId: string,
): Promise<number[]> {
  const db = getDb(env);
  const dup: number[] = [];
  for (const pid of productIds) {
    const row = await db
      .prepare(
        `SELECT p.PURCHASE_ID
         FROM T_PURCHASE p
         JOIN T_ORDER o ON o.ORDER_ID = p.ORDER_ID
         WHERE p.AUTH_USER_ID = ? AND p.PRODUCT_ID = ? AND p.PAYMENT_STATUS = 1 AND p.DEL_FLG = 0
           AND o.PURCHASE_SOURCE = ? AND o.EXTERNAL_ORDER_ID <> ?
         LIMIT 1`,
      )
      .bind(authUserId, pid, PURCHASE_SOURCE_STRIPE, currentSessionId)
      .first<{ PURCHASE_ID: number }>();
    if (row) dup.push(pid);
  }
  return dup;
}

/* ============================================================
 * T_PAYMENT_EVENT 記録
 * ============================================================ */

/** 決済運用イベントを記録する（event.id があれば冪等・二重記録防止）。 */
export async function recordPaymentEvent(
  env: Env,
  ev: {
    eventType: number;
    authUserId?: string | null;
    orderId?: number | null;
    stripeSessionId?: string | null;
    paymentIntentId?: string | null;
    stripeObjectId?: string | null;
    stripeEventId?: string | null;
    stripeRequestId?: string | null;
    status?: string | null;
    amount?: number | null;
    detail?: string | null;
  },
): Promise<void> {
  const db = getDb(env);
  const now = nowIso();
  try {
    await db
      .prepare(
        `INSERT INTO T_PAYMENT_EVENT
           (EVENT_TYPE, AUTH_USER_ID, ORDER_ID, STRIPE_SESSION_ID, PAYMENT_INTENT_ID,
            STRIPE_OBJECT_ID, STRIPE_EVENT_ID, STRIPE_REQUEST_ID, STATUS, AMOUNT, DETAIL,
            DEL_FLG, CREATE_DATE, UPDATE_DATE)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        ev.eventType,
        ev.authUserId ?? null,
        ev.orderId ?? null,
        ev.stripeSessionId ?? null,
        ev.paymentIntentId ?? null,
        ev.stripeObjectId ?? null,
        ev.stripeEventId ?? null,
        ev.stripeRequestId ?? null,
        ev.status ?? null,
        ev.amount ?? null,
        ev.detail ?? null,
        now,
        now,
      )
      .run();
  } catch (e) {
    // UX_PAYEVENT_STRIPE_EVENT（event.id 一意）による二重記録は握りつぶす（冪等）。
    // それ以外の失敗はログのみ（運用記録の失敗で本処理を妨げない）。
    console.error("[payment_event] insert skipped/failed:", e instanceof Error ? e.message : String(e));
  }
}

/* ============================================================
 * precheck 済み商品から PreparedItem を構築（Checkout 開始で使用）
 * ============================================================ */

/**
 * SORT_NO 正規化済み商品 + Price 解決から PreparedItem[] を作る。
 * amount（→ EXPECTED_AMOUNT）は将来の監査用予約値。現行フローでは呼出側が amountByCode を
 * 渡さないため 0 になり、購入可否・fulfillment・金額照合には使用しない（0 を許容）。
 * 金額の正本は Stripe Price / Checkout Session（unit_amount / amount_total）で、Webhook 側で照合する。
 * 将来「試行時点の期待額スナップショット／期待額と実決済額の監査」が必要になった場合に、
 * Stripe Price API 取得を含めて amountByCode を渡す形で正式実装する。
 */
export function buildPreparedItems(
  products: ProductRow[],
  priceIdByCode: Map<string, string>,
  amountByCode?: Map<string, number>,
): PreparedItem[] {
  return products.map((p) => {
    const priceId = priceIdByCode.get(p.PRODUCT_CODE);
    if (!priceId) {
      throw new AppError("PRODUCT_NOT_SELLABLE", "現在購入できない商品が含まれています。", 409);
    }
    return {
      product: p,
      priceId,
      amount: amountByCode?.get(p.PRODUCT_CODE) ?? 0,
    };
  });
}
