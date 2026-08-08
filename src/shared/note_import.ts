/**
 * note 販売履歴 CSV の取込ロジック
 *
 * 増分取込。NOTE_TRANSACTION_ID を冪等キーとし、同一 CSV 再投入・複数月・順不同でも
 * 既存を壊さず新規行のみ INSERT する。
 *
 * 設計根拠:
 * - WORK-008 確定事項 1/2/3/5/6/7/8/9/16
 * - api/NOTE_MIGRATION_API.md 7, api/ADMIN_API.md 10
 *
 * 取込対象: 決済種別 = 販売 かつ コンテンツ種別 = 有料記事。
 * 除外: コンテンツ種別 = チップ（ignoredTips）、決済種別 <> 販売（対象外）。
 * 未知タイトル: 自動推測せず取込エラー（errors）。DB へ保存しない。
 *
 * ヘッダ: 列数を固定検証しない。必須ヘッダの存在のみ確認し、
 *   不要列・将来の追加列は無視する。必須ヘッダ欠落は取込エラー。
 */

import { getDb } from "./db";
import { nowIso } from "./datetime";
import { resolveProductCodeFromContentName } from "./note_content_map";
import { getActiveProductByCode } from "./entitlement";
import { AppError } from "./errors";
import type { Env } from "../index";

/** WORK-008 で使用する必須ヘッダ */
const REQUIRED_HEADERS = [
  "決済/返金日時",
  "購入者名",
  "決済種別",
  "コンテンツ種別",
  "コンテンツ名",
  "販売額",
  "取引ID",
] as const;

/** 取込エラー行（管理者確認用） */
export interface ImportErrorRow {
  line: number; // CSV 上の行番号（ヘッダを 1 とし、データは 2 以降）
  contentName: string;
  transactionId: string;
  reason: string;
}

/** 取込結果サマリ（api/ADMIN_API.md 10 のレスポンス構造に対応） */
export interface ImportResult {
  read: number; // データ行数（ヘッダ除く）
  imported: number; // 新規 INSERT 件数
  ignoredTips: number; // チップ等の対象外件数
  duplicates: number; // 既存 NOTE_TRANSACTION_ID による重複スキップ
  errors: ImportErrorRow[]; // 未知タイトル等のエラー行
}

/** BOM を除去する */
function stripBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

/**
 * 最小限の CSV パーサ（ダブルクォート対応、改行は LF/CRLF）。
 * note の販売履歴 CSV を対象とする。フィールド内のカンマ・改行・エスケープ("")に対応。
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const s = text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // CRLF の CR は無視（次の \n で行確定）。単独 CR は行確定にしない。
      } else {
        field += c;
      }
    }
  }
  // 末尾フィールド/行（最終行に改行がない場合）
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * 14 桁 YYYYMMDDHHmmss（JST 前提）を JST ISO 文字列へ変換する。
 * 例: 20260701001025 → 2026-07-01T00:10:25+09:00
 *
 * 入力した年月日時そのものが実在することを厳密に検証する。
 * うるう年・月ごとの日数・時分秒の実在を、UTC で Date を構築して
 * 各要素が入力と一致するか（正規化で別日付にずれていないか）で判定する。
 * 例: 20260231（2月31日）は Date が 3/3 等へ正規化されるため不正として弾く。
 *
 * @returns ISO 文字列、形式不正・非実在日付は null
 */
export function parseNoteDate(raw: string): string | null {
  const t = raw.trim();
  if (!/^\d{14}$/.test(t)) return null;
  const y = Number(t.slice(0, 4));
  const mo = Number(t.slice(4, 6));
  const d = Number(t.slice(6, 8));
  const h = Number(t.slice(8, 10));
  const mi = Number(t.slice(10, 12));
  const s = Number(t.slice(12, 14));

  // 粗い範囲チェック（早期リターン）
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;

  // 実在チェック: UTC で構築し、各要素が入力と一致するか
  // （2月31日等は別日付へ正規化されるため getUTC* が一致しない → 不正）
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d ||
    dt.getUTCHours() !== h ||
    dt.getUTCMinutes() !== mi ||
    dt.getUTCSeconds() !== s
  ) {
    return null;
  }

  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}+09:00`;
}

/** 販売額をパースする（整数のみ。記号・区切りは想定しないが空白/カンマは許容） */
function parseAmount(raw: string): number | null {
  const t = raw.replace(/[,\s]/g, "").trim();
  if (!/^\d+$/.test(t)) return null;
  return Number.parseInt(t, 10);
}

/**
 * CSV テキストを取り込む。
 *
 * @param env
 * @param csvText CSV 全文（BOM 付き可）
 * @returns 取込結果サマリ
 * @throws AppError 必須ヘッダ欠落等（取込全体を中止する構造的エラー）
 */
export async function importNoteCsv(env: Env, csvText: string): Promise<ImportResult> {
  const db = getDb(env);
  const now = nowIso();

  const text = stripBom(csvText);
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new AppError("VALIDATION_ERROR", "CSV が空です。", 400);
  }

  // ヘッダ検証（列数固定ではなく必須ヘッダの存在確認）
  const header = rows[0].map((h) => h.trim());
  const colIndex: Record<string, number> = {};
  for (const req of REQUIRED_HEADERS) {
    const idx = header.indexOf(req);
    if (idx === -1) {
      throw new AppError("VALIDATION_ERROR", `必須ヘッダがありません: ${req}`, 400);
    }
    colIndex[req] = idx;
  }

  // PRODUCT_CODE → PRODUCT_ID を事前解決（HANABI / HANABI_GOOGLE_EARTH）
  const productIdCache = new Map<string, number>();
  async function resolveProductId(code: string): Promise<number | null> {
    if (productIdCache.has(code)) return productIdCache.get(code)!;
    const p = await getActiveProductByCode(env, code);
    if (!p) return null;
    productIdCache.set(code, p.PRODUCT_ID);
    return p.PRODUCT_ID;
  }

  const result: ImportResult = { read: 0, imported: 0, ignoredTips: 0, duplicates: 0, errors: [] };

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    // 空行スキップ（全フィールド空）
    if (cols.every((c) => c.trim() === "")) continue;
    result.read++;
    const lineNo = r + 1; // ヘッダを 1 行目とした CSV 上の行番号

    const get = (key: string) => (cols[colIndex[key]] ?? "").trim();
    const paymentType = get("決済種別");
    const contentType = get("コンテンツ種別");
    const contentName = get("コンテンツ名");
    const transactionId = get("取引ID");

    // 決済種別 = 販売 のみ対象（それ以外は対象外＝ignoredTips に集約せず errors でもなく対象外カウント）
    // 確定事項: 販売以外は取込対象外。ここでは ignoredTips とは別概念だが、
    // レスポンス構造上「対象外」を ignoredTips に集約せず、チップと明確に分けるため
    // 販売以外 かつ チップ は ignoredTips、販売以外 かつ 非チップ も対象外として ignoredTips に含める。
    // → 確定事項8「チップ等の対象外件数」に合わせ、取込対象外は ignoredTips で数える。
    if (contentType === "チップ") {
      result.ignoredTips++;
      continue;
    }
    if (paymentType !== "販売") {
      // 販売以外（返金など）は取込対象外。権限処理も行わない。
      result.ignoredTips++;
      continue;
    }
    if (contentType !== "有料記事") {
      // 有料記事でもチップでもない未知のコンテンツ種別は対象外
      result.ignoredTips++;
      continue;
    }

    // コンテンツ名 → PRODUCT_CODE（空白吸収の完全一致。未知はエラー行）
    const code = resolveProductCodeFromContentName(contentName);
    if (!code) {
      result.errors.push({ line: lineNo, contentName, transactionId, reason: "未知のコンテンツ名" });
      continue;
    }
    const productId = await resolveProductId(code);
    if (productId === null) {
      result.errors.push({ line: lineNo, contentName, transactionId, reason: "商品が見つかりません" });
      continue;
    }

    // 取引 ID 必須
    if (!transactionId) {
      result.errors.push({ line: lineNo, contentName, transactionId, reason: "取引IDがありません" });
      continue;
    }

    // 日時変換
    const purchaseDate = parseNoteDate(get("決済/返金日時"));
    if (!purchaseDate) {
      result.errors.push({ line: lineNo, contentName, transactionId, reason: "日時形式が不正" });
      continue;
    }

    // 金額
    const amount = parseAmount(get("販売額"));
    if (amount === null) {
      result.errors.push({ line: lineNo, contentName, transactionId, reason: "販売額が不正" });
      continue;
    }

    const noteId = get("購入者名"); // 実名/ハンドル/ゲストをそのまま保持

    // 冪等: 既存 NOTE_TRANSACTION_ID は重複スキップ
    const existing = await db
      .prepare("SELECT NOTE_PURCHASE_ID FROM T_NOTE_PURCHASE WHERE NOTE_TRANSACTION_ID = ?")
      .bind(transactionId)
      .first<{ NOTE_PURCHASE_ID: number }>();
    if (existing) {
      result.duplicates++;
      continue;
    }

    // 新規 INSERT（MATCH_STATUS=0 未移行）
    try {
      await db
        .prepare(
          `INSERT INTO T_NOTE_PURCHASE
             (PRODUCT_ID, NOTE_ID, NOTE_TRANSACTION_ID, PURCHASE_DATE, PURCHASE_AMOUNT,
              MATCH_STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        )
        .bind(productId, noteId, transactionId, purchaseDate, amount, now, now)
        .run();
      result.imported++;
    } catch (err) {
      // 事前 SELECT で既存重複は判定済み。ここに来る UNIQUE 競合は、
      // 同一 CSV 内の取引 ID 重複、または並行取込による競合に限られる。
      // それ以外（D1/SQL の想定外エラー）は握り潰さず、取込エラー行として記録する。
      const message = err instanceof Error ? err.message : String(err);
      const isUniqueViolation = /UNIQUE constraint failed/i.test(message);
      if (isUniqueViolation) {
        // 安全に識別できる UNIQUE 競合のみ重複として扱う
        result.duplicates++;
      } else {
        // 想定外の DB エラーは処理失敗としてエラー行に記録（正常終了させない）
        result.errors.push({
          line: lineNo,
          contentName,
          transactionId,
          reason: "取込処理エラー",
        });
      }
    }
  }

  return result;
}
