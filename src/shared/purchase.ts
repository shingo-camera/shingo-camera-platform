/**
 * 購入系共通ロジック
 *
 * - Checkout Session 作成の前提確認（ユーザー有効・商品存在・販売可否・二重購入防止・依存条件）
 * - 特定商品の available 判定（status 用）
 * - Price ID の解決（PRODUCT_CODE → Price ID）と逆引き（Price ID → PRODUCT_CODE）
 * - Webhook 受信時の T_ORDER / T_PURCHASE / T_USER_PRODUCT への反映（D1 batch・原子的・冪等）
 *
 * 設計根拠: api/PURCHASE_API.md, api/DATABASE.md, api/API.md 8/9, adr/ADR-007, adr/ADR-008
 *
 * 複数商品 Checkout（WORK-011）:
 * - 1 回の Stripe Checkout で複数の買い切り商品をまとめて購入できる。
 * - 注文（T_ORDER）と購入明細（T_PURCHASE）と権限（T_USER_PRODUCT）を分離する。
 * - 権限付与の正本は署名検証済み Webhook のみ（完了画面から付与しない）。
 * - 権限付与対象商品は Stripe から再取得した実 line_items の Price ID 逆引きを正本とする
 *   （metadata の商品コードは監査用途で正本にしない）。
 *
 * D1 batch の原子性（adr/ADR-008）:
 * - db.batch() は各文を順次・非並行で実行し、途中の文が失敗するとシーケンス全体を
 *   ロールバックする（Local D1 実測で確認済み）。この原子性を用いて、
 *   T_ORDER 1 件 + T_PURCHASE N 件 + T_USER_PRODUCT N 件 を全件成立/全件ロールバックで反映する。
 * - 複数明細では last_insert_rowid() を使わない（どの T_PURCHASE の ID かを安全に判定できないため）。
 *   ORDER_ID は (PURCHASE_SOURCE, EXTERNAL_ORDER_ID) から、PURCHASE_ID は (ORDER_ID, PRODUCT_ID)
 *   から後続 SQL で参照する（同一 batch 内で先行 INSERT 行を参照できることを実測で確認済み）。
 */

import { getDb } from "./db";
import { nowIso } from "./datetime";
import { getMUser } from "./account";
import { getActiveProductByCode, type ProductRow } from "./entitlement";
import { AppError } from "./errors";
import type { Env } from "../index";

/** 買い切りの終了日時（JST） */
const FOREVER_END = "9999-12-31T23:59:59+09:00";

/** T_PURCHASE / T_ORDER.PURCHASE_SOURCE: Stripe */
export const PURCHASE_SOURCE_STRIPE = 0;
/** T_PURCHASE / T_ORDER.PAYMENT_STATUS: 支払済 */
const PAYMENT_STATUS_PAID = 1;
/** T_USER_PRODUCT.GRANT_TYPE: 購入 */
const GRANT_TYPE_PURCHASE = 0;

/** ISO 文字列を時刻数値へ（不正は NaN） */
function toTime(iso: string): number {
  return new Date(iso).getTime();
}

/* ============================================================
 * Price ID の解決 / 逆引き
 * ============================================================ */

/**
 * 各商品の期待 Price ID をサーバー側 env（Cloudflare Secret）から解決する。
 * Price ID はソースにハードコードせず、Secret のみを正とする。
 * 商品追加時はここに case を追加する（新 SETTING_KEY は使わない）。
 *
 * @returns Price ID、未設定・未対応商品は undefined
 */
export function resolvePriceId(env: Env, productCode: string): string | undefined {
  switch (productCode) {
    case "SUN_AND_MOON":
      return env.STRIPE_PRICE_SUN_AND_MOON;
    case "HANABI":
      return env.STRIPE_PRICE_HANABI;
    case "HANABI_GOOGLE_EARTH":
      return env.STRIPE_PRICE_HANABI_GOOGLE_EARTH;
    default:
      return undefined;
  }
}

/** Price 設定の重複（同一 Price ID が複数商品へ割当）を表す内部エラー。 */
export class PriceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceConfigError";
  }
}

/** サーバーが把握する全商品コード（Price 逆引き Map 構築の対象）。 */
const KNOWN_PRODUCT_CODES = ["SUN_AND_MOON", "HANABI", "HANABI_GOOGLE_EARTH"] as const;

/**
 * Price ID → PRODUCT_CODE の逆引き Map を env の Secret から構築する。
 * - 未設定（Secret 空）の商品は Map に含めない。
 * - 同一 Price ID が複数商品へ割り当てられている場合は、安全側で設定エラーとして例外を投げる
 *   （どの商品として付与すべきか一意に定まらないため、購入・権限付与しない）。
 *
 * @throws PriceConfigError 同一 Price ID が複数商品に割り当てられているとき
 */
export function buildPriceIdToCodeMap(env: Env): Map<string, string> {
  const map = new Map<string, string>();
  for (const code of KNOWN_PRODUCT_CODES) {
    const priceId = resolvePriceId(env, code);
    if (!priceId) continue; // 未設定はスキップ（販売準備中）
    const existing = map.get(priceId);
    if (existing && existing !== code) {
      throw new PriceConfigError(
        `price id is assigned to multiple products: ${existing} and ${code}`,
      );
    }
    map.set(priceId, code);
  }
  return map;
}

/* ============================================================
 * available 判定
 * ============================================================ */

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

  const user = await getMUser(env, authUserId);
  if (!user || user.STATUS !== 1 || user.DEL_FLG !== 0) return false;

  const product = await getActiveProductByCode(env, productCode);
  if (!product) return false;

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

/* ============================================================
 * 商品依存条件（HANABI_GOOGLE_EARTH ← HANABI）
 * ============================================================ */

/** 追加機能商品 → 前提となる本体商品コードの対応表。 */
const PRODUCT_DEPENDENCIES: Record<string, string> = {
  HANABI_GOOGLE_EARTH: "HANABI",
};

/**
 * 依存商品の購入可否を検証する（バックエンド必須。UI 依存にしない）。
 * 追加機能商品は「前提商品を既に保有」または「同一注文に前提商品を含む」ときのみ購入可。
 *
 * @param env 環境
 * @param authUserId 認証済みユーザー
 * @param requestedCodes 今回の注文に含まれる商品コード集合
 * @throws AppError DEPENDENCY_REQUIRED(409) 依存前提を満たさないとき
 */
export async function checkProductDependencies(
  env: Env,
  authUserId: string,
  requestedCodes: string[],
): Promise<void> {
  const requested = new Set(requestedCodes);
  for (const code of requestedCodes) {
    const requires = PRODUCT_DEPENDENCIES[code];
    if (!requires) continue;
    // 同一注文に前提商品が含まれるなら OK
    if (requested.has(requires)) continue;
    // 既に前提商品を保有しているなら OK
    const hasBase = await isProductAvailable(env, authUserId, requires);
    if (hasBase) continue;
    throw new AppError(
      "DEPENDENCY_REQUIRED",
      "この商品は、前提となる商品の購入が必要です。",
      409,
    );
  }
}

/* ============================================================
 * Checkout 前提確認（複数商品）
 * ============================================================ */

/** Checkout 作成の前提確認結果（複数商品・SORT_NO 昇順で正規化済み） */
export interface MultiCheckoutPrecheck {
  /** SORT_NO ASC, PRODUCT_ID ASC で正規化済みの商品行 */
  products: ProductRow[];
  /** 商品コード → 期待 Price ID */
  priceIdByCode: Map<string, string>;
}

/**
 * 複数商品 Checkout の前提を確認し、正規化済み商品と Price ID を返す。
 *
 * 検証（api/PURCHASE_API.md）:
 * 1. M_USER 有効（停止・退会・仮登録は不可）
 * 2. 各 PRODUCT_CODE が M_PRODUCT に存在（有効商品）
 * 3. 各商品が販売対象（Stripe Price Secret が設定済み）
 * 4. 二重購入防止（既に available な商品を含めない）
 * 5. 依存条件（EARTH ← HANABI）
 * 6. M_PRODUCT.SORT_NO ASC, PRODUCT_ID ASC で決定的に正規化
 *
 * 呼出前提: productCodes は「配列・非空・重複なし」を呼出側で検証済み。
 *
 * @throws AppError USER_SUSPENDED(403) / PRODUCT_NOT_FOUND(404) /
 *   PRODUCT_NOT_SELLABLE(409) / ALREADY_PURCHASED(409) / DEPENDENCY_REQUIRED(409)
 */
export async function precheckMultiCheckout(
  env: Env,
  authUserId: string,
  productCodes: string[],
): Promise<MultiCheckoutPrecheck> {
  // 1. M_USER 有効
  const user = await getMUser(env, authUserId);
  if (!user || user.STATUS !== 1 || user.DEL_FLG !== 0) {
    throw new AppError("USER_SUSPENDED", "このアカウントは現在利用できません。", 403);
  }

  const products: ProductRow[] = [];
  const priceIdByCode = new Map<string, string>();

  for (const code of productCodes) {
    // 2. 商品存在（有効商品）
    const product = await getActiveProductByCode(env, code);
    if (!product) {
      throw new AppError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
    }
    // 3. 販売対象（Price 設定済み）
    const priceId = resolvePriceId(env, code);
    if (!priceId) {
      throw new AppError("PRODUCT_NOT_SELLABLE", "現在購入できない商品が含まれています。", 409);
    }
    // 4. 二重購入防止
    const available = await isProductAvailable(env, authUserId, code);
    if (available) {
      throw new AppError("ALREADY_PURCHASED", "既に利用可能な商品が含まれています。", 409);
    }
    products.push(product);
    priceIdByCode.set(code, priceId);
  }

  // 5. 依存条件（EARTH ← HANABI）
  await checkProductDependencies(env, authUserId, productCodes);

  // 6. SORT_NO ASC, PRODUCT_ID ASC で決定的に正規化（API の配列順は正本にしない）
  products.sort((a, b) => (a.SORT_NO - b.SORT_NO) || (a.PRODUCT_ID - b.PRODUCT_ID));

  return { products, priceIdByCode };
}

/* ============================================================
 * Webhook 反映（複数商品・原子的・冪等）
 * ============================================================ */

/** Webhook 反映の 1 明細（検証済み値） */
export interface FulfillItem {
  productCode: string;
  productId: number;
  /** 当該商品の購入時点金額（Stripe unit_amount） */
  amount: number;
}

/** Webhook 反映の入力（検証済み値・注文単位） */
export interface FulfillOrderInput {
  authUserId: string;
  sessionId: string;
  /** 注文合計（Stripe amount_total。各明細 amount の合計と一致） */
  totalAmount: number;
  purchaseDate: string; // JST ISO
  /** 付与対象の明細（Price 逆引きで確定済み・1 件以上） */
  items: FulfillItem[];
  /**
   * Stripe PaymentIntent ID（payment mode。refund/dispute イベントからの逆引きに使用）。
   * 取得できない場合は undefined（T_ORDER.PAYMENT_INTENT_ID は NULL）。
   */
  paymentIntentId?: string | null;
}

/** Webhook 反映の結果 */
export interface FulfillResult {
  /** 既に処理済み（冪等スキップ） */
  alreadyProcessed: boolean;
}

/**
 * Webhook（checkout.session.completed かつ payment_status=paid）の内容を
 * T_ORDER / T_PURCHASE / T_USER_PRODUCT へ原子的に反映する（複数商品対応）。
 *
 * 冪等性:
 * - 注文単位の冪等キーは T_ORDER の UX_T_ORDER_EXTERNAL(PURCHASE_SOURCE, EXTERNAL_ORDER_ID)。
 * - 反映前に同一 Session ID の T_ORDER を確認し、あれば処理済みとして何もせず返す
 *   （batch 成功時は全件成立する設計のため、T_ORDER 存在 = その注文の全 DB 反映済みと扱える）。
 *
 * 原子性・整合性（adr/ADR-008）:
 * - 1 回の db.batch() に T_ORDER INSERT → T_PURCHASE INSERT×N → T_USER_PRODUCT upsert×N を
 *   すべて含める。途中 1 文でも失敗すればシーケンス全体がロールバックする（Local D1 実測で確認）。
 * - last_insert_rowid() は使わない。ORDER_ID は (PURCHASE_SOURCE, EXTERNAL_ORDER_ID) から、
 *   PURCHASE_ID は (ORDER_ID, PRODUCT_ID) から後続 SQL で参照する。
 * - UX_T_PURCHASE_ORDER_PRODUCT(ORDER_ID, PRODUCT_ID) が同一注文内の同一商品二重登録を防ぐ。
 *
 * @throws AppError USER_NOT_FOUND(404) 等（呼出側で内部エラーとして記録）
 */
export async function fulfillMultiCheckout(env: Env, input: FulfillOrderInput): Promise<FulfillResult> {
  const db = getDb(env);
  const now = nowIso();

  // 冪等: 同一 Session ID の T_ORDER が既にあれば処理済み（全件反映済みとみなす）
  const existingOrder = await db
    .prepare(
      "SELECT ORDER_ID FROM T_ORDER WHERE PURCHASE_SOURCE = ? AND EXTERNAL_ORDER_ID = ?",
    )
    .bind(PURCHASE_SOURCE_STRIPE, input.sessionId)
    .first<{ ORDER_ID: number }>();
  if (existingOrder) {
    return { alreadyProcessed: true };
  }

  // AUTH_USER_ID 存在確認
  const user = await getMUser(env, input.authUserId);
  if (!user) {
    throw new AppError("USER_NOT_FOUND", "アカウントが見つかりません。", 404);
  }

  if (input.items.length === 0) {
    // 付与対象なしは不整合（Webhook 側で 1 件以上を保証しているが二重で守る）
    throw new AppError("NO_FULFILL_ITEMS", "処理できませんでした。", 400);
  }

  // 各明細の T_USER_PRODUCT が既存か（INSERT/UPDATE 分岐）を batch 実行前に判定する。
  // 通常は precheck で二重購入を弾くため既存有効行は無い想定だが、
  // 論理削除済み(DEL_FLG=1)残骸や停止行が物理的に存在し得るため、行の有無で分岐する。
  const upExistsByProductId = new Map<number, boolean>();
  for (const item of input.items) {
    const row = await db
      .prepare("SELECT AUTH_USER_ID FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?")
      .bind(input.authUserId, item.productId)
      .first<{ AUTH_USER_ID: string }>();
    upExistsByProductId.set(item.productId, !!row);
  }

  const stmts: D1PreparedStatement[] = [];

  // 1. T_ORDER INSERT（注文ヘッダ 1 行）。PAYMENT_INTENT_ID は refund/dispute 逆引き用。
  stmts.push(
    db
      .prepare(
        `INSERT INTO T_ORDER
           (AUTH_USER_ID, PURCHASE_SOURCE, EXTERNAL_ORDER_ID, PAYMENT_INTENT_ID, ORDER_DATE, TOTAL_AMOUNT,
            PAYMENT_STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        input.authUserId,
        PURCHASE_SOURCE_STRIPE,
        input.sessionId,
        input.paymentIntentId ?? null,
        input.purchaseDate,
        input.totalAmount,
        PAYMENT_STATUS_PAID,
        now,
        now,
      ),
  );

  // 2. 各商品分 T_PURCHASE INSERT。
  //    ORDER_ID は (PURCHASE_SOURCE, EXTERNAL_ORDER_ID) から参照（last_insert_rowid 不使用）。
  //    Stripe 新方式では EXTERNAL_PURCHASE_ID = NULL（Session ID は T_ORDER が保持）。
  for (const item of input.items) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO T_PURCHASE
             (AUTH_USER_ID, PRODUCT_ID, PURCHASE_SOURCE, EXTERNAL_PURCHASE_ID, PURCHASE_DATE,
              AMOUNT, PAYMENT_STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE, ORDER_ID)
           VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, ?,
             (SELECT ORDER_ID FROM T_ORDER WHERE PURCHASE_SOURCE = ? AND EXTERNAL_ORDER_ID = ?))`,
        )
        .bind(
          input.authUserId,
          item.productId,
          PURCHASE_SOURCE_STRIPE,
          input.purchaseDate,
          item.amount,
          PAYMENT_STATUS_PAID,
          now,
          now,
          PURCHASE_SOURCE_STRIPE,
          input.sessionId,
        ),
    );
  }

  // 3. 各商品分 T_USER_PRODUCT INSERT/UPDATE。
  //    PURCHASE_ID は (ORDER_ID, PRODUCT_ID) から参照（UX_T_PURCHASE_ORDER_PRODUCT で 1 件に確定）。
  for (const item of input.items) {
    const exists = upExistsByProductId.get(item.productId) === true;
    const purchaseIdSubquery = `(SELECT PURCHASE_ID FROM T_PURCHASE
         WHERE ORDER_ID = (SELECT ORDER_ID FROM T_ORDER WHERE PURCHASE_SOURCE = ? AND EXTERNAL_ORDER_ID = ?)
           AND PRODUCT_ID = ?)`;
    if (exists) {
      stmts.push(
        db
          .prepare(
            `UPDATE T_USER_PRODUCT
               SET STATUS = 1, START_DATE = ?, END_DATE = ?, GRANT_TYPE = ?,
                   PURCHASE_ID = ${purchaseIdSubquery}, DEL_FLG = 0, UPDATE_DATE = ?
             WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?`,
          )
          .bind(
            input.purchaseDate,
            FOREVER_END,
            GRANT_TYPE_PURCHASE,
            PURCHASE_SOURCE_STRIPE,
            input.sessionId,
            item.productId,
            now,
            input.authUserId,
            item.productId,
          ),
      );
    } else {
      stmts.push(
        db
          .prepare(
            `INSERT INTO T_USER_PRODUCT
               (AUTH_USER_ID, PRODUCT_ID, STATUS, START_DATE, END_DATE, GRANT_TYPE, PURCHASE_ID, DEL_FLG, CREATE_DATE, UPDATE_DATE)
             VALUES (?, ?, 1, ?, ?, ?, ${purchaseIdSubquery}, 0, ?, ?)`,
          )
          .bind(
            input.authUserId,
            item.productId,
            input.purchaseDate,
            FOREVER_END,
            GRANT_TYPE_PURCHASE,
            PURCHASE_SOURCE_STRIPE,
            input.sessionId,
            item.productId,
            now,
            now,
          ),
      );
    }
  }

  // D1 batch で原子的に実行（T_ORDER → T_PURCHASE×N → T_USER_PRODUCT×N）。
  // 途中 1 文でも失敗すればシーケンス全体がロールバックする。
  await db.batch(stmts);

  return { alreadyProcessed: false };
}

/* ============================================================
 * 後方互換: 単品 precheck（既存 spec 互換のため保持。複数版は precheckMultiCheckout）
 * ============================================================ */

/** Checkout 作成の前提確認結果（単品） */
export interface CheckoutPrecheck {
  product: ProductRow;
}

/**
 * 単品 Checkout の前提を確認する（後方互換用）。
 * 複数商品版は precheckMultiCheckout を使用する。
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

  const available = await isProductAvailable(env, authUserId, productCode);
  if (available) {
    throw new AppError("ALREADY_PURCHASED", "この商品は既に利用可能です。", 409);
  }

  return { product };
}
