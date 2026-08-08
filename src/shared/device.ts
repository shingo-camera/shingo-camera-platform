/**
 * DEVICE_ID 取得共通関数
 *
 * ブラウザが発行した DEVICE_ID を X-Device-Id ヘッダーから取り出す。
 * DEVICE_ID は認証要素ではない（AUTH.md 15）。ログ・履歴用途にのみ使う。
 *
 * 設計根拠:
 * - api/API.md 3「X-Device-Id: <UUID>」
 * - api/API.md 12「共通サーバー関数: getDeviceId()」
 * - AUTH.md 15「DEVICE_ID は認証要素ではない。単独で停止判断しない」
 */

import { ValidationError } from "./errors";

/** UUID 形式（v4 想定だが、緩めに UUID 一般形を許容） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * X-Device-Id を取得する。
 * 未設定・形式不正は null を返す（認証要素ではないため拒否はしない）。
 *
 * @param request 受信リクエスト
 * @returns DEVICE_ID（UUID）または null
 */
export function getDeviceId(request: Request): string | null {
  const raw = request.headers.get("x-device-id") ?? request.headers.get("X-Device-Id");
  if (!raw) {
    return null;
  }
  const value = raw.trim();
  return UUID_RE.test(value) ? value : null;
}

/**
 * X-Device-Id を必須として取得する。
 * 欠落・不正形式は ValidationError（400, VALIDATION_ERROR）。
 * 「不正形式を黙って保存しない」ため、必須が要る呼出元はこちらを使う。
 *
 * DEVICE_ID は認証要素ではない（AUTH.md 15）が、記録の一貫性のため
 * 呼出元が必須を選べるようにする。
 *
 * @param request 受信リクエスト
 * @returns DEVICE_ID（UUID）
 * @throws ValidationError 欠落・不正形式時
 */
export function requireDeviceId(request: Request): string {
  const id = getDeviceId(request);
  if (id === null) {
    throw new ValidationError({ "X-Device-Id": "端末IDが不正です。" });
  }
  return id;
}
