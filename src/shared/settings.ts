/**
 * システム設定取得共通関数
 *
 * M_SYSTEM_SETTING から設定値を取得する。
 * 設定値は DB 上 TEXT のため、まず文字列として取得する。
 *
 * 設計根拠:
 * - api/API.md 12「共通サーバー関数: getSystemSetting()」
 * - database/TABLES.md M_SYSTEM_SETTING「設定値は文字列で保持し、利用側で型変換する」
 * - REVIEW_RULE.md 5「Prepared Statement」
 *
 * 存在しないキーの扱い:
 * - null を返す（明示）。空文字は返さない。
 * - 「設定が無い」ことを呼出側が判定できるようにするため。
 */

import { getDb } from "./db";
import type { Env } from "../index";

/**
 * 設定値を文字列で取得する。
 * @param env 環境
 * @param key 設定キー（M_SYSTEM_SETTING.SETTING_KEY）
 * @returns 設定値の文字列。キーが存在しなければ null。
 */
export async function getSystemSetting(env: Env, key: string): Promise<string | null> {
  const db = getDb(env);
  const row = await db
    .prepare("SELECT SETTING_VALUE FROM M_SYSTEM_SETTING WHERE SETTING_KEY = ?")
    .bind(key)
    .first<{ SETTING_VALUE: string }>();
  if (!row) {
    return null;
  }
  return row.SETTING_VALUE;
}

/**
 * 設定値を整数で取得する補助関数。
 *
 * - キーが存在しない、または整数として解釈できない場合は fallback を返す。
 * - fallback を渡さない場合は null を返す。
 * - 正本にない設定キーや既定値をここで勝手に増やさない（fallback は呼出側の責任）。
 *
 * @param env 環境
 * @param key 設定キー
 * @param fallback キー不在・変換不能時に返す値（省略時 null）
 * @returns 整数、または fallback
 */
export async function getSystemSettingAsInt(
  env: Env,
  key: string,
  fallback: number | null = null,
): Promise<number | null> {
  const raw = await getSystemSetting(env, key);
  if (raw === null) {
    return fallback;
  }
  // 整数のみ許容（小数・非数値・空文字は fallback）
  if (!/^-?\d+$/.test(raw.trim())) {
    return fallback;
  }
  return Number.parseInt(raw.trim(), 10);
}
