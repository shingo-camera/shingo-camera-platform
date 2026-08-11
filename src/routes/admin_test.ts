/**
 * Local/Test 専用: 購入状態リセット（WORK-011 追加）
 *   POST /api/admin/test/reset-purchases  { authUserId } または { email }
 *
 * 目的: 同一テストユーザー（Supabase Auth は残す）で購入 → reset → 再購入を繰り返せるようにする。
 *
 * 安全設計（Production で絶対に実行させない・部分削除を作らない）:
 * - 二重防御: ①環境ガード（APP_ENV==="production" は 404 で機能自体を隠す）②requireAdmin 必須。
 * - Phase 1（D1 batch 外）: 対象ユーザーの active attempt を Stripe で確認し、必要なら expire。
 *     1 件でも状態不明なら ACTIVE_CHECKOUT_INDETERMINATE で中止し、DB 削除は一切行わない（部分削除禁止）。
 * - Phase 2（1 D1 batch）: FK 安全順で全削除（全成功 or 全 rollback）。
 * - Stripe 側（Session/PaymentIntent/Charge/Refund）は削除しない。paid Session は expire しない。
 * - Stripe API と D1 は 1 トランザクションにできないため、Phase 1 で一部 expire 後に別 attempt が
 *   状態不明で中止するケースは許容（DB は無変更なので次回 reset で expired として安全に処理できる）。
 */

import { requireAdmin } from "../shared/admin";
import { AuthError } from "../shared/auth";
import { AppError, ValidationError } from "../shared/errors";
import { jsonOk, jsonError } from "../shared/response";
import { getDb } from "../shared/db";
import { getStripe, StripeConfigError } from "../shared/stripe";
import type { Env } from "../index";

/**
 * 本機能を実行してよい環境か（deny-by-default）。
 * 購入履歴を削除する破壊的な Local/Test 専用 API のため、許可する環境だけを明示 whitelist する。
 * APP_ENV が local / test のときのみ true。production / 未設定 / 空文字 / 未知値 / typo は全て false。
 */
export function isResetAllowedEnv(env: Env): boolean {
  return env.APP_ENV === "local" || env.APP_ENV === "test";
}

/** active attempt の Stripe 状態（reset 判定の入力）。 */
export type StripeAttemptStatus = "no_session" | "open" | "expired" | "complete" | "indeterminate";

/** reset における active attempt の扱い。 */
export type ResetAttemptDecision = "deletable" | "expire_needed" | "indeterminate";

/**
 * active attempt を reset 用に分類する（方針表を単一の純関数に固定）。
 * - CREATE_ATTEMPTED=0 + SID=NULL → Stripe 未試行 → deletable
 * - CREATE_ATTEMPTED=1 + SID=NULL → create 結果不明 → indeterminate（中止）
 * - SID あり open → expire_needed（expire 成功後のみ削除可）
 * - SID あり expired → deletable
 * - SID あり complete/paid → deletable（expire しない）
 * - SID あり 状態不明 → indeterminate（中止）
 */
export function classifyActiveAttemptForReset(
  attempt: { STRIPE_SESSION_ID: string | null; CREATE_ATTEMPTED: number },
  stripeStatus: StripeAttemptStatus,
): ResetAttemptDecision {
  if (!attempt.STRIPE_SESSION_ID) {
    // SID=NULL
    if (attempt.CREATE_ATTEMPTED === 1) return "indeterminate"; // create 結果不明
    return "deletable"; // 未試行
  }
  // SID あり
  switch (stripeStatus) {
    case "open":
      return "expire_needed";
    case "expired":
    case "complete":
      return "deletable";
    default:
      return "indeterminate"; // retrieve 失敗・未知状態
  }
}

function toResetError(err: unknown): Response {
  if (err instanceof ValidationError) {
    return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, err.fields);
  }
  if (err instanceof AuthError) {
    // requireUser=401(UNAUTHORIZED) / requireAdmin=403(FORBIDDEN)
    return jsonError(err.code, err.message, err.status);
  }
  if (err instanceof AppError) {
    return jsonError(err.code, err.message, err.status);
  }
  if (err instanceof StripeConfigError) {
    console.error("[admin_test] stripe config error:", err.message);
    return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
  throw err;
}

interface MUserLite {
  AUTH_USER_ID: string;
}

/** authUserId または email から対象ユーザーの AUTH_USER_ID を解決する（AUTH_USER_ID を正本）。 */
async function resolveTargetAuthUserId(env: Env, body: Record<string, unknown>): Promise<string> {
  const db = getDb(env);
  const rawAuth = body.authUserId;
  if (typeof rawAuth === "string" && rawAuth.trim().length > 0) {
    const row = await db
      .prepare("SELECT AUTH_USER_ID FROM M_USER WHERE AUTH_USER_ID = ?")
      .bind(rawAuth.trim())
      .first<MUserLite>();
    if (!row) throw new AppError("USER_NOT_FOUND", "対象ユーザーが見つかりません。", 404);
    return row.AUTH_USER_ID;
  }
  const rawEmail = body.email;
  if (typeof rawEmail === "string" && rawEmail.trim().length > 0) {
    // email 指定も最終的に Platform 内部 AUTH_USER_ID へ解決してから処理する
    const row = await db
      .prepare("SELECT AUTH_USER_ID FROM M_USER WHERE LOGIN_MAIL = ?")
      .bind(rawEmail.trim())
      .first<MUserLite>();
    if (!row) throw new AppError("USER_NOT_FOUND", "対象ユーザーが見つかりません。", 404);
    return row.AUTH_USER_ID;
  }
  throw new ValidationError({ authUserId: "authUserId または email を指定してください。" });
}

/** 対象ユーザーの各テーブル削除対象件数を取得（response 用）。 */
async function countTargets(env: Env, authUserId: string) {
  const db = getDb(env);
  const one = async (sql: string, ...binds: unknown[]) => {
    const r = await db.prepare(sql).bind(...binds).first<{ c: number }>();
    return r?.c ?? 0;
  };
  return {
    userProducts: await one("SELECT COUNT(*) c FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ?", authUserId),
    purchases: await one("SELECT COUNT(*) c FROM T_PURCHASE WHERE AUTH_USER_ID = ?", authUserId),
    orders: await one("SELECT COUNT(*) c FROM T_ORDER WHERE AUTH_USER_ID = ?", authUserId),
    checkoutAttempts: await one("SELECT COUNT(*) c FROM T_CHECKOUT_ATTEMPT WHERE AUTH_USER_ID = ?", authUserId),
    checkoutAttemptItems: await one(
      "SELECT COUNT(*) c FROM T_CHECKOUT_ATTEMPT_ITEM WHERE ATTEMPT_ID IN (SELECT ATTEMPT_ID FROM T_CHECKOUT_ATTEMPT WHERE AUTH_USER_ID = ?)",
      authUserId,
    ),
    checkoutLocks: await one("SELECT COUNT(*) c FROM T_PRODUCT_CHECKOUT_LOCK WHERE AUTH_USER_ID = ?", authUserId),
    paymentEvents: await one(
      "SELECT COUNT(*) c FROM T_PAYMENT_EVENT WHERE AUTH_USER_ID = ? OR ORDER_ID IN (SELECT ORDER_ID FROM T_ORDER WHERE AUTH_USER_ID = ?)",
      authUserId,
      authUserId,
    ),
  };
}

/** 削除件数の内訳 */
export interface ResetDeletedCounts {
  userProducts: number;
  purchases: number;
  orders: number;
  checkoutAttempts: number;
  checkoutAttemptItems: number;
  checkoutLocks: number;
  paymentEvents: number;
}

/**
 * 対象ユーザーの購入テスト状態を FK 安全順で 1 D1 batch 削除する（全成功 or 全 rollback）。
 * 他ユーザー・無関係データは削除しない。Supabase Auth / M_USER 行は削除しない。
 * 削除件数は削除前の COUNT を返す（batch 内では件数を確定しないため事前計測）。
 *
 * 削除順（子 → 親。FK 参照を壊さない）:
 *   T_USER_PRODUCT → T_PURCHASE → T_PAYMENT_EVENT → T_ORDER
 *   → T_PRODUCT_CHECKOUT_LOCK → T_CHECKOUT_ATTEMPT_ITEM → T_CHECKOUT_ATTEMPT
 */
export async function deletePurchaseStateForUser(
  env: Env,
  authUserId: string,
): Promise<ResetDeletedCounts> {
  const db = getDb(env);
  const deleted = await countTargets(env, authUserId);

  const stmts = [
    db.prepare("DELETE FROM T_USER_PRODUCT WHERE AUTH_USER_ID = ?").bind(authUserId),
    db.prepare("DELETE FROM T_PURCHASE WHERE AUTH_USER_ID = ?").bind(authUserId),
    // T_ORDER 削除より前に T_PAYMENT_EVENT を消す（ORDER_ID サブクエリ解決のため）
    db
      .prepare(
        "DELETE FROM T_PAYMENT_EVENT WHERE AUTH_USER_ID = ? OR ORDER_ID IN (SELECT ORDER_ID FROM T_ORDER WHERE AUTH_USER_ID = ?)",
      )
      .bind(authUserId, authUserId),
    db.prepare("DELETE FROM T_ORDER WHERE AUTH_USER_ID = ?").bind(authUserId),
    // attempt 参照（lock / item）を先に、attempt を最後に
    db.prepare("DELETE FROM T_PRODUCT_CHECKOUT_LOCK WHERE AUTH_USER_ID = ?").bind(authUserId),
    db
      .prepare(
        "DELETE FROM T_CHECKOUT_ATTEMPT_ITEM WHERE ATTEMPT_ID IN (SELECT ATTEMPT_ID FROM T_CHECKOUT_ATTEMPT WHERE AUTH_USER_ID = ?)",
      )
      .bind(authUserId),
    db.prepare("DELETE FROM T_CHECKOUT_ATTEMPT WHERE AUTH_USER_ID = ?").bind(authUserId),
  ];

  // 途中失敗は全 rollback（部分削除を作らない）。呼出側で INTERNAL_ERROR へ。
  await db.batch(stmts);
  return deleted;
}

export async function handleAdminResetPurchases(request: Request, env: Env): Promise<Response> {
  try {
    // ① 環境ガード（最優先・機能の存在自体を隠すため 404）
    if (!isResetAllowedEnv(env)) {
      return jsonError("PRODUCTION_FORBIDDEN", "この操作は利用できません。", 404);
    }

    // ② 管理者認証（環境ガード通過後も必須）
    await requireAdmin(request, env);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError({ authUserId: "authUserId または email を指定してください。" });
    }
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const authUserId = await resolveTargetAuthUserId(env, obj);

    // ---- Phase 1: Stripe 確認（D1 batch 外）----
    // active attempt（CREATING=0 / OPEN=1）を Stripe で確認。1 件でも状態不明なら中止。
    const db = getDb(env);
    const activeRes = await db
      .prepare(
        `SELECT ATTEMPT_ID, STRIPE_SESSION_ID, CREATE_ATTEMPTED
         FROM T_CHECKOUT_ATTEMPT WHERE AUTH_USER_ID = ? AND STATUS IN (0, 1)`,
      )
      .bind(authUserId)
      .all<{ ATTEMPT_ID: number; STRIPE_SESSION_ID: string | null; CREATE_ATTEMPTED: number }>();
    const activeAttempts = activeRes.results ?? [];

    if (activeAttempts.length > 0) {
      const stripe = getStripe(env);
      for (const a of activeAttempts) {
        let stripeStatus: StripeAttemptStatus = "no_session";
        if (a.STRIPE_SESSION_ID) {
          try {
            const s = await stripe.checkout.sessions.retrieve(a.STRIPE_SESSION_ID);
            stripeStatus =
              s.status === "open"
                ? "open"
                : s.status === "expired"
                  ? "expired"
                  : s.status === "complete"
                    ? "complete"
                    : "indeterminate";
          } catch {
            stripeStatus = "indeterminate"; // retrieve 失敗 = 状態不明
          }
        }

        const decision = classifyActiveAttemptForReset(a, stripeStatus);
        if (decision === "indeterminate") {
          // 状態不明 → reset 中止・DB 削除ゼロ（安全側）
          return jsonError(
            "ACTIVE_CHECKOUT_INDETERMINATE",
            "進行中の購入手続きの状態を確認できないため、リセットを中止しました。時間をおいて再度お試しください。",
            409,
          );
        }
        if (decision === "expire_needed" && a.STRIPE_SESSION_ID) {
          // open は expire を試みる。成功時のみ削除可。失敗＝状態不明で中止。
          try {
            await stripe.checkout.sessions.expire(a.STRIPE_SESSION_ID);
          } catch {
            return jsonError(
              "ACTIVE_CHECKOUT_INDETERMINATE",
              "進行中の購入手続きを終了できなかったため、リセットを中止しました。時間をおいて再度お試しください。",
              409,
            );
          }
        }
        // deletable / expire 成功 → 続行
      }
    }

    // ---- Phase 2: DB 削除（1 D1 batch・FK 安全順・全成功 or 全 rollback）----
    let deleted: ResetDeletedCounts;
    try {
      deleted = await deletePurchaseStateForUser(env, authUserId);
    } catch (e) {
      // 途中失敗は全 rollback 済み（部分削除を作らない）。
      console.error("[admin_test] reset batch failed:", e instanceof Error ? e.message : String(e));
      throw new AppError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
    }

    return jsonOk({ authUserId, deleted });
  } catch (err) {
    return toResetError(err);
  }
}
