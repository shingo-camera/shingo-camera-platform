/**
 * DB接続共通関数
 *
 * Cloudflare D1 への接続を共通化する。
 * 各ルート・サービスは env.DB を直接触らず、この関数経由で D1 を取得する。
 * これにより binding 名の変更やラップ処理の追加を1箇所へ集約できる。
 *
 * 設計根拠:
 * - ARCHITECTURE.md 3「共通化するもの: D1接続」
 * - REVIEW_RULE.md 5「Prepared Statement」（利用側で bind を徹底する前提）
 *
 * 注意:
 * - D1 は Prepared Statement (db.prepare(...).bind(...)) を使用する。
 *   文字列連結による SQL 組み立てを行わない。
 * - 複数テーブル同時更新は db.batch(...) を使用する（API.md 8, WORK後続で使用）。
 */

import type { Env } from "../index";

/**
 * D1 データベースを取得する。
 *
 * binding 未設定（ローカルで d1_databases 未設定など）の場合は明示的に throw し、
 * 「なぜか undefined を触ってしまう」事故を防ぐ。
 *
 * @param env Workers 環境バインディング
 * @returns D1Database
 * @throws binding が存在しない場合
 */
export function getDb(env: Env): D1Database {
  if (!env.DB) {
    // 設定ミスは内部エラー。利用者向けメッセージには詳細を出さない（呼び出し側で整形）。
    throw new Error("D1 binding 'DB' is not configured");
  }
  return env.DB;
}
