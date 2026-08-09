/**
 * 商品権限共通ロジック
 *
 * 商品利用可否（available）判定、商品権限一覧取得（LEFT JOIN）、
 * requireProduct、権限確認アクセスログの抑制付き記録を提供する。
 *
 * 設計根拠:
 * - api/PRODUCT_API.md 3/4/5, api/AUTH_API.md 2/4, architecture/AUTH.md 9
 * - SECURITY.md 4「商品API側で毎回 requireProduct を通す」
 * - REVIEW_RULE.md 5「Prepared Statement」「複数更新は batch」
 *
 * 日時比較（検証済み）:
 * - START_DATE/END_DATE と現在時刻の比較は Date へ変換して行う。
 *   nowIso() はミリ秒付き、DDL の END_DATE 既定はミリ秒なしで、文字列辞書順比較は
 *   秒直後の '.'(0x2E) と '+'(0x2B) の差で時系列と不一致になるため。
 *   オフセットは全て +09:00 固定で、Date 変換に曖昧さはない。9999 年も扱える。
 */

import { requireUser, AuthError, type AuthContext } from "./auth";
import { getDb } from "./db";
import { getMUser } from "./account";
import { getSystemSetting } from "./settings";
import { writeAccessLog, ACCESS_TYPE, type AccessType } from "./logs";
import { getDeviceId } from "./device";
import { nowIso } from "./datetime";
import type { Env } from "../index";

/** M_USER の有効状態（1=有効） */
const USER_STATUS_ACTIVE = 1;
/** M_USER 停止・退会 */
const USER_STATUS_SUSPENDED = 2;
const USER_STATUS_WITHDRAWN = 9;

/** 商品行（M_PRODUCT） */
export interface ProductRow {
  PRODUCT_ID: number;
  PRODUCT_CODE: string;
  PRODUCT_NAME: string;
  STATUS: number;
  SORT_NO: number;
  DEL_FLG: number;
}

/** 権限行（T_USER_PRODUCT の一部） */
interface UserProductRow {
  STATUS: number;
  START_DATE: string;
  END_DATE: string;
  DEL_FLG: number;
}

/** account/products で返す1商品 */
export interface ProductEntitlement {
  code: string;
  name: string;
  granted: boolean;
  available: boolean;
  status: number | null;
}

/** me で返す1商品（available 詳細付き） */
export interface MeProductEntitlement {
  code: string;
  name: string;
  status: number;
  available: boolean;
  startAt: string;
  endAt: string;
}

/**
 * JST ISO 8601 文字列を時刻数値へ変換する。
 * 不正な文字列は NaN を返す（呼出側で false 扱い）。
 */
function toTime(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * 保存済み権限行が現在時刻で利用可能かを判定する。
 * 前提: 商品側の STATUS=1 / DEL_FLG=0 と、ユーザー STATUS=1 は呼出側で確認済み、
 * またはここで渡す条件に含める。ここでは権限行と日付範囲のみを見る。
 */
function isEntitlementActive(up: UserProductRow, nowMs: number): boolean {
  if (up.STATUS !== 1) return false;
  if (up.DEL_FLG !== 0) return false;
  const start = toTime(up.START_DATE);
  const end = toTime(up.END_DATE);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return start <= nowMs && nowMs <= end;
}

/**
 * account/products 用: 有効商品全件に権限を LEFT JOIN して返す（N+1 回避）。
 *
 * @param env 環境
 * @param authUserId 認証済み AUTH_USER_ID
 * @returns 全有効商品の granted/available 一覧（SORT_NO 昇順）
 */
export async function listProductEntitlements(
  env: Env,
  authUserId: string,
): Promise<ProductEntitlement[]> {
  const db = getDb(env);
  const nowMs = toTime(nowIso());
  // 有効商品 × 当該ユーザーの権限を1クエリで取得
  const rows = await db
    .prepare(
      `SELECT p.PRODUCT_CODE AS code, p.PRODUCT_NAME AS name,
              up.STATUS AS upStatus, up.START_DATE AS startDate,
              up.END_DATE AS endDate, up.DEL_FLG AS upDel
       FROM M_PRODUCT p
       LEFT JOIN T_USER_PRODUCT up
         ON up.PRODUCT_ID = p.PRODUCT_ID AND up.AUTH_USER_ID = ?
       WHERE p.STATUS = 1 AND p.DEL_FLG = 0
       ORDER BY p.SORT_NO ASC`,
    )
    .bind(authUserId)
    .all<{
      code: string;
      name: string;
      upStatus: number | null;
      startDate: string | null;
      endDate: string | null;
      upDel: number | null;
    }>();

  const list = rows.results ?? [];
  return list.map((r) => {
    const granted = r.upStatus !== null && r.upDel === 0;
    let available = false;
    if (granted && r.startDate && r.endDate) {
      available = isEntitlementActive(
        { STATUS: r.upStatus as number, START_DATE: r.startDate, END_DATE: r.endDate, DEL_FLG: r.upDel as number },
        nowMs,
      );
    }
    return {
      code: r.code,
      name: r.name,
      granted,
      available,
      status: r.upStatus,
    };
  });
}

/**
 * me 用: ユーザーが保有する商品のうち権限行がある商品を available 詳細付きで返す。
 * （AUTH_API.md 2 の products は granted 商品を返す想定）
 */
export async function listMeProducts(env: Env, authUserId: string): Promise<MeProductEntitlement[]> {
  const db = getDb(env);
  const nowMs = toTime(nowIso());
  const rows = await db
    .prepare(
      `SELECT p.PRODUCT_CODE AS code, p.PRODUCT_NAME AS name,
              up.STATUS AS upStatus, up.START_DATE AS startDate,
              up.END_DATE AS endDate, up.DEL_FLG AS upDel
       FROM T_USER_PRODUCT up
       JOIN M_PRODUCT p ON p.PRODUCT_ID = up.PRODUCT_ID
       WHERE up.AUTH_USER_ID = ? AND p.STATUS = 1 AND p.DEL_FLG = 0
       ORDER BY p.SORT_NO ASC`,
    )
    .bind(authUserId)
    .all<{
      code: string;
      name: string;
      upStatus: number;
      startDate: string;
      endDate: string;
      upDel: number;
    }>();
  const list = rows.results ?? [];
  return list.map((r) => ({
    code: r.code,
    name: r.name,
    status: r.upStatus,
    available: isEntitlementActive(
      { STATUS: r.upStatus, START_DATE: r.startDate, END_DATE: r.endDate, DEL_FLG: r.upDel },
      nowMs,
    ),
    startAt: r.startDate,
    endAt: r.endDate,
  }));
}

/** 商品を PRODUCT_CODE で取得（有効商品のみ）。無ければ null。 */
export async function getActiveProductByCode(env: Env, code: string): Promise<ProductRow | null> {
  const db = getDb(env);
  const row = await db
    .prepare(
      `SELECT PRODUCT_ID, PRODUCT_CODE, PRODUCT_NAME, STATUS, SORT_NO, DEL_FLG
       FROM M_PRODUCT WHERE PRODUCT_CODE = ? AND STATUS = 1 AND DEL_FLG = 0`,
    )
    .bind(code)
    .first<ProductRow>();
  return row ?? null;
}

/** requireProduct / entitlements の判定結果 */
export interface EntitlementResult {
  auth: AuthContext;
  product: ProductRow;
  startAt: string;
  endAt: string;
}

/**
 * 商品利用権限を検証する共通関数。
 *
 * 各アプリ固有 API から呼び出し、画面表示に関わらず必ず権限を確認する。
 *
 * 処理:
 * 1. requireUser（JWT検証）
 * 2. M_USER 状態確認（2/9 は USER_SUSPENDED 403）
 * 3. M_PRODUCT 確認（不在/停止/削除は PRODUCT_NOT_FOUND 404）
 * 4. T_USER_PRODUCT 確認（STATUS/DEL_FLG/日付範囲）
 * 5. 不可なら PRODUCT_NOT_GRANTED 403（未購入/停止/期限前/期限切れを区別しない）
 *
 * @throws AuthError USER_SUSPENDED(403) / PRODUCT_NOT_FOUND(404) / PRODUCT_NOT_GRANTED(403)
 * @returns 権限あり時の情報
 */
export async function requireProduct(
  request: Request,
  env: Env,
  productCode: string,
): Promise<EntitlementResult> {
  const auth = await requireUser(request, env);

  // M_USER 状態
  const user = await getMUser(env, auth.authUserId);
  if (!user || user.STATUS === USER_STATUS_SUSPENDED || user.STATUS === USER_STATUS_WITHDRAWN) {
    throw new AuthError("USER_SUSPENDED", "このアカウントは現在利用できません。", 403);
  }
  if (user.STATUS !== USER_STATUS_ACTIVE) {
    // 仮登録(0)等も利用不可
    throw new AuthError("USER_SUSPENDED", "このアカウントは現在利用できません。", 403);
  }

  // M_PRODUCT
  const product = await getActiveProductByCode(env, productCode);
  if (!product) {
    throw new AuthError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
  }

  // T_USER_PRODUCT
  const db = getDb(env);
  const up = await db
    .prepare(
      `SELECT STATUS, START_DATE, END_DATE, DEL_FLG
       FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ?`,
    )
    .bind(auth.authUserId, product.PRODUCT_ID)
    .first<UserProductRow>();

  const nowMs = toTime(nowIso());
  if (!up || !isEntitlementActive(up, nowMs)) {
    // 未購入 / 停止 / 期限前 / 期限切れ を区別しない
    throw new AuthError("PRODUCT_NOT_GRANTED", "この商品は利用できません。", 403);
  }

  return { auth, product, startAt: up.START_DATE, endAt: up.END_DATE };
}

/**
 * 権限確認アクセスログ（ACCESS_TYPE=1）を抑制付きで記録する。
 *
 * 抑制条件（同一とみなすキー）: AUTH_USER_ID / PRODUCT_ID / ACCESS_TYPE=1 / DEVICE_ID。
 * DEVICE_ID が NULL の場合は NULL 同士を同一グループとして扱う。
 * 最新の同条件ログの記録時刻 + INTERVAL_MIN 分 > now なら記録しない。
 *
 * 設定値異常（不在/非整数/負数）は内部設定エラーとして扱い、記録も抑制もしない
 * （利用者へは詳細を返さない。呼出側で握って処理継続）。0 は「抑制なし」。
 *
 * @throws AccessLogSettingError 設定値が不正なとき
 */
export async function recordEntitlementAccess(
  request: Request,
  env: Env,
  authUserId: string,
  productId: number,
): Promise<void> {
  await recordAccessWithSuppression(request, env, authUserId, productId, ACCESS_TYPE.ENTITLEMENT_CHECK);
}

/**
 * アプリ起動アクセスログ（ACCESS_TYPE=0 / APP_START）を抑制付きで記録する。
 *
 * WORK-010 SUN AND MOON 統合で、アプリ画面の起動時に1回だけ呼ぶ。
 * 各計算APIでは記録せず、これで「アプリ利用開始時に1回」の記録責務を担う。
 * 抑制条件（同一とみなすキー）: AUTH_USER_ID / PRODUCT_ID / ACCESS_TYPE=0 / DEVICE_ID。
 * ACCESS_LOG_INTERVAL_MIN 以内の同一条件は記録しない（計算API多数呼び出しでログを増やさない）。
 *
 * ENTITLEMENT_CHECK(=1) とは ACCESS_TYPE が異なるため抑制も独立し、
 * 既存の権限確認ログの意味・挙動には影響しない。
 *
 * @throws AccessLogSettingError 設定値が不正なとき
 */
export async function recordAppStartAccess(
  request: Request,
  env: Env,
  authUserId: string,
  productId: number,
): Promise<void> {
  await recordAccessWithSuppression(request, env, authUserId, productId, ACCESS_TYPE.APP_START);
}

/**
 * 指定 ACCESS_TYPE のアクセスログを、同一条件 ACCESS_LOG_INTERVAL_MIN 抑制付きで記録する内部共通処理。
 * 抑制キー: AUTH_USER_ID / PRODUCT_ID / ACCESS_TYPE / DEVICE_ID（DEVICE_ID は NULL 同士も一致）。
 */
async function recordAccessWithSuppression(
  request: Request,
  env: Env,
  authUserId: string,
  productId: number,
  accessType: AccessType,
): Promise<void> {
  const raw = await getSystemSetting(env, "ACCESS_LOG_INTERVAL_MIN");
  // 設定値検証: 不在 / 非整数 / 負数は内部設定エラー（fallback しない）
  if (raw === null || !/^-?\d+$/.test(raw.trim())) {
    throw new AccessLogSettingError("ACCESS_LOG_INTERVAL_MIN is missing or non-integer");
  }
  const intervalMin = Number.parseInt(raw.trim(), 10);
  if (intervalMin < 0) {
    throw new AccessLogSettingError("ACCESS_LOG_INTERVAL_MIN is negative");
  }

  const deviceId = getDeviceId(request);

  // 0 は抑制なし → 毎回記録
  if (intervalMin > 0) {
    const db = getDb(env);
    // DEVICE_ID の NULL 同士一致を Prepared Statement で正しく判定する。
    // (DEVICE_ID = ? OR (DEVICE_ID IS NULL AND ? IS NULL)) を用いる。
    const last = await db
      .prepare(
        `SELECT ACCESS_DATE FROM T_ACCESS_LOG
         WHERE AUTH_USER_ID = ? AND PRODUCT_ID = ? AND ACCESS_TYPE = ?
           AND (DEVICE_ID = ? OR (DEVICE_ID IS NULL AND ? IS NULL))
         ORDER BY ACCESS_DATE DESC
         LIMIT 1`,
      )
      .bind(authUserId, productId, accessType, deviceId, deviceId)
      .first<{ ACCESS_DATE: string }>();

    if (last) {
      const lastMs = new Date(last.ACCESS_DATE).getTime();
      const nowMs = new Date(nowIso()).getTime();
      if (!Number.isNaN(lastMs)) {
        const nextAllowed = lastMs + intervalMin * 60 * 1000;
        if (nextAllowed > nowMs) {
          // 抑制時間内 → 記録しない
          return;
        }
      }
    }
  }

  await writeAccessLog(request, env, {
    authUserId,
    productId,
    accessType,
  });
}

/** アクセスログ設定値の異常。内部設定エラーとして扱う。 */
export class AccessLogSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessLogSettingError";
  }
}
