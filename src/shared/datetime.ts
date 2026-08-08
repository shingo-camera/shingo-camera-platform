/**
 * 日時共通関数
 *
 * API 内部の現在日時生成を共通化する。保存は ISO 8601 の TEXT。
 * タイムゾーンは日本時間（JST, +09:00）で統一する。
 *
 * 設計根拠:
 * - DATABASE.md 4.6「D1にはISO 8601形式のTEXTで保存」
 *   例: 2026-08-05T17:30:00+09:00（+09:00 オフセット付き）
 *   「アプリ内では日本時間を基本表示」「保存時のタイムゾーン方針を共通関数に統一」
 * - api/API.md 6「API内部の現在日時生成は共通関数を使用」
 *
 * 注意:
 * - new Date().toISOString() は UTC(末尾 Z) を返すため使用しない。
 *   時刻の値自体を JST にし、末尾を +09:00 とする。
 */

/** JST は UTC+9 時間 */
const JST_OFFSET_MIN = 9 * 60;

/** 2桁ゼロ埋め */
function p2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 3桁ゼロ埋め（ミリ秒） */
function p3(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * 現在時刻を日本時間（+09:00）の ISO 8601 文字列で返す。
 *
 * UTC のエポックミリ秒に JST オフセットを加えた「壁時計時刻」を組み立て、
 * 末尾に固定で +09:00 を付す。
 *
 * @returns 例: "2026-08-07T16:14:10.956+09:00"
 */
export function nowIso(): string {
  const nowMs = Date.now();
  // JST の壁時計時刻を得るため、UTC ミリ秒へオフセット分を加算し、
  // その値を UTC として各要素を取り出す（getUTC* を使う）。
  const jst = new Date(nowMs + JST_OFFSET_MIN * 60 * 1000);
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
 * JST 当日の開始（00:00:00）と翌日の開始を +09:00 ISO 文字列で返す。
 *
 * 用途:
 * - ダッシュボードの「当日」集計で、JST 当日開始 / 翌日開始の 2 値を生成する。
 * - dashboard 側ではこの 2 値を Prepared Statement + bind し、D1 上の文字列比較
 *     CREATE_DATE  >= ? AND CREATE_DATE  < ?
 *     PURCHASE_DATE >= ? AND PURCHASE_DATE < ?
 *   の範囲比較（>= 当日開始, < 翌日開始）で判定する。prefix LIKE は使用しない。
 *
 * 文字列比較で安全な理由:
 * - 生成する境界は秒 00・ミリ秒なしの 00:00:00 に固定する。
 * - 同一秒内では「ミリ秒なし境界」の秒直後 '+'(0x2B) が「ミリ秒あり保存値」の
 *   '.'(0x2E) や数字より小さいため、>= 当日開始は当日開始ジャストを含み、
 *   < 翌日開始は翌日開始ジャストを除く。保存値のミリ秒有無に関わらず日境界が
 *   正しく判定され、日跨ぎ・月跨ぎ・年跨ぎでも桁ズレしない。
 *
 * @returns { start: "YYYY-MM-DDT00:00:00+09:00", nextStart: 翌日 }
 */
export function jstDayRange(baseMs: number = Date.now()): { start: string; nextStart: string } {
  const jst = new Date(baseMs + JST_OFFSET_MIN * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = jst.getUTCMonth();
  const d = jst.getUTCDate();
  // 当日 00:00 (JST) の UTC ミリ秒を作る。UTC で組み立てた値から JST 分を引く。
  const startUtcMs = Date.UTC(y, mo, d, 0, 0, 0) - JST_OFFSET_MIN * 60 * 1000;
  const nextUtcMs = startUtcMs + 24 * 60 * 60 * 1000;
  return { start: toJstIsoNoMs(startUtcMs), nextStart: toJstIsoNoMs(nextUtcMs) };
}

/** UTC ミリ秒を JST 壁時計の ISO 文字列（ミリ秒なし）へ変換 */
function toJstIsoNoMs(utcMs: number): string {
  const jst = new Date(utcMs + JST_OFFSET_MIN * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = p2(jst.getUTCMonth() + 1);
  const d = p2(jst.getUTCDate());
  const h = p2(jst.getUTCHours());
  const mi = p2(jst.getUTCMinutes());
  const s = p2(jst.getUTCSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}
