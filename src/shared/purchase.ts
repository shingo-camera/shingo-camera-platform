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
import { AppError, DependencyRequiredError } from "./errors";
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
 * 販売可否・販売方式の正本は M_PRODUCT の販売専用列（migration 0007）に一本化した。
 *
 * 判定条件（precheckMultiCheckout 参照）:
 *   - STATUS = 1（商品マスタ有効）かつ DEL_FLG = 0
 *   - PURCHASE_ENABLED = 1（販売受付 ON）
 *   - SALE_TYPE = 'ONE_TIME'（現行 Checkout 基盤は買い切りのみ対応。SUBSCRIPTION は安全側で拒否）
 *   - STRIPE_PRICE_ID 設定済み（NULL/空 = 販売設定未完了で拒否）
 *
 * Stripe Price ID の正本も M_PRODUCT.STRIPE_PRICE_ID（DB）へ移行した。env の商品別
 * STRIPE_PRICE_* 参照・resolvePriceId の商品コード switch・KNOWN_PRODUCT_CODES は廃止。
 * 商品追加・販売開始/停止・Price 変更は M_PRODUCT 設定で行い、コード改修を不要にする。
 * 旧 SELLABLE_PRODUCT_CODES / site-config purchasable も廃止済み。
 */
export const SALE_TYPE_ONE_TIME = "ONE_TIME";
export const SALE_TYPE_SUBSCRIPTION = "SUBSCRIPTION";

/** Price 設定の重複（同一 Price ID が複数商品へ割当）を表す内部エラー。 */
export class PriceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceConfigError";
  }
}

/**
 * Price ID → PRODUCT_CODE の逆引き Map を M_PRODUCT（DB）から構築する。
 * Webhook 決済確定（stripe_fulfill）で line item の price.id を商品コードへ解決するために使う。
 * Price ID の正本は M_PRODUCT.STRIPE_PRICE_ID（env の Secret ではない）。
 *
 * - STATUS=1 かつ DEL_FLG=0 かつ STRIPE_PRICE_ID が設定済みの商品のみ対象。
 * - 同一 Price ID が複数商品へ割り当てられている場合は、安全側で設定エラーとして例外を投げる
 *   （どの商品として付与すべきか一意に定まらないため、購入・権限付与しない）。
 *
 * @throws PriceConfigError 同一 Price ID が複数商品に割り当てられているとき
 */
export async function buildPriceIdToCodeMap(env: Env): Promise<Map<string, string>> {
  const db = getDb(env);
  const rows = await db
    .prepare(
      `SELECT PRODUCT_CODE AS code, STRIPE_PRICE_ID AS priceId
       FROM M_PRODUCT
       WHERE STATUS = 1 AND DEL_FLG = 0 AND STRIPE_PRICE_ID IS NOT NULL AND STRIPE_PRICE_ID <> ''`,
    )
    .all<{ code: string; priceId: string }>();
  const map = new Map<string, string>();
  for (const r of rows.results ?? []) {
    const existing = map.get(r.priceId);
    if (existing && existing !== r.code) {
      throw new PriceConfigError(
        `price id is assigned to multiple products: ${existing} and ${r.code}`,
      );
    }
    map.set(r.priceId, r.code);
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
 * 商品依存条件（M_PRODUCT_DEPENDENCY / migration 0008 が正本）
 * ============================================================ */

/** M_PRODUCT_DEPENDENCY の 1 行（有効な依存定義）。 */
interface DependencyRow {
  REQUIRES_CODE: string;
  DEPENDENCY_GROUP: number;
  SATISFY_MODE: string;
}

/** SATISFY_MODE の値。 */
const SATISFY_ENTITLEMENT_ONLY = "ENTITLEMENT_ONLY";
const SATISFY_ENTITLEMENT_OR_CART = "ENTITLEMENT_OR_CART";

/**
 * 依存設定そのものが不正（循環・グループ内 SATISFY_MODE 混在など）であることを表す内部設定エラー。
 * 利用者の「前提商品を持っていない」（DEPENDENCY_REQUIRED）とは区別し、内部設定エラーとして安全側に停止する。
 * ブラウザには内部詳細（SQL・テーブル名・内部 ID）を出さず、呼出側で汎用メッセージへ変換する。
 */
export class DependencyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyConfigError";
  }
}

/**
 * 指定商品の有効な依存定義を DB（M_PRODUCT_DEPENDENCY）から取得する。
 * STATUS=1 かつ DEL_FLG=0 のみ。DB に行が無い商品は「依存なし」（空配列）。
 */
async function getProductDependencies(env: Env, productCode: string): Promise<DependencyRow[]> {
  const db = getDb(env);
  const res = await db
    .prepare(
      `SELECT REQUIRES_CODE, DEPENDENCY_GROUP, SATISFY_MODE
       FROM M_PRODUCT_DEPENDENCY
       WHERE PRODUCT_CODE = ? AND STATUS = 1 AND DEL_FLG = 0`,
    )
    .bind(productCode)
    .all<DependencyRow>();
  return res.results ?? [];
}

/**
 * 表示用の依存グループ（グループ内 ANY_OF＋satisfyMode）。
 * precheck の DEPENDENCY_REQUIRED.details.missingGroups と同一構造にし、フロントの文言生成を共通化する。
 * こちらは所有状態に依存せず「依存定義そのもの」を表す（Store カードの常時表示用）。
 */
export interface DependencyDisplayGroup {
  /** グループ内候補（いずれか1つで充足＝ANY_OF）。決定的に並べる。 */
  requiresAnyOf: string[];
  /** このグループの充足方式。 */
  satisfyMode: "ENTITLEMENT_ONLY" | "ENTITLEMENT_OR_CART";
}

/**
 * DependencyRow[] をグループ構造（DEPENDENCY_GROUP 単位・ANY_OF＋satisfyMode）へ整形する。
 * グループ内 SATISFY_MODE 混在・未知値は表示情報として安全側に無視（依存案内を出さない）ため空配列を返す。
 * 依存判定の正本（checkProductDependencies）はこれとは別に厳格判定するので、表示整形はここで完結してよい。
 */
function toDisplayGroups(deps: DependencyRow[]): DependencyDisplayGroup[] {
  if (deps.length === 0) return [];
  const groups = new Map<number, { candidates: string[]; modes: Set<string> }>();
  for (const d of deps) {
    const g = groups.get(d.DEPENDENCY_GROUP) ?? { candidates: [], modes: new Set<string>() };
    g.candidates.push(d.REQUIRES_CODE);
    g.modes.add(d.SATISFY_MODE);
    groups.set(d.DEPENDENCY_GROUP, g);
  }
  const out: DependencyDisplayGroup[] = [];
  for (const { candidates, modes } of groups.values()) {
    // 表示用途では設定ミス（混在・未知）は案内を出さない安全側に倒す（判定は別途 checkProductDependencies）。
    if (modes.size !== 1) return [];
    const mode = [...modes][0];
    if (mode !== SATISFY_ENTITLEMENT_ONLY && mode !== SATISFY_ENTITLEMENT_OR_CART) return [];
    out.push({ requiresAnyOf: [...candidates].sort(), satisfyMode: mode });
  }
  return out;
}

/**
 * 全商品の依存定義を PRODUCT_CODE → 表示グループ配列 で返す（/api/products の依存案内用）。
 * 依存が無い商品はキーを持たない（呼出側で空配列扱い）。1 クエリでまとめて取得する。
 */
export async function getAllProductDependencyGroups(
  env: Env,
): Promise<Record<string, DependencyDisplayGroup[]>> {
  const db = getDb(env);
  const res = await db
    .prepare(
      `SELECT PRODUCT_CODE, REQUIRES_CODE, DEPENDENCY_GROUP, SATISFY_MODE
       FROM M_PRODUCT_DEPENDENCY
       WHERE STATUS = 1 AND DEL_FLG = 0
       ORDER BY PRODUCT_CODE, DEPENDENCY_GROUP, REQUIRES_CODE`,
    )
    .all<{ PRODUCT_CODE: string } & DependencyRow>();
  const byCode = new Map<string, DependencyRow[]>();
  for (const r of res.results ?? []) {
    const arr = byCode.get(r.PRODUCT_CODE) ?? [];
    arr.push({ REQUIRES_CODE: r.REQUIRES_CODE, DEPENDENCY_GROUP: r.DEPENDENCY_GROUP, SATISFY_MODE: r.SATISFY_MODE });
    byCode.set(r.PRODUCT_CODE, arr);
  }
  const out: Record<string, DependencyDisplayGroup[]> = {};
  for (const [code, deps] of byCode) {
    const groups = toDisplayGroups(deps);
    if (groups.length > 0) out[code] = groups;
  }
  return out;
}

/** 依存グラフの 1 エッジ（PRODUCT_CODE → REQUIRES_CODE）。 */
interface DependencyEdge {
  PRODUCT_CODE: string;
  REQUIRES_CODE: string;
}

/**
 * M_PRODUCT_DEPENDENCY 全体（有効定義のみ）に循環依存が無いか検証する。
 *
 * - 対象は STATUS=1 かつ DEL_FLG=0 の有効依存のみ（無効化・削除済みは含めない）。
 * - PRODUCT_CODE → REQUIRES_CODE を有向辺とし、DFS の 3 色塗り分けで back edge（循環）を検出する。
 * - 例: A→B, B→A / A→B, B→C, C→A を循環として検出。自己依存は DB CHECK で登録不可（ここには来ない）。
 * - 依存テーブルは小規模前提。requested 商品から到達する範囲に限らず全有効依存を検査し、
 *   到達しない場所の設定ミスも早期に検知する。
 * - 循環は「依存設定の妥当性」の問題であり entitlement 利用可否には影響させない（本関数は Checkout 依存評価専用）。
 *
 * @throws DependencyConfigError 循環が存在するとき
 */
export async function assertNoDependencyCycle(env: Env): Promise<void> {
  const db = getDb(env);
  const res = await db
    .prepare(
      `SELECT PRODUCT_CODE, REQUIRES_CODE
       FROM M_PRODUCT_DEPENDENCY
       WHERE STATUS = 1 AND DEL_FLG = 0`,
    )
    .all<DependencyEdge>();
  const edges = res.results ?? [];

  // 隣接リスト（PRODUCT_CODE → その前提 REQUIRES_CODE 群）。
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const arr = adj.get(e.PRODUCT_CODE) ?? [];
    arr.push(e.REQUIRES_CODE);
    adj.set(e.PRODUCT_CODE, arr);
  }

  // DFS 3 色塗り分け: 0=未訪問 / 1=訪問中（スタック上）/ 2=完了。
  const color = new Map<string, number>();
  const dfs = (node: string): boolean => {
    color.set(node, 1);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) return true; // back edge = 循環
      if (c === 0 && dfs(next)) return true;
    }
    color.set(node, 2);
    return false;
  };

  for (const node of adj.keys()) {
    if ((color.get(node) ?? 0) === 0) {
      if (dfs(node)) {
        throw new DependencyConfigError("dependency cycle detected in M_PRODUCT_DEPENDENCY");
      }
    }
  }
}

/**
 * 商品購入の依存前提を検証する（バックエンド必須。UI 依存にしない）。
 *
 * 依存定義の正本は M_PRODUCT_DEPENDENCY（migration 0008）。旧コード固定の PRODUCT_DEPENDENCIES は廃止。
 *
 * 判定:
 *   - まず依存設定全体の妥当性を検証（循環依存なら DependencyConfigError で安全側に停止）。
 *   - DB に依存定義が無い商品は依存なし（通過）。
 *   - 依存は DEPENDENCY_GROUP でまとめる。
 *       グループ内 = ANY_OF（グループ内のいずれかの REQUIRES_CODE を満たせばそのグループは充足）。
 *       グループ間 = ALL_OF（すべてのグループを充足する必要がある）。
 *   - 各グループの SATISFY_MODE（充足方法）:
 *       ENTITLEMENT_OR_CART … 有効 entitlement を所有、または同一注文に前提商品を含めば充足。
 *       ENTITLEMENT_ONLY    … Checkout 開始前から有効 entitlement を持つ場合のみ充足（同一注文は充足に使わない）。
 *     同一グループ内で SATISFY_MODE が混在するのは設定ミス（ANY_OF の評価単位が曖昧になる）。
 *     DependencyConfigError で安全側に停止する（DB 列 CHECK と判定時検証の二重防御）。
 *   - 「所有」= 有効な T_USER_PRODUCT entitlement（isProductAvailable。購入履歴・注文履歴・Stripe 履歴・
 *       GRANT_TYPE を問わない＝Admin 直接付与も所有扱い）。
 *   - 不正な依存（前提商品が M_PRODUCT に存在しない/無効）は充足せず購入不可（安全側）。
 *
 * @throws AppError DEPENDENCY_REQUIRED(409) 依存前提を満たさないとき
 * @throws DependencyConfigError 依存設定が不正（循環 / グループ内 SATISFY_MODE 混在）なとき
 */
export async function checkProductDependencies(
  env: Env,
  authUserId: string,
  requestedCodes: string[],
): Promise<void> {
  // 依存設定全体の妥当性検証（循環依存の検出）。設定ミスを A+B 同時カート等で抜けられないようにする。
  await assertNoDependencyCycle(env);

  const requested = new Set(requestedCodes);
  for (const code of requestedCodes) {
    const deps = await getProductDependencies(env, code);
    if (deps.length === 0) continue; // 依存なし

    // グループごとに前提候補（REQUIRES_CODE）と SATISFY_MODE をまとめる（グループ内 ANY_OF）。
    const groups = new Map<number, { candidates: string[]; modes: Set<string> }>();
    for (const d of deps) {
      const g = groups.get(d.DEPENDENCY_GROUP) ?? { candidates: [], modes: new Set<string>() };
      g.candidates.push(d.REQUIRES_CODE);
      g.modes.add(d.SATISFY_MODE);
      groups.set(d.DEPENDENCY_GROUP, g);
    }

    // 未充足グループを収集する（グループ間 ALL_OF＝すべて充足が必要）。
    // 1つでも未充足なら、その購入対象コードと未充足グループ群を添えて DEPENDENCY_REQUIRED を返す。
    const missingGroups: { requiresAnyOf: string[]; satisfyMode: "ENTITLEMENT_ONLY" | "ENTITLEMENT_OR_CART" }[] = [];
    for (const { candidates, modes } of groups.values()) {
      // 同一グループ内は同一 SATISFY_MODE でなければならない（混在は設定ミス）。
      if (modes.size !== 1) {
        throw new DependencyConfigError(
          `mixed SATISFY_MODE in a dependency group for product: ${code}`,
        );
      }
      const mode = [...modes][0];
      // 既知の SATISFY_MODE のみ許可（DB CHECK と二重防御。未知値は設定エラー）。
      if (mode !== SATISFY_ENTITLEMENT_ONLY && mode !== SATISFY_ENTITLEMENT_OR_CART) {
        throw new DependencyConfigError(`unknown SATISFY_MODE '${mode}' for product: ${code}`);
      }
      const allowCart = mode === SATISFY_ENTITLEMENT_OR_CART;

      let satisfied = false;
      for (const requires of candidates) {
        // ENTITLEMENT_OR_CART のときのみ、同一注文（同時購入）に前提商品を含めば充足を許可。
        if (allowCart && requested.has(requires)) {
          satisfied = true;
          break;
        }
        // いずれのモードでも、有効 entitlement を所有していれば充足。
        const hasBase = await isProductAvailable(env, authUserId, requires);
        if (hasBase) {
          satisfied = true;
          break;
        }
      }
      if (!satisfied) {
        // グループ内候補（ANY_OF）を、判定順に依存しないよう決定的に並べる。
        // satisfyMode を添え、フロントが「事前購入必須」か「同時選択可」かを文言に反映できるようにする。
        missingGroups.push({
          requiresAnyOf: [...candidates].sort(),
          satisfyMode: mode,
        });
      }
    }
    if (missingGroups.length > 0) {
      // 購入対象コード（code）＋未充足グループ（ALL_OF）を details に載せる。
      // フロントは PRODUCT_NAME へ変換して「◯◯を購入するには△△が必要」を表示する。
      throw new DependencyRequiredError({ productCode: code, missingGroups });
    }
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
 * 3. 各商品が販売対象（M_PRODUCT の PURCHASE_ENABLED / STRIPE_PRICE_ID が設定済み）
 * 4. 二重購入防止（既に available な商品を含めない）
 * 5. 商品依存条件（M_PRODUCT_DEPENDENCY を正本とする汎用依存判定）
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
    // 3. 新規販売中か（販売可否の正本 = M_PRODUCT の販売専用列。migration 0007）。
    //    STATUS=1・DEL_FLG=0 は getActiveProductByCode で担保済み。ここで PURCHASE_ENABLED を確認。
    //    商品コードの個別 if 分岐は使わない。集合に 1 つでも未発売が含まれれば注文全体を
    //    Stripe 呼び出し前に拒否（部分成功なし）。
    if (product.PURCHASE_ENABLED !== 1) {
      throw new AppError("PRODUCT_NOT_SELLABLE", "現在購入できない商品が含まれています。", 409);
    }
    // 3b. 販売方式。現行 Checkout 基盤は買い切り（ONE_TIME）のみ対応。
    //     SUBSCRIPTION は将来対応。今は安全側で拒否し、誤って Session を作らせない。
    if (product.SALE_TYPE !== SALE_TYPE_ONE_TIME) {
      throw new AppError(
        "SALE_TYPE_NOT_SUPPORTED",
        "現在この販売方式には対応していません。",
        409,
      );
    }
    // 4. 販売対象（Stripe Price ID が M_PRODUCT に設定済みか）。
    //    Price ID の正本は DB（M_PRODUCT.STRIPE_PRICE_ID）。env の商品別 Price 参照は廃止した。
    //    NULL/空 = 販売設定未完了として、Stripe API 呼び出し前に安全に拒否する。
    const priceId = product.STRIPE_PRICE_ID;
    if (!priceId) {
      throw new AppError("PRODUCT_NOT_SELLABLE", "現在購入できない商品が含まれています。", 409);
    }
    // 4b. Price ID 重複検知（Checkout 前の安全網）。
    //     一意性の正本は DB の部分 UNIQUE INDEX（UX_PRODUCT_STRIPE_PRICE_ID）だが、
    //     既存 DB や異常データに備え、同一カート内で同じ Price ID が複数商品に割り当たる場合は
    //     Stripe Session 作成前に拒否する（決済後 Webhook で初めて気付く事態を避ける）。
    for (const [seenCode, seenPrice] of priceIdByCode) {
      if (seenPrice === priceId && seenCode !== code) {
        throw new AppError(
          "PRODUCT_NOT_SELLABLE",
          "現在購入できない商品が含まれています。",
          409,
        );
      }
    }
    // 5. 二重購入防止
    const available = await isProductAvailable(env, authUserId, code);
    if (available) {
      throw new AppError("ALREADY_PURCHASED", "既に利用可能な商品が含まれています。", 409);
    }
    products.push(product);
    priceIdByCode.set(code, priceId);
  }

  // 5. 商品依存条件（M_PRODUCT_DEPENDENCY を正本とする汎用依存判定）
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
