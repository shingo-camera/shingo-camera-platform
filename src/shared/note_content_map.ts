/**
 * note コンテンツ名 → PRODUCT_CODE 正規化
 *
 * 実 CSV（6月・7月）で確認済みの既知タイトルのみを完全一致でマッピングする。
 * 曖昧な部分一致・推測は行わない。空白表記の差異（前後空白・半角/全角・連続空白）
 * だけは安全に吸収する。
 *
 * 設計根拠:
 * - WORK-008 確定事項 7/8
 * - api/NOTE_MIGRATION_API.md 7
 *
 * 未知タイトルは null を返し、呼出側（CSV 取込）で取込エラー行として扱う。
 * DB に元タイトルは保存しない（PRODUCT_ID へ正規化のみ）。
 */

/**
 * 比較用にタイトルを正規化する。
 * - 前後空白を除去
 * - 半角スペース / 全角スペース（U+3000）をいずれも半角スペース1個として扱う
 * - 連続する空白を1つに畳む
 *
 * 注意: 空白以外の文字（【】！等）は変更しない（曖昧一致を避けるため）。
 */
export function normalizeContentName(raw: string): string {
  return raw
    .replace(/[\u3000\s]+/g, " ") // 全角スペース・各種空白を半角1個に
    .trim();
}

/**
 * 既知タイトル（正規化後）→ PRODUCT_CODE。
 * キーは normalizeContentName を通した後の文字列。
 *
 * HANABI 本体:
 * - 花火撮影のロケハンやシミュレーションの為のアプリを作りました！
 * - 花火撮影のロケハンやシミュレーションの為のアプリを作りました！　【HANABI PLANNER】
 * HANABI_GOOGLE_EARTH（Google Earth Pro 連携。旧タイトル「バーチャルシミュレーションの最終形」含む）:
 * - HANABI PLANNER【追加機能販売】　バーチャルシミュレーションの最終形
 * - HANABI PLANNER 追加機能　　Google Earth Pro連携
 */
const KNOWN_TITLE_TO_CODE: ReadonlyArray<readonly [string, string]> = [
  ["花火撮影のロケハンやシミュレーションの為のアプリを作りました！", "HANABI"],
  ["花火撮影のロケハンやシミュレーションの為のアプリを作りました！ 【HANABI PLANNER】", "HANABI"],
  ["HANABI PLANNER【追加機能販売】 バーチャルシミュレーションの最終形", "HANABI_GOOGLE_EARTH"],
  ["HANABI PLANNER 追加機能 Google Earth Pro連携", "HANABI_GOOGLE_EARTH"],
];

/** 正規化済みキーの Map（モジュール初期化時に構築） */
const NORMALIZED_MAP: ReadonlyMap<string, string> = new Map(
  KNOWN_TITLE_TO_CODE.map(([title, code]) => [normalizeContentName(title), code]),
);

/**
 * コンテンツ名から PRODUCT_CODE を解決する。
 * 空白差異を吸収した完全一致のみ。未知タイトルは null。
 *
 * @param rawContentName CSV のコンテンツ名（生値）
 * @returns "HANABI" | "HANABI_GOOGLE_EARTH" | null（未知）
 */
export function resolveProductCodeFromContentName(rawContentName: string): string | null {
  const key = normalizeContentName(rawContentName);
  return NORMALIZED_MAP.get(key) ?? null;
}
