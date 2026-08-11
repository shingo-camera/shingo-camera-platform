# WORK-011 spec 反映差分（shingo-camera-platform-spec 向け）

本 Platform 実装 ZIP には spec 本体（`database/TABLES.md` / `database/DDL.sql` / `api/PURCHASE_API.md` /
`operation/STRIPE.md` / `adr/`）が同梱されていない（spec は別リポジトリ）。
本ファイルは spec リポジトリへ反映すべき差分をまとめたもの。README.md「注文ライフサイクル堅牢化（WORK-011）」も併読。

---

## 1. database/DDL.sql・TABLES.md へ反映（migration 0006 全文）

反映元は本実装の `migrations/0006_add_checkout_attempt_lifecycle.sql`。追加は以下 4 テーブル + 1 列。

### T_CHECKOUT_ATTEMPT（支払い試行ヘッダ）
- 主キー ATTEMPT_ID（AUTOINCREMENT）。
- STATUS: 0=CREATING / 1=OPEN / 2=PAID / 3=EXPIRED / 4=CANCELLED。
- OPERATION_ID は UNIQUE（UX_ATTEMPT_OPERATION）。STRIPE_SESSION_ID は partial UNIQUE（UX_ATTEMPT_SESSION、非 NULL のみ）。
- BUYER_EMAIL は attempt 開始時 snapshot（retry 時の再現に使用）。
- 索引 IX_ATTEMPT_USER_STATUS(AUTH_USER_ID, STATUS)。

### T_CHECKOUT_ATTEMPT_ITEM（試行明細スナップショット・immutable）
- ATTEMPT_ID + PRODUCT_ID が UNIQUE（UX_ATTEMPT_ITEM_PRODUCT）。
- STRIPE_PRICE_ID / SORT_NO を保存（Price 変更後も初回値で create 再現）。EXPECTED_AMOUNT は将来の監査用予約列で現行フローでは未使用・0 を許容（金額正本は Stripe 側）。

### T_PRODUCT_CHECKOUT_LOCK（二重 Checkout 排他）
- PRIMARY KEY(AUTH_USER_ID, PRODUCT_ID)。行の存在＝active 予約（方式B）。
- ATTEMPT_ID で予約元を辿る（IX_LOCK_ATTEMPT）。fulfill/cancel/expire で DELETE。

### T_PAYMENT_EVENT（決済運用イベント）
- EVENT_TYPE: 1=DUPLICATE_PAID / 2=REFUND / 3=DISPUTE / 4=FULFILL_FAILURE / 5=RECONCILE / 6=SERVER_INDETERMINATE。
- STRIPE_EVENT_ID は partial UNIQUE（UX_PAYEVENT_STRIPE_EVENT、非 NULL のみ）→ Webhook 再送の冪等記録。
- STRIPE_REQUEST_ID（B2 調査用）、NOTIFIED_DATE（管理者通知済みフラグ）。

### T_ORDER 変更
- `PAYMENT_INTENT_ID TEXT`（NULL 可）追加 + IX_T_ORDER_PI。refund/dispute の payment_intent 逆引きに使用。
- 既存 T_ORDER/T_PURCHASE/T_USER_PRODUCT のスキーマ・付与ロジックは無改変（MODEL C）。

### T_CHECKOUT_ATTEMPT 追加列（レビュー反映）
- `CREATE_ATTEMPTED INTEGER NOT NULL DEFAULT 0`。Stripe create を呼ぶ直前に 1 を確定する。
  `0 + SID=NULL`=create 未試行（cancel で lock 解放可）、`1 + SID=NULL`=create 結果不明（Session が存在し得るため cancel だけで lock を解放しない）。

---

## 2. api/PURCHASE_API.md へ反映

### POST /api/purchases/checkout（改訂）
- request: `{ productCodes: string[], operationId: string(UUID) }`（旧 `productCode` 単数は廃止）。
- 200: `{ checkoutUrl }`（新規/既存 open）または `{ alreadyPaid: true }`（既に成立）。
- エラー: ALREADY_IN_PROGRESS(409) / OPERATION_MISMATCH(409) / DEPENDENCY_REQUIRED(409) /
  ALREADY_PURCHASED(409) / RATE_LIMITED(429) / CHECKOUT_RETRY(503) / CHECKOUT_PENDING(503) /
  CHECKOUT_CREATE_FAILED(502) / AUTH_EMAIL_REQUIRED(403)。

### POST /api/purchases/recover（新規）
- request: `{ sessionId: string(cs_...) }`。requireUser。
- metadata.auth_user_id ≠ ログイン user は 403 SESSION_FORBIDDEN。
- 200: `{ result: newly_fulfilled | already_fulfilled | not_paid, purchasedCodes: string[] }`。
  `purchasedCodes` は今回 Session の購入商品コード。success 画面はこれ全てが available で完了とする。

### POST /api/purchases/cancel（新規）
- request: `{ operationId: string(UUID) }`（sessionId は受けない）。requireUser。
- 200: `{ result: cancelled | expired | already_paid }`。
- 409 `CANCEL_INDETERMINATE`（create 結果不明で lock 維持）/ 503 `CANCEL_RETRY`（Stripe 状態確定不能で lock 維持）。
- open は Stripe Expire API 成功時のみ expired 確定として解放。失敗時は再 retrieve で complete/expired を確定できたときのみ対応し、確定不能なら lock 維持。

### 管理（api/ADMIN_API.md または PURCHASE_API.md）
- POST /api/admin/purchases/reconcile `{ sessionId }` → `{ result, detail }`
  （newly_fulfilled/already_fulfilled/not_paid/invalid_session/duplicate_detected/inconsistent_data）。
- GET /api/admin/orders、GET /api/admin/orders/{orderId}、GET /api/admin/payment-events。

---

## 3. operation/STRIPE.md へ反映

- Webhook 対象イベントに追加: `checkout.session.expired`, `charge.refunded`（または `refund.created/updated/failed`）,
  `charge.dispute.created/updated/closed`。
- Secrets: `STRIPE_PRICE_HANABI`, `STRIPE_PRICE_HANABI_GOOGLE_EARTH` を設定（STORE 3 商品販売）。
- 非秘密環境変数 `APP_BASE_URL`（固定オリジン）を追加。success_url / cancel_url はこの固定値から生成し、
  `request.url.origin` は使わない（同一 operation の retry で origin が揺れて Stripe create パラメータが変わるのを防ぐ）。
  Local は `.dev.vars` に `http://localhost:8787`、Production は wrangler.toml `[vars]` か Dashboard の Variables で実 URL を設定。
- customer_email（認証 email）で購入者メールを固定。metadata は監査用（付与の正本にしない）。
- success_url は `?session_id={CHECKOUT_SESSION_ID}`、cancel_url は `?operation_id=<operationId>`（{CHECKOUT_SESSION_ID} 非依存）。

---

## 4. adr/ADR-009（新規）: 支払い試行層と DB 制約による並行排他

### 決定
- Stripe Checkout Session を「支払い試行」として Platform 側で追跡する層（T_CHECKOUT_ATTEMPT/_ITEM）を追加する。
- 二重 Checkout の排他は `T_PRODUCT_CHECKOUT_LOCK` の PRIMARY KEY を DB 制約の正本とする（方式B）。
- 新規 attempt＋item＋cart 全 lock を 1 batch で確定し、lock は素 INSERT（ON CONFLICT なし）とする。

### 理由
- Workers はリクエストごとにインスタンスが分離するため in-memory lock は使えない。DB 制約が唯一の正本。
- 「SELECT して無ければ INSERT」は TOCTOU 競合を許す。PK 制約 + batch 全 rollback なら competing insert が確実に片方だけ成功する。
- 素 INSERT により競合時 SQLITE_CONSTRAINT で batch 全体が rollback され、敗者は部分ロックを一切残さない
  （明示 CANCELLED も不要）。Local D1（miniflare 相当・node:sqlite）で実測確認。

### 却下案
- 部分成功＋リトライ（採用せず。原子性が崩れ状態が複雑化）。
- ON CONFLICT DO NOTHING（採用せず。敗者が競合を検知できず二重 Session を作り得る）。

### create パラメータ再現（FINAL_APPENDIX）
- retry は実行時の auth.email / Price 解決 / 時刻を使わず、attempt 開始時 snapshot（BUYER_EMAIL / STRIPE_PRICE_ID /
  PRODUCT_CODE / SORT_NO）から決定的に再構築し、server 生成 idempotencyKey で送る。
  （EXPECTED_AMOUNT は将来の監査用予約列で create 再現には未使用・0 を許容。金額正本は Stripe 側。）

### レビュー反映の追補（購入事故防止）
- **CREATE_ATTEMPTED**: create を呼ぶ直前に DB 確定。SID=NULL でも「試行済み（結果不明）」を判別し、
  「Session が存在するかもしれないのに lock を解放する」を防ぐ。CREATE_ATTEMPTED=1 直後に Worker が落ちても
  lock を維持し、同一 idempotencyKey の recover へ倒す（安全側）。
- **cancel の lock 解放**: open は Stripe Expire API 成功時のみ解放。expire 失敗時は再 retrieve で状態を確定できたときのみ
  対応し、確定不能なら lock 維持。
- **CASE C（SID 保存失敗）**: fulfill 時の attempt 特定は第一に STRIPE_SESSION_ID 一致。見つからない場合のみ
  Session.client_reference_id(=operationId) で再特定し、①OPERATION_ID ②検証済み AUTH_USER_ID
  ③Stripe 実 line_items = ATTEMPT_ITEM snapshot = CART_KEY を全て満たしたときのみ SID 回収 → PAID → lock 解放。
  metadata.product_codes 単独では成立させない（実 line_items と immutable snapshot を正本）。
- **固定 origin**: Stripe create の success_url/cancel_url は APP_BASE_URL から生成（request.url.origin 不使用）。
  同一 operation の retry で origin が揺れて create パラメータが変わる設計に戻さない。
- **success 画面**: recover の purchasedCodes（今回 Session の購入商品）だけを追跡し、全て available で完了。
- **cancel 画面**: server 結果（cancelled/expired/already_paid/結果不明）で表示。already_paid・結果不明で
  「請求されていません」と断定しない。

---

## 5. Stripe create 失敗分類（ERROR_CLASSIFICATION_FINAL・operation/STRIPE.md）

| Stripe error type | 分類 | lock | 扱い |
|---|---|---|---|
| StripeInvalidRequestError / StripeAuthenticationError / StripePermissionError | CONFIRMED_FAILURE | 解放 | Session 未作成が確定。attempt CANCELLED。502 |
| StripeRateLimitError | RATE_LIMIT | 維持 | 同 operation で backoff 後再試行。429 |
| StripeIdempotencyError | INCONSISTENT | 維持 | Session 作成済みの可能性。記録・調査。409 |
| StripeConnectionError | NETWORK_INDETERMINATE | 維持 | 同 key で再送し収束。503 CHECKOUT_RETRY |
| StripeAPIError（5xx） | SERVER_INDETERMINATE | 維持 | 単純再送で Session 期待しない。Webhook reconcile 待ち・記録。503 CHECKOUT_PENDING |
| （判定不能） | SERVER_INDETERMINATE | 維持 | 保守的に維持側へ倒す |

---

## 7. operation（Local/Test 専用・Production API 仕様ではない）

`POST /api/admin/test/reset-purchases`（Local/Test 専用の購入状態リセット）は Production API 仕様ではなく
**Local/Test operation** として記録する（Production では 404）。

- 目的: 同一テストユーザーで購入→reset→再購入を繰り返す。Supabase Auth / M_USER は削除しない。
- 二重防御: 環境ガード（APP_ENV が local/test のときのみ利用可。production/未設定/空/未知値は 404 deny-by-default）＋ requireAdmin。
- 削除対象（対象ユーザー分のみ・FK 安全順・1 D1 batch）: T_USER_PRODUCT / T_PURCHASE / T_PAYMENT_EVENT /
  T_ORDER / T_PRODUCT_CHECKOUT_LOCK / T_CHECKOUT_ATTEMPT_ITEM / T_CHECKOUT_ATTEMPT。
- Phase 1（batch 外）で active attempt を Stripe 確認。状態不明は ACTIVE_CHECKOUT_INDETERMINATE で中止し DB 無変更。
- Stripe 側の Session/PaymentIntent/Charge/Refund は削除しない。reset 後も過去 Session を reconcile で再付与可能。
- エラー: PRODUCTION_FORBIDDEN(404) / UNAUTHORIZED(401) / FORBIDDEN(403) / USER_NOT_FOUND(404) /
  ACTIVE_CHECKOUT_INDETERMINATE(409) / INTERNAL_ERROR(500)。
- 実メール / 実 AUTH_USER_ID / 実 Stripe Session ID を spec・ソースに固定記載しない。

## 8. テスト（本実装 test/ 配下・spec の TEST.md へ要約反映）

- `test/checkout_pure.test.mjs`（24件）: operationId 検証 / CART_KEY / idempotencyKey / error 分類 / line_items 検証 / epoch→JST。
- `test/checkout_db.test.mjs`（12件）: lock PK 競合 batch rollback / 3 商品原子性 / create パラメータ snapshot 再現 /
  duplicate paid 検出 / payment_event 冪等 / attempt 状態遷移。
- `test/checkout_review.test.mjs`（16件・レビュー反映）: CREATE_ATTEMPTED 判定 / markCreateAttempted /
  CASE C reconcile（SID 一致・operationId 回収・owner 不一致・商品構成不一致）/ 固定 origin 不変（resolveBaseUrl /
  rebuildCreateParams retry 不変）/ success 全商品追跡判定（既保有含む一部未反映で不成立・全 available で成立）。
- `test/reset_purchases.test.mjs`（14件・Local/Test reset）: 環境ガード（production 不可/local 可）/ active attempt 分類
  （CREATE_ATTEMPTED・SID・Stripe 状態の 6 パターン）/ FK 安全順削除・件数 / 他ユーザー保護 / 途中失敗 rollback /
  reset 後 T_USER_PRODUCT 空（granted=false 相当）/ paid 履歴前提でも reset 可 / 同一 Session 再付与の余地。
- `test/purchase_logic.test.mjs`（既存 19件）: 回帰なし。合計 94件 全 PASS。
- Stripe 実機依存（recover 各 SID 状態 / 他人 session 403 / admin reconcile / cancel の open→expire 実挙動 /
  expire 失敗時の再 retrieve / reset の Stripe retrieve・expire 実挙動 / requireAdmin HTTP 経路 / フロント表示）は
  README「E2E 手順」で手動確認。
