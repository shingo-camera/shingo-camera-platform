/**
 * Stripe クライアント共通生成
 *
 * Cloudflare Workers 向け構成:
 * - httpClient: Stripe.createFetchHttpClient()（Node の http ではなく fetch を使う）
 * - Webhook 署名検証は createSubtleCryptoProvider() + constructEventAsync()（別モジュール）
 *
 * 設計根拠:
 * - api/PURCHASE_API.md, adr/ADR-007, operation/STRIPE.md
 * - 秘密キーは Cloudflare Secrets / .dev.vars（Git・toml・レスポンス・ログに出さない）
 *
 * 決済手段は Stripe Dashboard の Payment methods 設定を正とし、
 * Checkout Session 作成時に payment_method_types を固定しない。
 */

import Stripe from "stripe";
import type { Env } from "../index";

/** Stripe 設定不足を表す内部エラー（利用者へ詳細を返さない） */
export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeConfigError";
  }
}

/**
 * Stripe クライアントを生成する。
 * STRIPE_SECRET_KEY 未設定は内部設定エラー。
 *
 * @throws StripeConfigError SECRET_KEY 未設定
 */
export function getStripe(env: Env): Stripe {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new StripeConfigError("STRIPE_SECRET_KEY is not configured");
  }
  return new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** Web Crypto プロバイダ（Webhook 署名検証で使用） */
export function getCryptoProvider(): Stripe.CryptoProvider {
  return Stripe.createSubtleCryptoProvider();
}

/* ============================================================
 * Checkout Session create 失敗の分類（確定設計 ERROR_CLASSIFICATION_FINAL）
 * ============================================================ */

/**
 * create 失敗の分類。
 * -確定失敗(A): Session 未作成が安全に確定。lock 解放してよい。
 * - RATE_LIMIT: 同一 operation 維持で backoff 後再試行。lock 維持。
 * - INCONSISTENT: idempotency 誤用等。Session 作成済みの可能性。lock 維持・調査。
 * - B1 NETWORK_INDETERMINATE: connection/timeout。同一 key で再試行して収束。lock 維持。
 * - B2 SERVER_INDETERMINATE: 5xx。単純再送で Session 期待しない。Webhook reconcile 待ち。lock 維持。
 */
export type CreateFailureClass =
  | "CONFIRMED_FAILURE"
  | "RATE_LIMIT"
  | "INCONSISTENT"
  | "NETWORK_INDETERMINATE"
  | "SERVER_INDETERMINATE";

/**
 * Stripe の create エラーを分類する。
 * 迷う場合は lock 解放（CONFIRMED_FAILURE）ではなく保守的に維持側へ倒す。
 */
export function classifyCreateError(err: unknown): CreateFailureClass {
  const type =
    err && typeof err === "object" && "type" in err
      ? String((err as { type?: unknown }).type)
      : "";
  switch (type) {
    // A 確定失敗（endpoint 実行前が確実／設定不備で未作成が確定）
    case "StripeInvalidRequestError":
    case "StripeAuthenticationError":
    case "StripePermissionError":
      return "CONFIRMED_FAILURE";
    // レート超過（この試行では未作成。同一 operation で backoff 後再試行）
    case "StripeRateLimitError":
      return "RATE_LIMIT";
    // idempotency 誤用（同一 key の過去 request で Session 作成済みの可能性）
    case "StripeIdempotencyError":
      return "INCONSISTENT";
    // 通信不明（同一 key で安全に再送し収束可能）
    case "StripeConnectionError":
      return "NETWORK_INDETERMINATE";
    // Stripe 内部エラー（500 は cache され得る。Webhook reconcile 待ち）
    case "StripeAPIError":
      return "SERVER_INDETERMINATE";
    default:
      // 判定不能は保守的に「サーバ不明」へ倒す（lock 維持）
      return "SERVER_INDETERMINATE";
  }
}
