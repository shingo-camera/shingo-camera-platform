/**
 * DEV shim 用の純粋関数（依存なし・単体テスト対象）。
 * index.ts の DEV shim から利用する。Production では DEV_BASE_PATH 未設定のため呼ばれない。
 */

/**
 * DEV_BASE_PATH をパス先頭から取り除いた内部パスを返す（"/dev/api/x" → "/api/x"）。
 * base 自身（"/dev"）は "/" にする。base 配下でなければ null。
 */
export function stripDevPrefix(pathname: string, base: string): string | null {
  if (pathname === base) return "/";
  if (pathname.startsWith(base + "/")) return pathname.slice(base.length) || "/";
  return null;
}

/**
 * HTML のルート相対属性値（href/src/action/poster）へ DEV base を前置すべきか判定し変換する。
 * - "/..." で始まるルート相対のみ前置（"/dev/..."）。
 * - 外部 URL(http/https/プロトコル相対 //)・既に base 済み・hash(#)・data:・空・null は素通し。
 */
export function devPrefixAttr(value: string | null, base: string): string | null {
  if (value == null || value === "") return value;
  if (value[0] !== "/") return value;                 // 相対/スキーム付きは対象外
  if (value.indexOf("//") === 0) return value;        // プロトコル相対 //host は外部
  if (value === base || value.indexOf(base + "/") === 0) return value; // 既に /dev 済み
  return base + value;                                 // ルート相対 → /dev 前置
}
