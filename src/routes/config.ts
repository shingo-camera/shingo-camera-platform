/**
 * GET /api/config
 *
 * フロント（認証画面）が Supabase クライアントを初期化するための
 * 「公開してよい設定値」だけを返す。
 *
 * 返すもの（フロント配布可）:
 * - SUPABASE_URL
 * - SUPABASE_ANON_KEY
 *
 * 絶対に返さないもの:
 * - SUPABASE_SERVICE_ROLE_KEY / STRIPE_SECRET_KEY 等の秘密情報
 *
 * 設計根拠:
 * - 指示: フロントへ置いてよいのは SUPABASE_URL / SUPABASE_ANON_KEY のみ
 * - SECURITY.md 2「Service Role Key 等をフロントへ渡さない」
 *
 * この方式により、Supabase の URL / anon key を静的HTMLへハードコードして
 * Git へコミットすることを避ける。値は Local は .dev.vars、Production は
 * Cloudflare 環境変数から取得する。
 */

import { jsonOk, jsonError } from "../shared/response";
import type { Env } from "../index";

/** /api/config の応答データ型 */
export interface ConfigData {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

/**
 * 公開設定を返す。
 * SUPABASE_URL / SUPABASE_ANON_KEY 未設定時は 500（内部設定不備）。
 */
export function handleConfig(env: Env): Response {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    console.error("[config] SUPABASE_URL or SUPABASE_ANON_KEY is not configured");
    return jsonError("INTERNAL_ERROR", "設定を取得できませんでした。", 500);
  }
  const data: ConfigData = {
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
  };
  return jsonOk(data);
}
