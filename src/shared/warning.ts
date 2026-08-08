/**
 * WORK-009 Warning Notification — 判定・登録・重複抑止
 *
 * 仕様の唯一の基準は最新正本:
 * - implementation/WORK-009_WARNING.md
 * - operation/WARNING.md
 * - adr/ADR-009_WARNING_EMAIL.md
 * - database/TABLES.md
 *
 * 初版で実装する Warning は 4 種のみ:
 *   LOGIN_FAILURE / MANY_DEVICES / MANY_REGIONS / COUNTRY_CHANGE
 * IMPOSSIBLE_TRAVEL / CONCURRENT_ACCESS は初版保留（本モジュールで生成しない）。
 *
 * 重要な制約:
 * - Warning 検知を理由に M_USER.STATUS / T_USER_PRODUCT.STATUS / 商品権限を自動変更しない。
 * - スコアは種別ごとに独立記録し、合算しない。WARNING_SCORE(=100) は初版の通知可否に使わない。
 * - 重複通知抑止は T_WARNING.NOTIFIED_DATE と WARNING_MAIL_INTERVAL_MIN(=60) を用いる。
 * - メール送信成功後にのみ NOTIFIED_DATE を更新する（送信は呼出側 = scheduled で実施）。
 */

import { getDb } from "./db";
import { nowIso } from "./datetime";
import { getSystemSettingAsInt } from "./settings";
import type { Env } from "../index";

/** 初版で実装する Warning 種別 */
export const WARNING_TYPE = {
  LOGIN_FAILURE: "LOGIN_FAILURE",
  MANY_DEVICES: "MANY_DEVICES",
  MANY_REGIONS: "MANY_REGIONS",
  COUNTRY_CHANGE: "COUNTRY_CHANGE",
} as const;
export type WarningType = (typeof WARNING_TYPE)[keyof typeof WARNING_TYPE];

/** T_LOGIN_LOG.LOGIN_RESULT の失敗値（logs.ts と一致）*/
const LOGIN_RESULT_FAILURE = 0;

/** 判定窓（分）。初版は固定値。変更用 SETTING_KEY は設けない（正本どおり）。*/
const LOGIN_FAILURE_WINDOW_MIN = 60;
const MANY_DEVICES_WINDOW_MIN = 24 * 60;
const MANY_REGIONS_WINDOW_MIN = 24 * 60;
const COUNTRY_CHANGE_WINDOW_MIN = 24 * 60;

/** 既定値（キー不在時の fallback。正本の初期値と一致）*/
const DEFAULT_LOGIN_FAIL_LIMIT = 5;
const DEFAULT_MANY_DEVICES_LIMIT = 4;
const DEFAULT_MANY_REGIONS_LIMIT = 3;
const COUNTRY_CHANGE_MIN_COUNTRIES = 2; // 固定条件（2か国以上）

const JST_OFFSET_MIN = 9 * 60;

function p2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function p3(n: number): string {
  return n < 100 ? (n < 10 ? `00${n}` : `0${n}`) : String(n);
}

/**
 * 指定 UTC ミリ秒を JST ISO8601（ミリ秒付き +09:00）へ変換する。
 * DETECT_DATE / PERIOD_END など「実行時刻」を表す値を nowMs 起点で統一するために使う。
 * datetime.ts の nowIso() と同一書式（ミリ秒 3 桁 +09:00）。
 */
export function jstIsoFromMs(utcMs: number): string {
  const jst = new Date(utcMs + JST_OFFSET_MIN * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = p2(jst.getUTCMonth() + 1);
  const d = p2(jst.getUTCDate());
  const h = p2(jst.getUTCHours());
  const mi = p2(jst.getUTCMinutes());
  const s = p2(jst.getUTCSeconds());
  const ms = p3(jst.getUTCMilliseconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}+09:00`;
}

/**
 * now から windowMin 分前の JST ISO 文字列（下限、これ以上を対象にする）。
 * ログ日時（LOGIN_DATE / ACCESS_DATE = nowIso() ミリ秒あり）と文字列比較で整合するよう、
 * ミリ秒あり書式（jstIsoFromMs）で生成する。
 */
function windowStartIso(windowMin: number, nowMs: number): string {
  return jstIsoFromMs(nowMs - windowMin * 60 * 1000);
}

/** 検知結果（1 件 = 1 種別）*/
export interface WarningDetection {
  authUserId: string;
  warningType: WarningType;
  score: number;
  /** 判定根拠の概要（メール本文用。秘密情報は含めない）*/
  detail: string;
  /** 判定期間 */
  periodStart: string;
  periodEnd: string;
  /** 検知の材料となった代表 PRODUCT_ID（アクセスログ由来のみ。ログイン失敗は null）*/
  productId: number | null;
  /**
   * この種別の判定窓（分）。継続事象の GAP（解消判定しきい値）として使う。
   * PERIOD_END がこの窓を超えて未更新なら「解消」とみなす。
   */
  windowMin: number;
}

interface Thresholds {
  loginFailLimit: number;
  manyDevicesLimit: number;
  manyRegionsLimit: number;
  deviceChangeScore: number;
  regionChangeScore: number;
  countryChangeScore: number;
}

async function loadThresholds(env: Env): Promise<Thresholds> {
  const [
    loginFailLimit,
    manyDevicesLimit,
    manyRegionsLimit,
    deviceChangeScore,
    regionChangeScore,
    countryChangeScore,
  ] = await Promise.all([
    getSystemSettingAsInt(env, "LOGIN_FAIL_LIMIT", DEFAULT_LOGIN_FAIL_LIMIT),
    getSystemSettingAsInt(env, "MANY_DEVICES_LIMIT", DEFAULT_MANY_DEVICES_LIMIT),
    getSystemSettingAsInt(env, "MANY_REGIONS_LIMIT", DEFAULT_MANY_REGIONS_LIMIT),
    getSystemSettingAsInt(env, "DEVICE_CHANGE_SCORE", 0),
    getSystemSettingAsInt(env, "REGION_CHANGE_SCORE", 0),
    getSystemSettingAsInt(env, "COUNTRY_CHANGE_SCORE", 0),
  ]);
  return {
    loginFailLimit: loginFailLimit ?? DEFAULT_LOGIN_FAIL_LIMIT,
    manyDevicesLimit: manyDevicesLimit ?? DEFAULT_MANY_DEVICES_LIMIT,
    manyRegionsLimit: manyRegionsLimit ?? DEFAULT_MANY_REGIONS_LIMIT,
    deviceChangeScore: deviceChangeScore ?? 0,
    regionChangeScore: regionChangeScore ?? 0,
    countryChangeScore: countryChangeScore ?? 0,
  };
}

/**
 * 全ユーザーを走査し、4 種の Warning を判定する。
 * 検知は種別ごとに独立。複数種別が同時検知されてもスコアは合算しない。
 */
export async function detectWarnings(env: Env, nowMs: number = Date.now()): Promise<WarningDetection[]> {
  const db = getDb(env);
  const th = await loadThresholds(env);
  const detections: WarningDetection[] = [];

  // 実行時刻は nowMs 起点で統一する（判定基準・DETECT_DATE・PERIOD_END の時刻源を一致させる）。
  const nowIsoStr = jstIsoFromMs(nowMs);

  // ---- LOGIN_FAILURE: 直近60分の失敗ログイン回数 >= loginFailLimit ----
  {
    const start = windowStartIso(LOGIN_FAILURE_WINDOW_MIN, nowMs);
    const rows = await db
      .prepare(
        `SELECT AUTH_USER_ID AS authUserId, COUNT(*) AS cnt
           FROM T_LOGIN_LOG
          WHERE LOGIN_RESULT = ? AND LOGIN_DATE >= ? AND AUTH_USER_ID IS NOT NULL
          GROUP BY AUTH_USER_ID
         HAVING COUNT(*) >= ?`,
      )
      .bind(LOGIN_RESULT_FAILURE, start, th.loginFailLimit)
      .all<{ authUserId: string; cnt: number }>();
    for (const r of rows.results ?? []) {
      detections.push({
        authUserId: r.authUserId,
        warningType: WARNING_TYPE.LOGIN_FAILURE,
        score: 0, // 正本: LOGIN_FAILURE のスコア記録値は 0
        detail: `直近60分のログイン失敗 ${r.cnt} 回（閾値 ${th.loginFailLimit}）`,
        periodStart: start,
        periodEnd: nowIsoStr,
        productId: null,
        windowMin: LOGIN_FAILURE_WINDOW_MIN,
      });
    }
  }

  // ---- MANY_DEVICES: 直近24時間の異なる DEVICE_ID 数 >= manyDevicesLimit ----
  // NULL/空 DEVICE_ID は数えない。
  {
    const start = windowStartIso(MANY_DEVICES_WINDOW_MIN, nowMs);
    const rows = await db
      .prepare(
        `SELECT AUTH_USER_ID AS authUserId, COUNT(DISTINCT DEVICE_ID) AS cnt
           FROM T_ACCESS_LOG
          WHERE ACCESS_DATE >= ?
            AND DEVICE_ID IS NOT NULL AND TRIM(DEVICE_ID) <> ''
          GROUP BY AUTH_USER_ID
         HAVING COUNT(DISTINCT DEVICE_ID) >= ?`,
      )
      .bind(start, th.manyDevicesLimit)
      .all<{ authUserId: string; cnt: number }>();
    for (const r of rows.results ?? []) {
      detections.push({
        authUserId: r.authUserId,
        warningType: WARNING_TYPE.MANY_DEVICES,
        score: th.deviceChangeScore, // 正本: DEVICE_CHANGE_SCORE
        detail: `直近24時間の端末数 ${r.cnt}（閾値 ${th.manyDevicesLimit}）`,
        periodStart: start,
        periodEnd: nowIsoStr,
        productId: null,
        windowMin: MANY_DEVICES_WINDOW_MIN,
      });
    }
  }

  // ---- MANY_REGIONS: 直近24時間の異なる地域(COUNTRY_CODE+REGION)数 >= manyRegionsLimit ----
  // COUNTRY_CODE / REGION が判定不能なログを独立地域として水増ししない
  // → COUNTRY_CODE, REGION が両方とも有効な行のみを対象に DISTINCT(COUNTRY_CODE||'\u0001'||REGION) を数える。
  {
    const start = windowStartIso(MANY_REGIONS_WINDOW_MIN, nowMs);
    const rows = await db
      .prepare(
        `SELECT AUTH_USER_ID AS authUserId,
                COUNT(DISTINCT COUNTRY_CODE || CHAR(1) || REGION) AS cnt
           FROM T_ACCESS_LOG
          WHERE ACCESS_DATE >= ?
            AND COUNTRY_CODE IS NOT NULL AND TRIM(COUNTRY_CODE) <> ''
            AND REGION IS NOT NULL AND TRIM(REGION) <> ''
          GROUP BY AUTH_USER_ID
         HAVING COUNT(DISTINCT COUNTRY_CODE || CHAR(1) || REGION) >= ?`,
      )
      .bind(start, th.manyRegionsLimit)
      .all<{ authUserId: string; cnt: number }>();
    for (const r of rows.results ?? []) {
      detections.push({
        authUserId: r.authUserId,
        warningType: WARNING_TYPE.MANY_REGIONS,
        score: th.regionChangeScore, // 正本: REGION_CHANGE_SCORE
        detail: `直近24時間の地域数 ${r.cnt}（閾値 ${th.manyRegionsLimit}）`,
        periodStart: start,
        periodEnd: nowIsoStr,
        productId: null,
        windowMin: MANY_REGIONS_WINDOW_MIN,
      });
    }
  }

  // ---- COUNTRY_CHANGE: 直近24時間の異なる有効 COUNTRY_CODE 数 >= 2 ----
  // NULL/空 COUNTRY_CODE は国数に数えない。固定条件のため国数用 SETTING_KEY は使わない。
  {
    const start = windowStartIso(COUNTRY_CHANGE_WINDOW_MIN, nowMs);
    const rows = await db
      .prepare(
        `SELECT AUTH_USER_ID AS authUserId, COUNT(DISTINCT COUNTRY_CODE) AS cnt
           FROM T_ACCESS_LOG
          WHERE ACCESS_DATE >= ?
            AND COUNTRY_CODE IS NOT NULL AND TRIM(COUNTRY_CODE) <> ''
          GROUP BY AUTH_USER_ID
         HAVING COUNT(DISTINCT COUNTRY_CODE) >= ?`,
      )
      .bind(start, COUNTRY_CHANGE_MIN_COUNTRIES)
      .all<{ authUserId: string; cnt: number }>();
    for (const r of rows.results ?? []) {
      detections.push({
        authUserId: r.authUserId,
        warningType: WARNING_TYPE.COUNTRY_CHANGE,
        score: th.countryChangeScore, // 正本: COUNTRY_CHANGE_SCORE
        detail: `直近24時間の国数 ${r.cnt}（閾値 ${COUNTRY_CHANGE_MIN_COUNTRIES}）`,
        periodStart: start,
        periodEnd: nowIsoStr,
        productId: null,
        windowMin: COUNTRY_CHANGE_WINDOW_MIN,
      });
    }
  }

  return detections;
}

/** 継続事象として再利用する既存 T_WARNING 行の情報 */
export interface ActiveWarningRow {
  warningId: number;
  status: number;
  notifiedDate: string | null;
}

/**
 * 継続事象として再利用できる既存 T_WARNING 行を探す。
 *
 * 正本確定仕様:
 * - 同一 AUTH_USER_ID + WARNING_TYPE について、PERIOD_END が GAP（= 判定窓 windowMin）以内の
 *   既存行があれば、STATUS（0/1/2/9）を問わず同一の継続事象としてその行を再利用する。
 * - 管理者が STATUS を変更していても、条件が継続している同じ Warning の新規行は作らない。
 * - PERIOD_END が GAP を超えている行は「解消済み」とみなし、再利用しない（＝新規事象扱い）。
 *
 * GAP は種別の判定窓と同値（windowMin）。しきい値の下限 = now - windowMin。
 * PERIOD_END > 下限 の最新行（WARNING_ID 最大）を継続行とする。
 *
 * @returns 継続行があればその情報、なければ null（呼出側が新規 INSERT する）。
 */
export async function findActiveWarning(
  env: Env,
  authUserId: string,
  warningType: WarningType,
  windowMin: number,
  nowMs: number = Date.now(),
): Promise<ActiveWarningRow | null> {
  const db = getDb(env);
  // PERIOD_END（ミリ秒あり +09:00）と同一書式で下限を作り、文字列比較の整合を保つ。
  // 継続判定は「PERIOD_END が GAP 以内」= PERIOD_END >= 下限（GAP ちょうども継続とみなす）。
  const gapFloor = jstIsoFromMs(nowMs - windowMin * 60 * 1000);
  const row = await db
    .prepare(
      `SELECT WARNING_ID AS warningId, STATUS AS status, NOTIFIED_DATE AS notifiedDate
         FROM T_WARNING
        WHERE AUTH_USER_ID = ? AND WARNING_TYPE = ?
          AND PERIOD_END IS NOT NULL AND PERIOD_END >= ?
        ORDER BY WARNING_ID DESC
        LIMIT 1`,
    )
    .bind(authUserId, warningType, gapFloor)
    .first<{ warningId: number; status: number; notifiedDate: string | null }>();
  if (!row) {
    return null;
  }
  return { warningId: row.warningId, status: row.status, notifiedDate: row.notifiedDate };
}

/**
 * 継続事象の既存行を最新状態へ更新する（PERIOD_END / WARNING_SCORE / UPDATE_DATE）。
 * DETECT_DATE / PERIOD_START は初回値を固定し更新しない。
 * STATUS / MEMO / LAST_ACTION_DATE は管理者領域のため Cron から変更しない。
 */
export async function touchActiveWarning(
  env: Env,
  warningId: number,
  score: number,
  periodEnd: string,
  nowIsoStr: string,
): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `UPDATE T_WARNING
          SET PERIOD_END = ?, WARNING_SCORE = ?, UPDATE_DATE = ?
        WHERE WARNING_ID = ?`,
    )
    .bind(periodEnd, score, nowIsoStr, warningId)
    .run();
}

/**
 * T_WARNING へ 1 件登録し、生成された WARNING_ID を返す。
 * NOTIFIED_DATE はここでは設定しない（メール送信成功後に updateNotifiedDate で設定）。
 * STATUS=0（未対応）で登録。自動停止は一切行わない。
 */
export async function insertWarning(
  env: Env,
  d: WarningDetection,
  nowIsoStr: string = nowIso(),
): Promise<number> {
  const db = getDb(env);
  const res = await db
    .prepare(
      `INSERT INTO T_WARNING
         (AUTH_USER_ID, PRODUCT_ID, WARNING_TYPE, WARNING_SCORE, DETECT_DATE,
          PERIOD_START, PERIOD_END, NOTIFIED_DATE, STATUS, MEMO, CREATE_DATE, UPDATE_DATE)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)`,
    )
    .bind(
      d.authUserId,
      d.productId,
      d.warningType,
      d.score,
      nowIsoStr,
      d.periodStart,
      d.periodEnd,
      nowIsoStr,
      nowIsoStr,
    )
    .run();
  // D1 の run() は meta.last_row_id を返す
  const meta = (res as unknown as { meta?: { last_row_id?: number } }).meta;
  return meta?.last_row_id ?? 0;
}

/**
 * メール送信成功後にのみ NOTIFIED_DATE を更新する。
 * Resend 失敗時はこの関数を呼ばないこと（未通知のまま残す）。
 */
export async function updateNotifiedDate(
  env: Env,
  warningId: number,
  nowIsoStr: string = nowIso(),
): Promise<void> {
  const db = getDb(env);
  await db
    .prepare("UPDATE T_WARNING SET NOTIFIED_DATE = ?, UPDATE_DATE = ? WHERE WARNING_ID = ?")
    .bind(nowIsoStr, nowIsoStr, warningId)
    .run();
}
