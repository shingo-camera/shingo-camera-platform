/**
 * 購入 API ルート
 *   POST /api/purchases/checkout  Checkout Session 作成（認証必須・複数商品対応）
 *   GET  /api/purchases/status    購入反映状況の確認（認証必須）
 *
 * 設計根拠: api/PURCHASE_API.md 2/4/5
 *
 * 複数商品 Checkout（WORK-011）:
 * - Request は productCodes[]（配列）を正とする。
 * - 後方互換として productCode（単数 string）も受理し、[productCode] へ正規化する
 *   （既存 STORE UI が単品呼び出しのため。UI 変更は次工程）。
 * - 金額・Price ID・PRODUCT_ID・商品順はブラウザから受け取らない/信用しない。
 *   商品順は M_PRODUCT.SORT_NO で決定的に正規化する。
 *
 * 決済手段は Stripe Dashboard の Payment methods 設定を正とし、
 * payment_method_types をコードで固定しない（買い切りのため mode=payment）。
 */

import { requireUser, AuthError } from "../shared/auth";
import { AppError, ValidationError } from "../shared/errors";
import { jsonOk, jsonError } from "../shared/response";
import { getStripe, StripeConfigError, classifyCreateError } from "../shared/stripe";
import { precheckMultiCheckout, isProductAvailable } from "../shared/purchase";
import {
  validateOperationId,
  buildCartKey,
  buildPreparedItems,
  getAttemptByOperationId,
  getActiveAttemptsForUser,
  getAttemptItems,
  findActiveAttemptsHoldingAnyProduct,
  createAttemptWithLocks,
  updateAttemptStatus,
  markCreateAttempted,
  cancelAttempt,
  expireAttempt,
  recordPaymentEvent,
  rebuildCreateParams,
  isCreateResultIndeterminate,
  ATTEMPT_STATUS,
  PAYMENT_EVENT_TYPE,
  type AttemptRow,
} from "../shared/checkout_attempt";
import { fulfillCheckoutSession, epochToJstIso } from "../shared/stripe_fulfill";
import type { Env } from "../index";

/** AuthError / AppError / ValidationError / StripeConfigError を共通レスポンスへ変換 */
function toErrorResponse(err: unknown): Response {
  if (err instanceof ValidationError) {
    return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, err.fields);
  }
  if (err instanceof AuthError) {
    return jsonError(err.code, err.message, err.status);
  }
  if (err instanceof AppError) {
    return jsonError(err.code, err.message, err.status);
  }
  if (err instanceof StripeConfigError) {
    console.error("[purchase] stripe config error:", err.message);
    return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
  throw err;
}

/** 1 商品コードの形式チェック（文字列・非空・64 文字以内） */
function isValidCode(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 64;
}

/**
 * Stripe success_url/cancel_url の生成に使う固定オリジンを解決する。
 * request.url.origin は使わない（同一 operation の retry で origin が揺れると Stripe create
 * パラメータが変わり、idempotency 前提が崩れるため）。APP_BASE_URL を正本とし、
 * 未設定・不正なら Checkout を開始しない（壊れた URL の Session を作らない）。
 */
export function resolveBaseUrl(env: Env): string {
  const raw = env.APP_BASE_URL;
  if (!raw || raw.trim().length === 0) {
    throw new AppError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AppError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new AppError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
  // 末尾スラッシュを除去した origin ベース（パスは付与側で組む）
  return u.origin;
}

/**
 * Request body から productCodes[] を取り出して検証する。
 *
 * 受理形式:
 * - { "productCodes": ["A", "B", ...] }（新仕様・正）
 * - { "productCode": "A" }（後方互換・単数 → ["A"] へ正規化）
 *
 * 検証（api/PURCHASE_API.md）:
 * - 配列であること（productCode 単数は配列化して許可）
 * - 空配列拒否
 * - 各要素が文字列・非空・64 文字以内
 * - 同一 PRODUCT_CODE の重複拒否（黙って除去しない）
 *
 * @throws ValidationError 形式不正・空・重複
 */
export function parseProductCodes(body: unknown): string[] {
  if (!body || typeof body !== "object") {
    throw new ValidationError({ productCodes: "商品を指定してください。" });
  }
  const obj = body as Record<string, unknown>;

  let codes: unknown;
  if ("productCodes" in obj) {
    codes = obj.productCodes;
  } else if ("productCode" in obj) {
    // 後方互換: 単数を配列化
    codes = [obj.productCode];
  } else {
    throw new ValidationError({ productCodes: "商品を指定してください。" });
  }

  if (!Array.isArray(codes)) {
    throw new ValidationError({ productCodes: "商品の指定形式が正しくありません。" });
  }
  if (codes.length === 0) {
    throw new ValidationError({ productCodes: "商品を 1 つ以上指定してください。" });
  }
  for (const c of codes) {
    if (!isValidCode(c)) {
      throw new ValidationError({ productCodes: "商品コードが正しくありません。" });
    }
  }
  // 重複拒否（黙って除去しない）
  const seen = new Set<string>();
  for (const c of codes as string[]) {
    if (seen.has(c)) {
      throw new ValidationError({ productCodes: "同じ商品が重複しています。" });
    }
    seen.add(c);
  }
  return codes as string[];
}

/**
 * Checkout Session を作成する（複数商品対応・支払い試行層で堅牢化）。
 *
 * 確定設計:
 * - request は { productCodes, operationId }。operationId は browser 生成の安定キー。
 * - attempt(+item) と cart 全 lock を 1 batch で確定（競合は ALREADY_IN_PROGRESS）。
 * - Stripe create は DB snapshot（rebuildCreateParams）から完全再現し、idempotencyKey は
 *   server 生成（checkout:<authUserId>:<operationId>）。
 * - 既存 attempt（OPERATION_ID + AUTH_USER_ID + CART_KEY 一致）は recover 分岐で再利用。
 *   不一致は OPERATION_MISMATCH。
 * - create 失敗は分類（確定失敗のみ lock 解放、他は維持）。
 */
export async function handleCheckout(request: Request, env: Env): Promise<Response> {
  try {
    const auth = await requireUser(request, env);

    // 購入者メールは認証情報（検証済み JWT）から取得。ブラウザ入力は使わない。
    const buyerEmail = auth.email;
    if (!buyerEmail || buyerEmail.trim().length === 0) {
      throw new AppError(
        "AUTH_EMAIL_REQUIRED",
        "購入手続きに必要なメール情報を確認できませんでした。再度ログインしてお試しください。",
        403,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError({ productCodes: "商品を指定してください。" });
    }

    // operationId 検証（browser 入力：UUID 形式・長さ・文字種）
    const operationId = validateOperationId(
      body && typeof body === "object" ? (body as Record<string, unknown>).operationId : undefined,
    );
    // productCodes 検証（email 等の余分キーは無視）
    const productCodes = parseProductCodes(body);

    // 固定オリジン（request.url.origin は使わない）。未設定は resolveBaseUrl が 500。
    const origin = resolveBaseUrl(env);

    // 既存 attempt の再利用 or 新規作成
    const existing = await getAttemptByOperationId(env, operationId);
    if (existing) {
      // owner / cart binding（単独では正本にしない）
      if (existing.AUTH_USER_ID !== auth.authUserId) {
        throw new AppError("OPERATION_MISMATCH", "購入手続きの識別子が一致しません。", 409);
      }
      // CART_KEY は正規化した productCodes（順序非依存）で一致判定
      const reqCartKey = buildCartKey([...productCodes]);
      if (existing.CART_KEY !== reqCartKey) {
        throw new AppError("OPERATION_MISMATCH", "購入内容が一致しません。", 409);
      }
      return await recoverExistingAttempt(env, existing, origin);
    }

    // 新規作成: precheck（有効・存在・販売可否・二重購入防止・依存条件）＋ SORT_NO 正規化
    const { products, priceIdByCode } = await precheckMultiCheckout(
      env,
      auth.authUserId,
      productCodes,
    );
    const preparedItems = buildPreparedItems(products, priceIdByCode);
    const normalizedCodes = products.map((p) => p.PRODUCT_CODE);
    const cartKey = buildCartKey(normalizedCodes);

    // restart フラグ（body.restart===true）。以前の未完了 Checkout を終了して作り直す意思。
    const restart =
      body !== null &&
      typeof body === "object" &&
      (body as Record<string, unknown>).restart === true;

    // 同一ユーザー・同一商品（いずれか重複）を保持する別 operationId の未完了 attempt を検出。
    // カートが複数商品を含み、商品ごとに別 attempt が残っている場合は候補が複数になり得るため、
    // すべて把握して settle する（1 件だけ処理すると残った lock で ALREADY_IN_PROGRESS になる）。
    const productIds = products.map((p) => p.PRODUCT_ID);
    const oldAttempts = await findActiveAttemptsHoldingAnyProduct(
      env,
      auth.authUserId,
      productIds,
      operationId,
    );
    if (oldAttempts.length > 0) {
      // 各旧 attempt を Stripe 状態で評価。restart=false は open で確認要求、restart=true は expire 実行。
      // 集約判定の優先順位: already_paid / indeterminate があれば新規作成しない。
      // open が残っていれば（restart=false のとき）再開始確認。すべて片付けば新規作成へ続行。
      let anyPaid = false;
      let anyIndeterminate = false;
      let anyOpenActive = false;
      for (const old of oldAttempts) {
        const r = await settleAttemptViaStripe(env, old, {
          expireOpen: restart,
          authUserId: auth.authUserId,
        });
        if (r === "already_paid" || r === "completed") anyPaid = true;
        else if (r === "indeterminate") anyIndeterminate = true;
        else if (r === "open_active") anyOpenActive = true;
        // cancelled / expired / not_created は片付け済み（副作用のみ）
      }

      if (anyPaid) {
        // 実は支払い済みが含まれる → 新規作成しない。反映確認へ収束。
        return jsonOk({ alreadyPaid: true, operationId: oldAttempts[0].OPERATION_ID });
      }
      if (anyIndeterminate) {
        // 状態不明が含まれる → 新規作成しない（安全側で停止）
        return jsonError(
          "CHECKOUT_RESTART_PENDING",
          "以前の購入手続きの状態を確認しています。しばらくしてから、もう一度お試しください。",
          503,
        );
      }
      if (anyOpenActive) {
        // open（支払い可能）が残っている（restart=false）→ ユーザーに再開始確認を促す（新規作成しない）
        return jsonError(
          "CHECKOUT_RESTART_CONFIRM",
          "以前開始した購入手続きが残っています。新しく購入を進めると、以前の購入画面は利用できなくなります。",
          409,
        );
      }
      // すべて cancelled / expired / not_created で片付け済み → そのまま新規作成へ続行
    }

    // attempt + item + cart 全 lock を 1 batch（競合は ALREADY_IN_PROGRESS で rollback）
    const attempt = await createAttemptWithLocks(env, {
      operationId,
      authUserId: auth.authUserId,
      cartKey,
      buyerEmail,
      totalAmount: 0, // 期待合計。正本は Webhook の Stripe 値
      items: preparedItems,
    });

    // Stripe create（DB snapshot から完全再現・idempotencyKey は server 生成）
    return await doCreateAndOpen(env, attempt, origin);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Stripe Checkout Session を DB snapshot から作成し、attempt を OPEN にして checkoutUrl を返す。
 * create 失敗は分類して処理する（確定失敗のみ lock 解放、他は維持）。
 */
async function doCreateAndOpen(
  env: Env,
  attempt: AttemptRow,
  origin: string,
): Promise<Response> {
  const params = await rebuildCreateParams(env, attempt, origin);
  const stripe = getStripe(env);

  // Stripe create を呼ぶ「直前」に CREATE_ATTEMPTED=1 を DB 確定する。
  // これ以降 SID=NULL のままでも「create を試みた（結果不明）」と判別でき、
  // cancel だけを理由に lock を解放しない安全側の判断が可能になる。
  // ここで Worker が落ちても、同一 idempotencyKey での recover へ倒す（lock 維持）。
  await markCreateAttempted(env, attempt.ATTEMPT_ID);

  let session: import("stripe").Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: params.lineItems,
        customer_email: params.customerEmail,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.clientReferenceId,
        metadata: params.metadata,
      },
      { idempotencyKey: params.idempotencyKey },
    );
  } catch (e) {
    const cls = classifyCreateError(e);
    switch (cls) {
      case "CONFIRMED_FAILURE":
        // Session 未作成が確定 → lock 解放・attempt CANCELLED
        await cancelAttempt(env, attempt.ATTEMPT_ID);
        console.error("[checkout] confirmed create failure");
        return jsonError("CHECKOUT_CREATE_FAILED", "購入手続きを開始できませんでした。", 502);
      case "RATE_LIMIT":
        // lock 維持。同一 operationId で backoff 後に再試行可能（次回は recover 分岐）
        return jsonError("RATE_LIMITED", "混み合っています。少し待って再度お試しください。", 429);
      case "INCONSISTENT":
        // idempotency 誤用等。Session 作成済みの可能性 → lock 維持・記録・調査
        await recordPaymentEvent(env, {
          eventType: PAYMENT_EVENT_TYPE.SERVER_INDETERMINATE,
          authUserId: attempt.AUTH_USER_ID,
          detail: "StripeIdempotencyError on create",
        });
        return jsonError("CHECKOUT_INCONSISTENT", "購入手続きを確認しています。時間をおいてご確認ください。", 409);
      case "NETWORK_INDETERMINATE":
        // 同一 key で再送し収束可能 → lock 維持。client の同一 operationId 再送で recover へ
        return jsonError("CHECKOUT_RETRY", "通信が不安定です。同じ操作をもう一度お試しください。", 503);
      case "SERVER_INDETERMINATE":
      default:
        // 5xx 等。単純再送で Session を期待しない → Webhook reconcile 待ち・記録・通知
        await recordPaymentEvent(env, {
          eventType: PAYMENT_EVENT_TYPE.SERVER_INDETERMINATE,
          authUserId: attempt.AUTH_USER_ID,
          detail: "server error on create; awaiting webhook reconciliation",
        });
        return jsonError("CHECKOUT_PENDING", "購入処理を確認しています。しばらくお待ちください。", 503);
    }
  }

  if (!session.url) {
    console.error("[checkout] session has no url");
    return jsonError("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }

  const expiresAt =
    typeof session.expires_at === "number" ? epochToJstIso(session.expires_at) : null;
  await updateAttemptStatus(env, attempt.ATTEMPT_ID, ATTEMPT_STATUS.OPEN, {
    stripeSessionId: session.id,
    expiresAt,
  });

  return jsonOk({ checkoutUrl: session.url, operationId: attempt.OPERATION_ID });
}

/**
 * 既存 attempt（owner/cart 一致確認済み）を再利用/回復する。
 * - PAID: 既に成立。alreadyPaid。
 * - EXPIRED/CANCELLED: この operationId は終了済み（新規購入は別 operationId）。
 * - OPEN + SID: Stripe 状態確認（open→既存URL / complete→fulfill / expired→解放）。
 * - CREATING or SID=NULL: DB snapshot から同一 idempotencyKey で create 再実行して収束。
 */
/**
 * 旧 attempt を Stripe 状態に基づいて安全に終着させる（cancel / 再開始で共用）。
 *
 * 返り値 result:
 * - "cancelled"     : open Session を expire 成功 → attempt CANCELLED + lock 解放
 * - "expired"       : Stripe が既に expired → attempt EXPIRED + lock 解放
 * - "already_paid"  : complete/paid → 終着させない（lock は fulfill 経路で解放）。呼出側は新規作成しない
 * - "not_created"   : SID=NULL かつ create 未試行 → attempt CANCELLED + lock 解放（Session 不在が確定）
 * - "indeterminate" : 状態不明（retrieve/expire 失敗、create 結果不明）→ 何も終着させない。lock 維持
 *
 * expireOpen=false の場合、open Session は expire せず "open_active" を返す（呼出側で再開始確認へ）。
 * expireOpen=true の場合、open Session を expire してから終着する（再開始の実行フェーズ）。
 *
 * authUserId を渡すと Session.metadata.auth_user_id と照合し、不一致は SESSION_FORBIDDEN を投げる。
 */
type SettleResult =
  | "cancelled"
  | "expired"
  | "already_paid"
  | "completed"
  | "not_created"
  | "indeterminate"
  | "open_active";

export async function settleAttemptViaStripe(
  env: Env,
  attempt: AttemptRow,
  opts: { expireOpen: boolean; authUserId?: string },
): Promise<SettleResult> {
  if (attempt.STATUS === ATTEMPT_STATUS.PAID) return "already_paid";

  // Stripe 未作成の可能性（SID=NULL）
  if (!attempt.STRIPE_SESSION_ID) {
    if (!isCreateResultIndeterminate(attempt)) {
      // CREATE_ATTEMPTED=0 → create 未試行が確定 → Session 不在 → 終着可
      await cancelAttempt(env, attempt.ATTEMPT_ID);
      return "not_created";
    }
    // CREATE_ATTEMPTED=1 かつ SID=NULL = create 結果不明。Session が存在し得るため終着しない。
    return "indeterminate";
  }

  const stripe = getStripe(env);
  let session: import("stripe").Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(attempt.STRIPE_SESSION_ID);
  } catch {
    return "indeterminate"; // 取得不能 → lock 維持
  }

  if (opts.authUserId && session.metadata?.auth_user_id !== opts.authUserId) {
    throw new AppError("SESSION_FORBIDDEN", "この購入情報にはアクセスできません。", 403);
  }

  // Stripe complete = 支払い済みだが、この attempt がまだ fulfillment/PAID 化されていない可能性。
  // ここでは終端化せず "completed" を返し、呼出側で既存 fulfillCheckoutSession に収束させる。
  // （"already_paid" は「attempt が既に PAID」の意味に限定する。）
  if (session.status === "complete") return "completed";
  if (session.status === "expired") {
    await expireAttempt(env, attempt.ATTEMPT_ID);
    return "expired";
  }

  // open
  if (!opts.expireOpen) return "open_active"; // 検出フェーズ: 再開始確認へ

  // 実行フェーズ: expire 成功時のみ終着。失敗時は再 retrieve で確定できたときのみ対応。
  try {
    await stripe.checkout.sessions.expire(attempt.STRIPE_SESSION_ID);
    await cancelAttempt(env, attempt.ATTEMPT_ID);
    return "cancelled";
  } catch {
    let s2: import("stripe").Stripe.Checkout.Session | null = null;
    try {
      s2 = await stripe.checkout.sessions.retrieve(attempt.STRIPE_SESSION_ID);
    } catch {
      s2 = null;
    }
    if (s2 && s2.status === "complete") return "completed";
    if (s2 && s2.status === "expired") {
      await expireAttempt(env, attempt.ATTEMPT_ID);
      return "expired";
    }
    return "indeterminate"; // open のまま or 不明 → lock 維持
  }
}

async function recoverExistingAttempt(
  env: Env,
  attempt: AttemptRow,
  origin: string,
): Promise<Response> {
  if (attempt.STATUS === ATTEMPT_STATUS.PAID) {
    return jsonOk({ alreadyPaid: true, operationId: attempt.OPERATION_ID });
  }
  if (attempt.STATUS === ATTEMPT_STATUS.EXPIRED || attempt.STATUS === ATTEMPT_STATUS.CANCELLED) {
    return jsonError(
      "OPERATION_CLOSED",
      "この購入手続きは終了しています。もう一度最初からお試しください。",
      409,
    );
  }

  // OPEN / CREATING
  if (attempt.STRIPE_SESSION_ID) {
    const stripe = getStripe(env);
    let s: import("stripe").Stripe.Checkout.Session;
    try {
      s = await stripe.checkout.sessions.retrieve(attempt.STRIPE_SESSION_ID);
    } catch {
      // retrieve 不能（結果不明）→ lock 維持のまま再試行を促す
      return jsonError("CHECKOUT_RETRY", "通信が不安定です。もう一度お試しください。", 503);
    }
    if (s.status === "open" && s.url) {
      return jsonOk({ checkoutUrl: s.url, operationId: attempt.OPERATION_ID });
    }
    if (s.status === "complete") {
      const r = await fulfillCheckoutSession(env, attempt.STRIPE_SESSION_ID, "recovery");
      if (r.outcome === "newly_fulfilled" || r.outcome === "already_fulfilled" || r.outcome === "duplicate_detected") {
        return jsonOk({ alreadyPaid: true, operationId: attempt.OPERATION_ID });
      }
      // not_paid / invalid / inconsistent は結果不明として再確認を促す
      return jsonError("CHECKOUT_PENDING", "購入処理を確認しています。しばらくお待ちください。", 503);
    }
    // expired → 解放して再購入を促す（別 operationId）
    await expireAttempt(env, attempt.ATTEMPT_ID);
    return jsonError(
      "CHECKOUT_EXPIRED",
      "購入手続きの有効期限が切れました。もう一度お試しください。",
      409,
    );
  }

  // SID=NULL（CREATING）→ 同一 idempotencyKey + DB snapshot で create 再実行して回収
  return await doCreateAndOpen(env, attempt, origin);
}

/**
 * status API のクエリから確認対象の商品コード配列を正規化する（純関数・テスト対象）。
 *
 * - productCodes（カンマ区切り）を優先。無ければ単数 productCode を配列化。
 * - trim・空除外・64 文字超は不正・重複は安全に一意化（最初の出現順を維持）。
 *
 * @returns { codes, singleMode } codes=正規化済み配列 / singleMode=単数リクエストか
 *   codes が空、または 64 文字超を含む場合は null（呼出側で 400）
 */
export function parseStatusProductCodes(
  rawCodes: string | null,
  rawCode: string | null,
): { codes: string[]; singleMode: boolean } | null {
  let source: string[];
  let singleMode = false;
  if (rawCodes !== null) {
    source = rawCodes.split(",");
  } else if (rawCode !== null) {
    source = [rawCode];
    singleMode = true;
  } else {
    return null;
  }

  const seen = new Set<string>();
  const codes: string[] = [];
  for (const c of source) {
    const t = c.trim();
    if (t.length === 0) continue;
    if (t.length > 64) return null;
    if (seen.has(t)) continue;
    seen.add(t);
    codes.push(t);
  }
  if (codes.length === 0) return null;
  return { codes, singleMode };
}

/**
 * 全商品が granted のときのみ true（成功確定）を返す（純関数・テスト対象）。
 * 空配列は false（成功にしない）。一部未反映も false。
 */
export function computeAllGranted(products: { granted: boolean }[]): boolean {
  if (products.length === 0) return false;
  return products.every((p) => p.granted);
}

/**
 * GET /api/purchases/status
 *
 * 購入後の権限反映確認（付与はしない。Webhook が正本）。複数商品対応。
 *
 * クエリ（いずれか。両方あれば productCodes を優先）:
 * - ?productCodes=HANABI,HANABI_GOOGLE_EARTH,SUN_AND_MOON （新仕様・カンマ区切り）
 * - ?productCode=SUN_AND_MOON                              （後方互換・単数）
 *
 * 判定は既存 entitlement 判定（isProductAvailable。T_USER_PRODUCT の
 * STATUS/START/END/DEL とユーザー・商品状態）を正本とする。T_ORDER/T_PURCHASE の
 * 存在では判定しない。必ずログイン中ユーザーの権限のみを見る（URL の商品コードは
 * 「確認対象」に過ぎず、購入済み判定の正本にしない）。
 *
 * Response:
 * {
 *   result: "OK",
 *   data: {
 *     allGranted: boolean,
 *     products: [{ productCode, granted }...],
 *     // 後方互換（単数リクエスト時のみ付与）
 *     productCode?: string, granted?: boolean
 *   }
 * }
 */
/**
 * GET /api/purchases/active-checkout
 *
 * ログインユーザーの「現在再開可能な購入手続き」を返す（STORE 表示の正本）。
 *
 * 手順:
 *   1. AUTH_USER_ID（認証情報から取得。クライアント指定不可）で active(CREATING/OPEN) attempt を全取得。
 *   2. 各候補を既存 settleAttemptViaStripe(expireOpen:false) で Stripe 状態確認:
 *      - open_active  → 再開可能な候補
 *      - expired/not_created → settle 内で EXPIRED/CANCELLED 同期＋lock 解放済み（副作用のみ）
 *      - already_paid → 成立済み（表示しない）
 *      - indeterminate → 状態不明。lock 維持・変更なし（表示しない）
 *   3. 再開可能な候補が複数ある場合は、最新（ATTEMPT_ID 最大＝開始順で最後）を残し、
 *      それ以前の候補は settleAttemptViaStripe(expireOpen:true) で安全に終了（Stripe open は
 *      expire 成功時のみ終端化・lock 解放。状態不明/expire 失敗は維持）。
 *
 * レスポンス: { resumable: { operationId, productCodes } | null }
 *
 * 二重 Pay 防止の最終確認は購入実行時（handleCheckout）が担う。これは表示用の状態同期。
 */
export async function handleActiveCheckout(request: Request, env: Env): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    const actives = await getActiveAttemptsForUser(env, auth.authUserId);
    if (actives.length === 0) {
      return jsonOk({ resumable: null });
    }

    // 各候補を Stripe 状態で評価（open は expire せず判定のみ）。
    const resumableAttempts: typeof actives = [];
    for (const att of actives) {
      const r = await settleAttemptViaStripe(env, att, {
        expireOpen: false,
        authUserId: auth.authUserId,
      });
      if (r === "open_active") {
        resumableAttempts.push(att);
      } else if (r === "completed") {
        // Stripe complete だが attempt 未 PAID の可能性。既存 fulfillment に収束させる
        // （新しい反映ロジックを二重実装しない）。SID は completed 時点で存在する。
        if (att.STRIPE_SESSION_ID) {
          const f = await fulfillCheckoutSession(env, att.STRIPE_SESSION_ID, "recovery");
          if (
            f.outcome === "newly_fulfilled" ||
            f.outcome === "already_fulfilled" ||
            f.outcome === "duplicate_detected"
          ) {
            // fulfillment 成功 → attempt PAID / lock 解放済み → pending 非表示（対象外）。
          } else {
            // not_paid / invalid_session / inconsistent_data 等は確定できない。
            // 推測で終端化せず安全側を維持（この attempt は resumable にも入れない）。
          }
        }
      }
      // expired/not_created は settle が終端化＋lock 解放済み。already_paid/indeterminate は非表示。
    }

    if (resumableAttempts.length === 0) {
      return jsonOk({ resumable: null });
    }

    // 「現在の購入手続き」は原則 1 件。複数 open が残っていれば最新（末尾＝ATTEMPT_ID 最大）を残し、
    // それ以前は既存の安全処理（expireOpen:true）で終了。ただし expire に失敗した/状態不明の古い
    // open が残ると「最大 1 件」の前提が崩れるため、その場合は resumable を確定せず状態確認中を返す
    // （古い Stripe Session を生かしたまま UI だけ隠さない）。
    const latest = resumableAttempts[resumableAttempts.length - 1];
    let allOldSettled = true;
    for (let i = 0; i < resumableAttempts.length - 1; i++) {
      const r = await settleAttemptViaStripe(env, resumableAttempts[i], {
        expireOpen: true,
        authUserId: auth.authUserId,
      });
      // 古い open を安全に終端化できたのは cancelled / expired / not_created のみ。
      // completed（別途 fulfillment 対象）/ indeterminate / expire 失敗等は「終了できていない」。
      if (r !== "cancelled" && r !== "expired" && r !== "not_created") {
        allOldSettled = false;
      }
    }

    if (!allOldSettled) {
      // 古い open を安全に終了できなかった → 最大 1 件の前提を満たせない。安全側で状態確認中を返す。
      return jsonError(
        "ACTIVE_CHECKOUT_PENDING",
        "以前の購入手続きの状態を確認しています。しばらくしてから、もう一度お試しください。",
        503,
      );
    }

    // 最新の再開可能候補の商品コードを返す。
    const items = await getAttemptItems(env, latest.ATTEMPT_ID);
    const productCodes = items.map((it) => it.PRODUCT_CODE);
    return jsonOk({
      resumable: { operationId: latest.OPERATION_ID, productCodes },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handlePurchaseStatus(request: Request, env: Env): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }

  const url = new URL(request.url);
  const parsed = parseStatusProductCodes(
    url.searchParams.get("productCodes"),
    url.searchParams.get("productCode"),
  );
  if (!parsed) {
    return jsonError("VALIDATION_ERROR", "入力内容を確認してください。", 400, {
      productCodes: "商品コードを指定してください。",
    });
  }

  // 各商品の権限反映を既存 entitlement 判定で確認（ログイン中ユーザーのみ）
  const products: { productCode: string; granted: boolean }[] = [];
  for (const code of parsed.codes) {
    const granted = await isProductAvailable(env, auth.authUserId, code);
    products.push({ productCode: code, granted });
  }
  const allGranted = computeAllGranted(products);

  const data: Record<string, unknown> = { allGranted, products };
  // 後方互換: 単数 productCode で来た場合は従来形（productCode/granted）も返す
  if (parsed.singleMode && products.length === 1) {
    data.productCode = products[0].productCode;
    data.granted = products[0].granted;
  }

  return jsonOk(data);
}

/* ============================================================
 * success recovery: POST /api/purchases/recover { sessionId }
 *   - requireUser 必須
 *   - Stripe Session を再取得し metadata.auth_user_id === ログイン中 authUserId を照合
 *     （不一致は 403 SESSION_FORBIDDEN。URL の session_id を信用しない）
 *   - paid なら共通 fulfill（冪等）。Webhook より先に来ても安全。
 * ============================================================ */

/** Checkout Session ID の軽い形式チェック（cs_ で始まる文字列）。 */
function isValidSessionId(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("cs_") && v.length <= 200;
}

export async function handleRecover(request: Request, env: Env): Promise<Response> {
  try {
    const auth = await requireUser(request, env);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError({ sessionId: "セッションIDが不正です。" });
    }
    const sessionId =
      body && typeof body === "object" ? (body as Record<string, unknown>).sessionId : undefined;
    if (!isValidSessionId(sessionId)) {
      throw new ValidationError({ sessionId: "セッションIDが不正です。" });
    }

    // 所有者照合: Stripe から Session を取得し metadata.auth_user_id を確認
    const stripe = getStripe(env);
    let session: import("stripe").Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      throw new AppError("INVALID_SESSION", "購入情報を確認できませんでした。", 404);
    }
    if (session.metadata?.auth_user_id !== auth.authUserId) {
      // 他人の Session を fulfill/閲覧させない
      throw new AppError("SESSION_FORBIDDEN", "この購入情報にはアクセスできません。", 403);
    }

    const r = await fulfillCheckoutSession(env, sessionId, "recovery");
    // 今回 Session の購入商品コード（success 画面が「全商品 granted」を判定する正本）
    const purchasedCodes = r.productCodes ?? [];
    // 所有者確認済み Session の operationId（= client_reference_id）。success 画面が
    // 「今回の Session に対応する pending か」を照合し、一致時のみ pending を消すために返す。
    const operationId =
      typeof session.client_reference_id === "string" ? session.client_reference_id : null;
    switch (r.outcome) {
      case "newly_fulfilled":
        return jsonOk({ result: "newly_fulfilled", purchasedCodes, operationId });
      case "already_fulfilled":
      case "duplicate_detected":
        // ユーザー視点では成立済み（重複は運用側で処理）
        return jsonOk({ result: "already_fulfilled", purchasedCodes, operationId });
      case "not_paid":
        return jsonOk({ result: "not_paid", purchasedCodes, operationId });
      case "invalid_session":
        return jsonError("INVALID_SESSION", "購入情報を確認できませんでした。", 404);
      case "inconsistent_data":
      default:
        return jsonError("RECOVER_PENDING", "購入処理を確認しています。しばらくお待ちください。", 503);
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

/* ============================================================
 * cancel: POST /api/purchases/cancel { operationId }
 *   - requireUser 必須
 *   - operationId + AUTH_USER_ID で attempt 特定（sessionId を browser から受けない）
 *   - open は Stripe Expire API で明示 expire → CANCELLED / lock 解放
 *   - complete(paid) は cancel しない（保護）。expired は EXPIRED / lock 解放。
 *   - cancel API が呼ばれない場合は expired Webhook / 開始時 stale 確認で回収。
 * ============================================================ */

export async function handleCancel(request: Request, env: Env): Promise<Response> {
  try {
    const auth = await requireUser(request, env);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError({ operationId: "購入手続きの識別子が不正です。" });
    }
    const operationId = validateOperationId(
      body && typeof body === "object" ? (body as Record<string, unknown>).operationId : undefined,
    );

    const attempt = await getAttemptByOperationId(env, operationId);
    if (!attempt || attempt.AUTH_USER_ID !== auth.authUserId) {
      throw new AppError("ATTEMPT_NOT_FOUND", "対象の購入手続きが見つかりません。", 404);
    }

    // Stripe 状態に基づく安全終着（open は expire する）。
    const r = await settleAttemptViaStripe(env, attempt, {
      expireOpen: true,
      authUserId: auth.authUserId,
    });
    switch (r) {
      case "already_paid":
      case "completed":
        // 支払い済み（既 PAID / Stripe complete）は cancel しない。反映は success/Webhook/
        // active-checkout の fulfillment 経路に委ねる（cancel 経路では終端化しない）。
        return jsonOk({ result: "already_paid" });
      case "expired":
        return jsonOk({ result: "expired" });
      case "cancelled":
      case "not_created":
        return jsonOk({ result: "cancelled" });
      case "indeterminate":
        // SID=NULL の create 結果不明は 409、それ以外（通信/expire 失敗）は 503。
        if (!attempt.STRIPE_SESSION_ID) {
          return jsonError(
            "CANCEL_INDETERMINATE",
            "購入手続きの状態を確認しています。しばらくしてから購入手続きの再開でご確認ください。",
            409,
          );
        }
        return jsonError("CANCEL_RETRY", "購入手続きの状態を確認しています。もう一度お試しください。", 503);
      default:
        // open_active は expireOpen=true では返らない
        return jsonError("CANCEL_RETRY", "もう一度お試しください。", 503);
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
