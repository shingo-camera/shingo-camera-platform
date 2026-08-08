/**
 * 管理系クエリ共通ロジック（読み取り中心）
 *
 * ダッシュボード集計・ユーザー検索・Warning 一覧の SELECT を集約する。
 * すべて Prepared Statement + bind。
 *
 * 設計根拠: api/ADMIN_API.md 3/4/8, database/DATABASE.md（コード値）
 *
 * 「当日」判定（範囲 bind）:
 * - JST 当日開始 <= 対象 < JST 翌日開始 を、jstDayRange() の 2 値を bind して判定。
 * - 境界は 00:00:00（秒固定）で、保存値のミリ秒有無に関わらず安全であることを検証済み
 *   （同一秒内で「ミリ秒なし境界」の直後 '+'(0x2B) < 「ミリ秒あり保存値」の '.'(0x2E) < 数字、
 *    かつ >= は当日開始を含み < は翌日開始を除くため、日跨ぎ・月跨ぎ・年跨ぎでも桁ズレしない）。
 *   prefix LIKE は使用しない。
 *
 * 「商品別有効ユーザー数」判定:
 * - WORK-005 の available 条件と整合させる（M_USER/M_PRODUCT/T_USER_PRODUCT の各状態 + 期間内）。
 * - 期間（START_DATE <= now <= END_DATE）はミリ秒有無混在があるため SQL 文字列比較に頼らず、
 *   状態条件で候補を絞ったうえで Date 変換で最終判定する（商品ごとの N+1 にはしない：
 *   1 クエリで候補行を取得し、アプリ側で商品別に集計）。
 */

import { getDb } from "./db";
import { nowIso, jstDayRange } from "./datetime";
import type { Env } from "../index";

/** ダッシュボード集計結果 */
export interface DashboardData {
  totalUsers: number;
  activeUsersByProduct: Array<{ code: string; name: string; count: number }>;
  todaySignups: number;
  todayPurchases: number;
  noteUnmigrated: number;
  openWarnings: number;
  recentWarnings: Array<{
    warningId: number;
    email: string | null;
    warningType: string;
    warningScore: number;
    detectDate: string;
    status: number;
  }>;
}

/** ISO 文字列を時刻数値へ（不正は NaN） */
function toTime(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * ダッシュボード集計を取得する。既存テーブルのみ。新規テーブル・設定は使わない。
 */
export async function getDashboard(env: Env): Promise<DashboardData> {
  const db = getDb(env);
  const nowMs = Date.now();
  const nowMsVal = toTime(nowIso());
  const { start: dayStart, nextStart: dayNext } = jstDayRange(nowMs);

  // 総ユーザー数（論理削除・退会を除外）
  const total = await db
    .prepare("SELECT COUNT(*) AS c FROM M_USER WHERE DEL_FLG = 0 AND STATUS <> 9")
    .first<{ c: number }>();

  // 商品別有効ユーザー数（available 条件）。
  // 状態条件で候補を SQL で絞り、期間は Date 判定でアプリ側集計（N+1 回避のため 1 クエリ）。
  const candidates = await db
    .prepare(
      `SELECT p.PRODUCT_CODE AS code, p.PRODUCT_NAME AS name,
              up.START_DATE AS startDate, up.END_DATE AS endDate
       FROM T_USER_PRODUCT up
       JOIN M_USER u    ON u.AUTH_USER_ID = up.AUTH_USER_ID
       JOIN M_PRODUCT p ON p.PRODUCT_ID   = up.PRODUCT_ID
       WHERE u.STATUS = 1 AND u.DEL_FLG = 0
         AND p.STATUS = 1 AND p.DEL_FLG = 0
         AND up.STATUS = 1 AND up.DEL_FLG = 0`,
    )
    .all<{ code: string; name: string; startDate: string; endDate: string }>();

  // 全有効商品を 0 件で初期化（SORT_NO 昇順）
  const productOrder = await db
    .prepare(
      "SELECT PRODUCT_CODE AS code, PRODUCT_NAME AS name FROM M_PRODUCT WHERE STATUS = 1 AND DEL_FLG = 0 ORDER BY SORT_NO ASC",
    )
    .all<{ code: string; name: string }>();

  const counts = new Map<string, number>();
  for (const p of productOrder.results ?? []) counts.set(p.code, 0);
  for (const r of candidates.results ?? []) {
    const s = toTime(r.startDate);
    const e = toTime(r.endDate);
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    // 期間内: START_DATE <= now <= END_DATE
    if (s <= nowMsVal && nowMsVal <= e) {
      counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
    }
  }
  const activeUsersByProduct = (productOrder.results ?? []).map((p) => ({
    code: p.code,
    name: p.name,
    count: counts.get(p.code) ?? 0,
  }));

  // 当日新規登録（範囲 bind）
  const signups = await db
    .prepare("SELECT COUNT(*) AS c FROM M_USER WHERE CREATE_DATE >= ? AND CREATE_DATE < ? AND DEL_FLG = 0")
    .bind(dayStart, dayNext)
    .first<{ c: number }>();

  // 当日購入（範囲 bind）
  const purchases = await db
    .prepare("SELECT COUNT(*) AS c FROM T_PURCHASE WHERE PURCHASE_DATE >= ? AND PURCHASE_DATE < ? AND DEL_FLG = 0")
    .bind(dayStart, dayNext)
    .first<{ c: number }>();

  // note 未移行
  const noteUn = await db
    .prepare("SELECT COUNT(*) AS c FROM T_NOTE_PURCHASE WHERE MATCH_STATUS = 0 AND DEL_FLG = 0")
    .first<{ c: number }>();

  // 未対応 Warning
  const openW = await db
    .prepare("SELECT COUNT(*) AS c FROM T_WARNING WHERE STATUS = 0")
    .first<{ c: number }>();

  // 直近 Warning（新しい順、上限10）
  const recent = await db
    .prepare(
      `SELECT w.WARNING_ID AS warningId, u.LOGIN_MAIL AS email,
              w.WARNING_TYPE AS warningType, w.WARNING_SCORE AS warningScore,
              w.DETECT_DATE AS detectDate, w.STATUS AS status
       FROM T_WARNING w
       LEFT JOIN M_USER u ON u.AUTH_USER_ID = w.AUTH_USER_ID
       ORDER BY w.DETECT_DATE DESC
       LIMIT 10`,
    )
    .all<{
      warningId: number;
      email: string | null;
      warningType: string;
      warningScore: number;
      detectDate: string;
      status: number;
    }>();

  return {
    totalUsers: total?.c ?? 0,
    activeUsersByProduct,
    todaySignups: signups?.c ?? 0,
    todayPurchases: purchases?.c ?? 0,
    noteUnmigrated: noteUn?.c ?? 0,
    openWarnings: openW?.c ?? 0,
    recentWarnings: recent.results ?? [],
  };
}

/** ユーザー一覧の1行 */
export interface AdminUserRow {
  authUserId: string;
  email: string;
  status: number;
  products: string[];
  createdAt: string;
  lastLoginAt: string | null;
  lastAccessAt: string | null;
}

/** ユーザー検索クエリ（検証済みの値のみを受け取る） */
export interface UserSearchQuery {
  email?: string | null;
  status?: number | null;
  productCode?: string | null;
  limit: number;
  offset: number;
}

/** ユーザー一覧を検索する。値は必ず bind。 */
export async function searchUsers(env: Env, q: UserSearchQuery): Promise<AdminUserRow[]> {
  const db = getDb(env);
  const where: string[] = ["u.DEL_FLG = 0"];
  const binds: Array<string | number> = [];

  if (q.email) {
    where.push("u.LOGIN_MAIL LIKE ?");
    binds.push("%" + q.email + "%");
  }
  if (q.status !== null && q.status !== undefined) {
    where.push("u.STATUS = ?");
    binds.push(q.status);
  }
  if (q.productCode) {
    where.push(
      `EXISTS (SELECT 1 FROM T_USER_PRODUCT up2
               JOIN M_PRODUCT p2 ON p2.PRODUCT_ID = up2.PRODUCT_ID
               WHERE up2.AUTH_USER_ID = u.AUTH_USER_ID AND p2.PRODUCT_CODE = ? AND up2.DEL_FLG = 0)`,
    );
    binds.push(q.productCode);
  }

  const sql =
    `SELECT u.AUTH_USER_ID AS authUserId, u.LOGIN_MAIL AS email, u.STATUS AS status,
            u.CREATE_DATE AS createdAt, u.LAST_LOGIN_DATE AS lastLoginAt
     FROM M_USER u
     WHERE ${where.join(" AND ")}
     ORDER BY u.CREATE_DATE DESC
     LIMIT ? OFFSET ?`;
  binds.push(q.limit, q.offset);

  const rows = await db.prepare(sql).bind(...binds).all<{
    authUserId: string;
    email: string;
    status: number;
    createdAt: string;
    lastLoginAt: string | null;
  }>();

  const users = rows.results ?? [];
  if (users.length === 0) return [];

  const ids = users.map((u) => u.authUserId);
  const placeholders = ids.map(() => "?").join(",");

  const prodRows = await db
    .prepare(
      `SELECT up.AUTH_USER_ID AS uid, p.PRODUCT_CODE AS code
       FROM T_USER_PRODUCT up JOIN M_PRODUCT p ON p.PRODUCT_ID = up.PRODUCT_ID
       WHERE up.AUTH_USER_ID IN (${placeholders}) AND up.DEL_FLG = 0`,
    )
    .bind(...ids)
    .all<{ uid: string; code: string }>();

  const accessRows = await db
    .prepare(
      `SELECT AUTH_USER_ID AS uid, MAX(ACCESS_DATE) AS lastAccess
       FROM T_ACCESS_LOG WHERE AUTH_USER_ID IN (${placeholders})
       GROUP BY AUTH_USER_ID`,
    )
    .bind(...ids)
    .all<{ uid: string; lastAccess: string }>();

  const prodMap = new Map<string, string[]>();
  for (const r of prodRows.results ?? []) {
    const arr = prodMap.get(r.uid) ?? [];
    arr.push(r.code);
    prodMap.set(r.uid, arr);
  }
  const accessMap = new Map<string, string>();
  for (const r of accessRows.results ?? []) accessMap.set(r.uid, r.lastAccess);

  return users.map((u) => ({
    authUserId: u.authUserId,
    email: u.email,
    status: u.status,
    products: prodMap.get(u.authUserId) ?? [],
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    lastAccessAt: accessMap.get(u.authUserId) ?? null,
  }));
}

/** Warning 検索クエリ（検証済みの値のみを受け取る） */
export interface WarningSearchQuery {
  status?: number | null;
  warningType?: string | null;
  authUserId?: string | null;
  from?: string | null;
  to?: string | null;
  limit: number;
  offset: number;
}

/** Warning 一覧の1行 */
export interface AdminWarningRow {
  warningId: number;
  email: string | null;
  productCode: string | null;
  warningType: string;
  warningScore: number;
  detectDate: string;
  notifiedDate: string | null;
  status: number;
}

/** Warning 一覧を検索する。値は必ず bind。 */
export async function searchWarnings(env: Env, q: WarningSearchQuery): Promise<AdminWarningRow[]> {
  const db = getDb(env);
  const where: string[] = ["1 = 1"];
  const binds: Array<string | number> = [];

  if (q.status !== null && q.status !== undefined) {
    where.push("w.STATUS = ?");
    binds.push(q.status);
  }
  if (q.warningType) {
    where.push("w.WARNING_TYPE = ?");
    binds.push(q.warningType);
  }
  if (q.authUserId) {
    where.push("w.AUTH_USER_ID = ?");
    binds.push(q.authUserId);
  }
  if (q.from) {
    where.push("w.DETECT_DATE >= ?");
    binds.push(q.from);
  }
  if (q.to) {
    where.push("w.DETECT_DATE <= ?");
    binds.push(q.to);
  }

  const sql =
    `SELECT w.WARNING_ID AS warningId, u.LOGIN_MAIL AS email, p.PRODUCT_CODE AS productCode,
            w.WARNING_TYPE AS warningType, w.WARNING_SCORE AS warningScore,
            w.DETECT_DATE AS detectDate, w.NOTIFIED_DATE AS notifiedDate, w.STATUS AS status
     FROM T_WARNING w
     LEFT JOIN M_USER u ON u.AUTH_USER_ID = w.AUTH_USER_ID
     LEFT JOIN M_PRODUCT p ON p.PRODUCT_ID = w.PRODUCT_ID
     WHERE ${where.join(" AND ")}
     ORDER BY w.DETECT_DATE DESC
     LIMIT ? OFFSET ?`;
  binds.push(q.limit, q.offset);

  const rows = await db.prepare(sql).bind(...binds).all<AdminWarningRow>();
  return rows.results ?? [];
}
