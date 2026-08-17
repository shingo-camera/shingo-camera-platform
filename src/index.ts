/**
 * shingo-camera Platform 共通基盤 エントリポイント
 *
 * Cloudflare Workers の fetch ハンドラ。最小自前ルーティング（Hono等は使わない）。
 *
 * 静的Assets との責務分担:
 * - /api/*   : この Worker が処理（run_worker_first = ["/api/*"]）
 * - それ以外 : Workers Static Assets
 */

import { handleHealth } from "./routes/health";
import { handleConfig } from "./routes/config";
import {
  handleAccountSync,
  handleAccountMe,
  handleAccountProducts,
  handleAccountPasswordChanged,
} from "./routes/account";
import { handleProductList, handleProductDetail } from "./routes/products";
import { handleEntitlement } from "./routes/entitlements";
import {
  handleAdminDashboard,
  handleAdminUsers,
  handleAdminUserDetail,
  handleAdminUserStatus,
  handleAdminUserProduct,
  handleAdminWarnings,
  handleAdminWarningUpdate,
} from "./routes/admin";
import { handleCheckout, handlePurchaseStatus, handleActiveCheckout, handleRecover, handleCancel, handlePrecheckDependency } from "./routes/purchases";
import {
  handleAdminReconcile,
  handleAdminOrders,
  handleAdminOrderDetail,
  handleAdminPaymentEvents,
} from "./routes/admin_purchases";
import { handleAdminResetPurchases } from "./routes/admin_test";
import { handleStripeWebhook } from "./routes/stripe_webhook";
import { handleNoteApply, handleNoteStatus } from "./routes/migrations";
import { handleNoteImport, handleNoteList, handleNoteUpdate } from "./routes/admin_note";
import { handleSupportContact } from "./routes/support";
import { withErrorHandling } from "./shared/errors";
import { stripDevPrefix } from "./shared/dev_prefix";
import { withNoindex, finalizeDevResponse, transformDevHtml } from "./shared/dev_html";
import { isDevWebhookExempt, resolveDevAccessEmail } from "./shared/dev_access";
import { createRemoteJWKSet } from "jose";
import { jsonError } from "./shared/response";
import { runWarningJob } from "./shared/warning_job";
import { handleSunAndMoonApi } from "./apps/sun-and-moon/router";
import { handleSunAndMoonAppStart } from "./apps/sun-and-moon/app_start";
import { handleSunAndMoonHeartbeat } from "./apps/sun-and-moon/heartbeat";

/**
 * 環境変数・Secrets のバインディング型。
 */
export interface Env {
  APP_ENV?: string;
  DB: D1Database;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  ADMIN_AUTH_USER_ID?: string;
  // 公開サイトの固定オリジン（Stripe success_url/cancel_url の生成に使用。
  // request.url.origin を使うと同一 operation の retry で origin が揺れ、Stripe create
  // パラメータが変わり得るため、環境固定値を正本とする。例: https://platform.example.com）
  APP_BASE_URL?: string;
  // Stripe（Cloudflare Secrets / Local は .dev.vars。実値を Git/toml に書かない）
  // 商品別 Price ID は M_PRODUCT.STRIPE_PRICE_ID（DB）へ移行済み。env の商品別 Price は持たない。
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Resend（Warning 通知メール用。Cloudflare Secret / Local は .dev.vars。実値を Git/toml に書かない）
  MAIL_API_KEY?: string;
  // SUPPORT 問い合わせの通知先（任意）。未設定時は管理者通知先（ADMIN_AUTH_USER_ID の LOGIN_MAIL）を使う。
  // 実値は Cloudflare 環境変数 / .dev.vars で設定し、Git/toml に書かない。
  SUPPORT_NOTIFY_EMAIL?: string;
  // session_id を SESSION_ID_HASH へ保存する際の HMAC 鍵（サーバー側の秘密）。
  // 生の session_id を保存せず、この鍵で HMAC-SHA256 して保存する（鍵を知らないと逆算・照合できない）。
  // 未設定なら SESSION_ID_HASH は NULL のまま（記録は継続。不正検知の補助情報が減るだけ）。
  // 実値は Cloudflare Secret / .dev.vars で設定し、Git/toml に書かない。
  SESSION_ID_HASH_SECRET?: string;

  // ── DEV 環境（[env.dev] でのみ設定。Production では未設定＝以下は一切効かない no-op）──
  // DEV Worker が /dev/* を受けるときの基底パス（例 "/dev"）。未設定なら DEV shim は完全に無効。
  DEV_BASE_PATH?: string;
  // Workers Static Assets バインディング（DEV Worker のみ。/dev 配下の非 API を public/ から配信するため）。
  ASSETS?: Fetcher;
  // Cloudflare Access（Zero Trust）JWT の Worker 側本検証用（P1-1）。不足時 fail-closed。
  //   DEV_ACCESS_TEAM_DOMAIN: 例 "myteam" または "https://myteam.cloudflareaccess.com"（issuer）。
  //   DEV_ACCESS_AUD: Access Application の Audience（AUD）タグ。
  DEV_ACCESS_TEAM_DOMAIN?: string;
  DEV_ACCESS_AUD?: string;
}

/**
 * 動的パスの単一セグメントを安全に取り出す。
 * URL decode 後に、空・スラッシュ・制御文字を含む値は拒否する（null を返す）。
 *
 * @param raw URL 上の生セグメント
 * @returns 妥当な code、または null
 */
function parsePathSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // 不正な % エンコード
  }
  const value = decoded.trim();
  if (value.length === 0) return null;
  if (value.length > 100) return null; // 想定外に長い値を拒否
  // スラッシュ・制御文字・空白を含む値は拒否
  if (/[\/\\\s\u0000-\u001f]/.test(value)) return null;
  return value;
}

// ============================================================================
// DEV 環境 shim（env-gated）
// ----------------------------------------------------------------------------
// [env.dev] の DEV Worker だけが env.DEV_BASE_PATH（例 "/dev"）を持つ。
// Production はこの変数を持たないため、handleDevRequest は即 null＝完全な no-op で、
// 既存 routing / request URL / 挙動は一切変わらない（characterization test で固定）。
// DEV では:
//   - Cloudflare Access が /dev/* を前段でメール allowlist 保護する（人間手順）。加えて Worker 側でも
//     Cf-Access-Jwt-Assertion を jose で本検証する：署名・issuer(DEV_ACCESS_TEAM_DOMAIN)・
//     audience(DEV_ACCESS_AUD)・payload.email が有効な場合のみ許可（env 不足・JWT 不正は fail-closed で 403）。
//     ＝ Access policy ＋ Worker JWT 検証の二段。
//   - 例外: POST /api/stripe/webhook（exact path）のみ Access 対象外とし、Stripe 署名検証を認証境界とする
//     （machine-to-machine。前方一致では除外しない／webhook 以外は広く bypass しない）。
//   - 先頭 DEV_BASE_PATH を除去して既存 route() へ（DEV bindings＝DEV D1/Test Stripe で実行）。
//   - 非 API は env.ASSETS で public/ を配信。HTML はルート相対 src/href を /dev 前置に書換え（DEV が
//     develop の静的資産を自己完結で読むため）。JS 内 "/api/..." は front の apiFetch が /dev/api へ解決する。
//   - 全レスポンスへ X-Robots-Tag: noindex, nofollow を付与。
// ============================================================================

/** レスポンスへ noindex ヘッダ・リダイレクト /dev 前置は ./shared/dev_html に集約（テスト可能化）。 */

// api-base.js（URL resolver）本体を ASSETS から一度だけ取得してキャッシュする。
// DEV HTML の <head> 先頭へ inline 注入し、外部ファイルのロード成否に依存せず resolver を
// 必ず・最初に定義する（fail-closed）。取得失敗時は空（inline 注入なし＝従来どおり外部ロードに委ねる）。
let _apiBaseSrcCache: string | null = null;
async function getApiBaseSrc(env: Env): Promise<string> {
  if (_apiBaseSrcCache != null) return _apiBaseSrcCache;
  try {
    if (!env.ASSETS) return (_apiBaseSrcCache = "");
    const r = await env.ASSETS.fetch(new Request("https://assets.internal/assets/api-base.js"));
    _apiBaseSrcCache = r.ok ? await r.text() : "";
  } catch {
    _apiBaseSrcCache = "";
  }
  return _apiBaseSrcCache;
}

// Access JWKS を issuer 単位でキャッシュ（リクエスト毎の往復を避ける。auth.ts と同方式）。
const _devAccessJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function devAccessKeys(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = _devAccessJwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(issuer + "/cdn-cgi/access/certs"));
    _devAccessJwksCache.set(issuer, jwks);
  }
  return jwks;
}



/**
 * DEV リクエスト処理。Production（DEV_BASE_PATH 未設定）では null を返し no-op。
 */
async function handleDevRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const base = env.DEV_BASE_PATH;
  if (!base) return null; // ★ Production は完全 no-op（挙動不変）

  const url = new URL(request.url);
  const inner = stripDevPrefix(url.pathname, base);
  if (inner === null) {
    // DEV Worker は /dev/* 以外を受けない想定。安全側で 404（noindex 付き）。
    return withNoindex(jsonError("NOT_FOUND", "指定されたリソースは存在しません。", 404));
  }

  // Stripe webhook（exact path・POST）だけは Cloudflare Access 対象外（machine-to-machine）。
  // Access JWT を要求せず route() へ通し、既存 handleStripeWebhook の Stripe 署名検証を認証境界とする。
  // それ以外の /dev/* は Access JWT（Cf-Access-Jwt-Assertion）を Worker 側でも本検証する（fail-closed）。
  if (!isDevWebhookExempt(request.method, inner)) {
    const email = await resolveDevAccessEmail(request, env, devAccessKeys);
    if (!email) {
      // Access 未通過／JWT 不正／env 不足はすべて拒否。
      return withNoindex(jsonError("FORBIDDEN", "DEV 環境へのアクセス権がありません。", 403));
    }
  }

  // 先頭 /dev を除去した内部リクエストを構築（クエリ・メソッド・ヘッダ・body 保持）。
  const innerUrl = new URL(url.toString());
  innerUrl.pathname = inner;
  const innerReq = new Request(innerUrl.toString(), request);

  if (inner === "/api" || inner.startsWith("/api/")) {
    // DEV API：既存 route() を DEV bindings（DEV D1 / Test Stripe）で実行。
    const res = await route(innerReq, env, ctx);
    return finalizeDevResponse(res, base);
  }

  // 非 API：静的資産を ASSETS から配信。DEV binding 不足は fail-closed（Production へ fallback しない）。
  if (!env.ASSETS) {
    return withNoindex(jsonError("INTERNAL_ERROR", "DEV ASSETS binding 未設定です。", 500));
  }
  const assetRes = await env.ASSETS.fetch(innerReq);

  // HTML は (1) <head> 先頭へ URL resolver(api-base.js) を inline 注入（外部ロード成否に依存させない＝
  // fail-closed。apiBase/apiUrl/appUrl/apiFetch を必ず・最初に定義）、(2) ルート相対 src/href/action/poster を
  // /dev 前置（DEV が develop の資産を自己完結で読む）に書換える。JS 内 "/api/..." は resolver が /dev/api へ解決。
  const ctype = assetRes.headers.get("content-type") || "";
  if (ctype.includes("text/html") && typeof HTMLRewriter !== "undefined") {
    const apiBaseSrc = await getApiBaseSrc(env);
    const rewritten = transformDevHtml(assetRes, base, apiBaseSrc);
    return finalizeDevResponse(rewritten, base);
  }
  return finalizeDevResponse(assetRes, base);
}

/** メソッドとパスに応じてハンドラを振り分ける */
function route(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  // 静的・固定パス
  if (method === "GET" && pathname === "/api/health") return handleHealth(env);
  if (method === "GET" && pathname === "/api/config") return handleConfig(env);

  // Support（ページ閲覧は誰でも可。問い合わせ送信は requireUser で認証必須。特商法の開示請求も受付）
  if (method === "POST" && pathname === "/api/support/contact") return handleSupportContact(request, env);

  // Account
  if (method === "POST" && pathname === "/api/account/sync") return handleAccountSync(request, env);
  if (method === "GET" && pathname === "/api/account/me") return handleAccountMe(request, env);
  if (method === "GET" && pathname === "/api/account/products") return handleAccountProducts(request, env);
  if (method === "POST" && pathname === "/api/account/password-changed") {
    return handleAccountPasswordChanged(request, env);
  }

  // Products
  if (method === "GET" && pathname === "/api/products") return handleProductList(request, env);
  if (method === "GET" && pathname.startsWith("/api/products/")) {
    const raw = pathname.slice("/api/products/".length);
    const code = parsePathSegment(raw);
    if (code === null) {
      return jsonError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
    }
    return handleProductDetail(request, env, code);
  }

  // Entitlements
  if (method === "GET" && pathname.startsWith("/api/entitlements/")) {
    const raw = pathname.slice("/api/entitlements/".length);
    const code = parsePathSegment(raw);
    if (code === null) {
      // code 不正でも権限は与えない。存在確認前なので PRODUCT_NOT_FOUND とする。
      return jsonError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
    }
    return handleEntitlement(request, env, code);
  }

  // SUN AND MOON アプリ固有API（WORK-010）
  // アプリ起動記録（APP_START アクセスログ）
  if (method === "POST" && pathname === "/api/apps/sun-and-moon/app-start") {
    return handleSunAndMoonAppStart(request, env);
  }
  // 継続利用中の低頻度セッション観測（PERIODIC_CHECK アクセスログ）。
  // ログインしっぱなしでも利用地点・セッションを再観測するための heartbeat。entitlement は変更しない。
  if (method === "POST" && pathname === "/api/apps/sun-and-moon/heartbeat") {
    return handleSunAndMoonHeartbeat(request, env);
  }
  // 計算API群: /api/apps/sun-and-moon/{name}
  //   各APIは requireProduct(SUN_AND_MOON) を通す（router 内）。アクセスログは記録しない。
  if (pathname.startsWith("/api/apps/sun-and-moon/")) {
    const name = parsePathSegment(pathname.slice("/api/apps/sun-and-moon/".length));
    if (name !== null) {
      return handleSunAndMoonApi(request, env, ctx, name).then((res) =>
        res ?? jsonError("NOT_FOUND", "エンドポイントが見つかりません。", 404),
      );
    }
  }

  // Admin（すべて requireAdmin をハンドラ内で通す）
  if (pathname.startsWith("/api/admin/")) {
    return routeAdmin(request, env, pathname, method);
  }

  // Purchases（Stripe）
  if (method === "POST" && pathname === "/api/purchases/checkout") {
    return handleCheckout(request, env);
  }
  // 依存条件のみ事前確認（Checkout Session を作らない UX 改善用・購入実行時の依存チェックは別途必須）
  if (method === "POST" && pathname === "/api/purchases/precheck-dependency") {
    return handlePrecheckDependency(request, env);
  }
  if (method === "GET" && pathname === "/api/purchases/status") {
    return handlePurchaseStatus(request, env);
  }
  if (method === "GET" && pathname === "/api/purchases/active-checkout") {
    return handleActiveCheckout(request, env);
  }
  // success recovery（認証必須・他人 Session は 403）
  if (method === "POST" && pathname === "/api/purchases/recover") {
    return handleRecover(request, env);
  }
  // cancel（認証必須・operationId ベース。sessionId を browser から受けない）
  if (method === "POST" && pathname === "/api/purchases/cancel") {
    return handleCancel(request, env);
  }
  // Stripe Webhook（JWT 不要・署名検証必須）
  if (method === "POST" && pathname === "/api/stripe/webhook") {
    return handleStripeWebhook(request, env);
  }

  // note 移行（公開、認証必須）
  if (method === "POST" && pathname === "/api/migrations/note/apply") {
    return handleNoteApply(request, env);
  }
  if (method === "GET" && pathname === "/api/migrations/note/status") {
    return handleNoteStatus(request, env);
  }

  return jsonError("NOT_FOUND", "指定されたリソースは存在しません。", 404);
}

/** UUID 形式判定（AUTH_USER_ID 用） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 管理 API のルーティング */
function routeAdmin(
  request: Request,
  env: Env,
  pathname: string,
  method: string,
): Response | Promise<Response> {
  // GET /api/admin/dashboard
  if (method === "GET" && pathname === "/api/admin/dashboard") {
    return handleAdminDashboard(request, env);
  }
  // GET /api/admin/users
  if (method === "GET" && pathname === "/api/admin/users") {
    return handleAdminUsers(request, env);
  }
  // GET /api/admin/warnings
  if (method === "GET" && pathname === "/api/admin/warnings") {
    return handleAdminWarnings(request, env);
  }
  // PUT /api/admin/warnings/{warningId}
  if (method === "PUT" && pathname.startsWith("/api/admin/warnings/")) {
    const raw = pathname.slice("/api/admin/warnings/".length);
    const id = parsePathSegment(raw);
    if (id === null) return jsonError("WARNING_NOT_FOUND", "対象が見つかりません。", 404);
    return handleAdminWarningUpdate(request, env, id);
  }

  // /api/admin/users/{authUserId}...
  if (pathname.startsWith("/api/admin/users/")) {
    const rest = pathname.slice("/api/admin/users/".length);
    const segments = rest.split("/");
    const authUserId = parsePathSegment(segments[0] ?? "");
    if (authUserId === null || !UUID_RE.test(authUserId)) {
      return jsonError("USER_NOT_FOUND", "アカウントが見つかりません。", 404);
    }

    // GET /api/admin/users/{authUserId}
    if (method === "GET" && segments.length === 1) {
      return handleAdminUserDetail(request, env, authUserId);
    }
    // PUT /api/admin/users/{authUserId}/status
    if (method === "PUT" && segments.length === 2 && segments[1] === "status") {
      return handleAdminUserStatus(request, env, authUserId);
    }
    // PUT /api/admin/users/{authUserId}/products/{productCode}
    if (method === "PUT" && segments.length === 3 && segments[1] === "products") {
      const productCode = parsePathSegment(segments[2] ?? "");
      if (productCode === null) {
        return jsonError("PRODUCT_NOT_FOUND", "商品が見つかりません。", 404);
      }
      return handleAdminUserProduct(request, env, authUserId, productCode);
    }
  }

  // 購入救済・注文追跡（WORK-011）
  if (method === "POST" && pathname === "/api/admin/purchases/reconcile") {
    return handleAdminReconcile(request, env);
  }
  // Local/Test 専用: 購入状態リセット（Production は 404。環境ガードはハンドラ先頭で判定）
  if (method === "POST" && pathname === "/api/admin/test/reset-purchases") {
    return handleAdminResetPurchases(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/orders") {
    return handleAdminOrders(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/payment-events") {
    return handleAdminPaymentEvents(request, env);
  }
  if (method === "GET" && pathname.startsWith("/api/admin/orders/")) {
    const raw = pathname.slice("/api/admin/orders/".length);
    const id = parsePathSegment(raw);
    const orderId = id !== null ? Number(id) : NaN;
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return jsonError("ORDER_NOT_FOUND", "注文が見つかりません。", 404);
    }
    return handleAdminOrderDetail(request, env, orderId);
  }

  // note 管理
  if (method === "POST" && pathname === "/api/admin/note/import") {
    return handleNoteImport(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/note/purchases") {
    return handleNoteList(request, env);
  }
  if (method === "PUT" && pathname.startsWith("/api/admin/note/purchases/")) {
    const id = pathname.slice("/api/admin/note/purchases/".length);
    if (!id || id.includes("/")) {
      return jsonError("NOTE_PURCHASE_NOT_FOUND", "対象が見つかりません。", 404);
    }
    return handleNoteUpdate(request, env, id);
  }

  return jsonError("NOT_FOUND", "指定されたリソースは存在しません。", 404);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // DEV shim を先に評価。Production（DEV_BASE_PATH 未設定）は null で従来 route へ抜ける（挙動不変）。
    return withErrorHandling(async (req) => {
      const dev = await handleDevRequest(req, env, ctx);
      if (dev) return dev;
      return route(req, env, ctx);
    })(request);
  },
  /**
   * Cloudflare Cron Trigger（1時間ごと）から呼ばれる定期処理。
   * WORK-009 Warning 判定・登録・管理者通知を実行する。
   * 例外は握りつぶさずログに残すが、scheduled 全体は安全に終了させる
   * （1 回の失敗が次回起動を妨げないようにする）。
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const r = await runWarningJob(env);
          console.log(
            `warning_job: detected=${r.detected} inserted=${r.inserted} reused=${r.reused} ` +
              `notified=${r.notified} mailSuppressed=${r.mailSuppressed} ` +
              `mailFailed=${r.mailFailed} noRecipient=${r.mailSkippedNoRecipient}`,
          );
        } catch (e) {
          console.error("warning_job failed:", e instanceof Error ? e.message : String(e));
        }
      })(),
    );
  },
};
