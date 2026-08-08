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
