/**
 * SESSION_ID_HASH 生成共通関数
 *
 * 検証済み Supabase JWT の session_id を、サーバー側の秘密鍵で HMAC-SHA256 して
 * 決定的なハッシュへ変換する。T_ACCESS_LOG.SESSION_ID_HASH に保存し、
 * 「同一アカウント内の別セッション」を区別できるようにする。
 *
 * 設計方針:
 * - 生の session_id は保存しない（このハッシュのみを保存する）。
 * - 同一 session_id → 同一ハッシュ（決定的）。別 session_id → 異なるハッシュ。
 * - ハッシュ鍵はサーバー側の秘密（env.SESSION_ID_HASH_SECRET）。鍵を知らなければ
 *   ハッシュから session_id を逆算・照合できない。クライアント入力を鍵に使わない。
 * - session_id は requireUser が検証済み JWT payload から取り出し UUID 形式を確認した値のみ。
 *   欠落・不正形式（null）や鍵未設定なら null を返す（SESSION_ID_HASH は NULL・記録は継続）。
 *
 * 根拠:
 * - SECURITY.md「完全な JWT・秘密情報をログ出力しない」（生 session_id 非保存）
 * - 不正検知はセッション単位で別セッションを区別できることが要件（アカウント共有検知）
 */

/** SESSION_ID_HASH のプレフィクス（方式が変わったとき区別できるよう版を付す）。 */
const HASH_PREFIX = "v1:";

/**
 * 検証済み session_id をサーバー鍵で HMAC-SHA256 し、保存用ハッシュ文字列を返す。
 *
 * @param sessionId requireUser が検証済み・UUID 形式確認済みの session_id（null 可）
 * @param secret サーバー側の HMAC 鍵（env.SESSION_ID_HASH_SECRET。未設定なら null/undefined）
 * @returns "v1:<hex>" 形式のハッシュ。session_id か secret が無ければ null（安全側）。
 */
export async function computeSessionIdHash(
  sessionId: string | null | undefined,
  secret: string | null | undefined,
): Promise<string | null> {
  // クライアント由来の値を鍵にしない。session_id 欠損 or 鍵未設定なら安全側に null。
  if (!sessionId || typeof sessionId !== "string") return null;
  if (!secret || typeof secret !== "string" || secret.length === 0) return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(sessionId));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return HASH_PREFIX + hex;
}
