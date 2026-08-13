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
- 商品別 Stripe Price ID は M_PRODUCT.STRIPE_PRICE_ID（DB）へ移行済み。env の商品別 `STRIPE_PRICE_*` は廃止（下記 9/10 章参照）。
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

---
---

## 9. 商品販売設定の M_PRODUCT 一本化（migration 0007・最終形・spec へ反映）

反映元は本実装の `migrations/0007_add_product_sale_columns.sql`。M_PRODUCT へ販売専用列を追加し、
販売可否・表示価格・Stripe Price ID の正本を M_PRODUCT へ一本化した。
旧 SELLABLE_PRODUCT_CODES / site-config purchasable・amount・priceDisplay、env の商品別
STRIPE_PRICE_*、resolvePriceId の商品コード switch、KNOWN_PRODUCT_CODES は廃止した。

### database/DDL.sql・TABLES.md へ反映（M_PRODUCT へ列追加）
- `PURCHASE_ENABLED INTEGER NOT NULL DEFAULT 0`: 新規購入受付 ON/OFF（0=準備中/1=購入可）。販売可否の正本。
- `SALE_TYPE TEXT NOT NULL DEFAULT 'ONE_TIME'`: 'ONE_TIME'=買い切り / 'SUBSCRIPTION'=サブスク。
- `DISPLAY_PRICE INTEGER`（null 許容）: 表示用金額（税込想定）。**表示専用**。実課金額の正本ではない。
- `BILLING_INTERVAL TEXT`（null 許容）: ONE_TIME は NULL。SUBSCRIPTION は 'MONTH'/'YEAR' 等。
- `STRIPE_PRICE_ID TEXT`（null 許容）: Stripe 上の Price オブジェクト識別子（price_xxx）。**Checkout / Webhook 逆引きの正本**。
  API Secret ではない。公開 API / ブラウザへは返さない。NULL/空=販売設定未完了。
- 追加型のみ（ADD COLUMN）。DROP なし。STATUS の意味（商品マスタ自体の有効/無効）は不変。
- **DISPLAY_ORDER は追加しない**。表示順は既存 SORT_NO に一本化（HOME/STORE/Admin すべて SORT_NO）。
- UPDATE_DATE は既存日時仕様（JST ISO 8601）で生成: `strftime('%Y-%m-%dT%H:%M:%S','now','+9 hours') || '+09:00'`。
  `datetime('now')`（UTC・スペース区切り）は使わない。
- 初期値: SUN_AND_MOON(PURCHASE_ENABLED=1/ONE_TIME/13000/NULL)、HANABI(0/ONE_TIME/4000/NULL)、
  HANABI_GOOGLE_EARTH(0/ONE_TIME/10000/NULL)。STATUS は全 1。**STRIPE_PRICE_ID は migration に持たない（NULL）**。

### STRIPE_PRICE_ID の責務・Test/Live の DB 別管理（operation 文書へ反映）
- Stripe Price ID は Test/Live で値が異なるため、migration へハードコードしない。
- 環境ごとの D1（Local/Test D1・Production D1）に、それぞれ Test Price / Live Price を `M_PRODUCT.STRIPE_PRICE_ID`
  として設定する。Production では deploy 後に D1 へ UPDATE（or 初期設定スクリプト）で投入する。
- これにより Test Price を Production で使う・Live Price を Local で使う混在を構造的に防ぐ。
- Stripe API Secret（STRIPE_SECRET_KEY）・Webhook Secret（STRIPE_WEBHOOK_SECRET）は従来どおり
  env/Cloudflare Secret 管理。DB に持つのは商品設定としての STRIPE_PRICE_ID のみ。

### api/PRODUCT_API.md へ反映
- `GET /api/products`（公開）: code/name/sortNo/purchaseEnabled/saleType/displayPrice/billingInterval を返す。
  **STRIPE_PRICE_ID・Stripe Secret・内部 PRODUCT_ID は返さない**。DISPLAY_PRICE は表示専用の公開情報。SORT_NO 昇順。
- `GET /api/account/products`（認証）: 各商品に purchaseEnabled/saleType/displayPrice/billingInterval を追加。
  granted/available の判定は従来どおり T_USER_PRODUCT の状態・期間のみ（販売列・STRIPE_PRICE_ID を使わない）。

### api/PURCHASE_API.md・operation/STRIPE.md へ反映
- 新規購入可否の正本 = M_PRODUCT（STATUS=1 AND DEL_FLG=0 AND PURCHASE_ENABLED=1 AND SALE_TYPE='ONE_TIME'
  AND STRIPE_PRICE_ID 設定済み）。precheckMultiCheckout が Stripe Session 作成前に判定。
  PURCHASE_ENABLED≠1 → PRODUCT_NOT_SELLABLE(409)、STRIPE_PRICE_ID NULL/空 → PRODUCT_NOT_SELLABLE(409、販売設定未完了)、
  SALE_TYPE≠ONE_TIME → SALE_TYPE_NOT_SUPPORTED(409)。SUBSCRIPTION は現状 Stripe 前に安全側で拒否（将来対応）。
- Checkout の Price ID は M_PRODUCT.STRIPE_PRICE_ID が唯一の正本。DISPLAY_PRICE を Stripe Session へ金額として送らない
  （line_items の price=Price ID で作成）。実課金額の正本は Stripe Price。
- Webhook（stripe_fulfill）の Price→商品コード逆引き（buildPriceIdToCodeMap）も M_PRODUCT.STRIPE_PRICE_ID を正本に
  DB から構築する（env の商品別 Price は廃止）。fulfill / Webhook lifecycle の意味論自体は不変。
- STATUS / PURCHASE_ENABLED / entitlement の責務分離: isProductAvailable・T_USER_PRODUCT・note 移行権利へ
  PURCHASE_ENABLED / SALE_TYPE / STRIPE_PRICE_ID を混入させない。販売停止・Price 未設定でも既存権利は利用可能。

### テスト（TEST.md へ要約反映）
- `test/product_sale_control.test.mjs`（23件）: migration 0001〜0007 クリーン適用・列存在・DISPLAY_ORDER 不在（A）/
  UPDATE_DATE JST ISO8601（B）/ 初期値・Price 非ハードコード / precheck DB 判定（C〜F: 販売中・停止・Price NULL・SUBSCRIPTION）/
  複合拒否 / 新商品 DB 追加でコード改修なし（O）/ PURCHASE_ENABLED=1 切替で購入可 / entitlement 非影響（N・Price 未設定でも利用可）/
  公開 SELECT が STRIPE_PRICE_ID 非露出（M）/ STORE UI は purchaseEnabled+ONE_TIME のみ（G）/ 価格 DB 一元化（H〜K）/
  DISPLAY_PRICE を Stripe へ渡さない（L）/ Checkout・Webhook 逆引きとも DB STRIPE_PRICE_ID 正本 / KNOWN・SELLABLE・
  resolvePriceId(env switch) 廃止（P）/ site-config purchasable・amount・priceDisplay 削除。

---

## 10. Price 運用堅牢化（Price snapshot fulfill・UNIQUE/CHECK 制約・env 廃止・spec へ反映）

migration 0007 と fulfill を最終形へ補強した。目的は「Price 設定変更後の旧 Checkout の安全な fulfill」と
「販売設定の DB 制約強化」。checkout lifecycle（operationId/attempt/idempotency/recover/cancel/fulfill 権限付与/
rollback/T_ORDER・T_PURCHASE・T_USER_PRODUCT/Webhook event idempotency/refund・dispute）の意味論は変更していない。

### Checkout attempt の Price snapshot（database/TABLES.md・api/STRIPE.md へ反映）
- T_CHECKOUT_ATTEMPT_ITEM.STRIPE_PRICE_ID は Checkout 開始時のスナップショット（既存・migration 0006）。
- fulfill 時の Price→商品コード逆引きは、このスナップショットを正本にする（現在の M_PRODUCT ではなく）。
  Session ID 一致、なければ operationId（client_reference_id）一致で attempt を特定し、item snapshot から Map を構築。
- これにより Checkout 開始後に M_PRODUCT.STRIPE_PRICE_ID を変更しても、旧 Session（旧 Price）を正常 fulfill でき、
  「unknown price id で決済済みなのに権限付与不能」を防ぐ。新規 Checkout は開始時に現在の M_PRODUCT.STRIPE_PRICE_ID を
  snapshot へ保存するため、常に snapshot 経由で成立する。

### fulfill の Price 解決フローと fallback 限定（api/STRIPE.md へ反映）
- buildPriceIdToCodeMapFromAttempt の戻り値は resolved / not_found / invalid の 3 状態。
  - resolved: attempt を特定し snapshot から Map 構築 → これを正本に line item を検証。
  - invalid : attempt は特定できたが snapshot が不正（item なし / 空 Price / 同一 Price を複数商品へ割当）→
    安全側エラーにする。現在の M_PRODUCT へは fallback しない（Price 変更後の誤付与を防ぐ）。
  - not_found: SID/operationId のどちらでも attempt を特定できない限定互換経路のみ。ここに限り現在の
    M_PRODUCT 逆引き（buildPriceIdToCodeMap）へ fallback する。
- 「attempt が存在する以上、その snapshot の欠損・不一致はエラー」を原則とする。

### STRIPE_PRICE_ID UNIQUE・販売列 CHECK（database/DDL.sql・TABLES.md へ反映）
- 部分 UNIQUE INDEX `UX_PRODUCT_STRIPE_PRICE_ID ON M_PRODUCT (STRIPE_PRICE_ID) WHERE STRIPE_PRICE_ID IS NOT NULL
  AND STRIPE_PRICE_ID <> ''`。NULL/空は複数商品で許可、非空 Price ID は商品間で一意（同一 Price の誤割当を DB で防止）。
- 列 CHECK: PURCHASE_ENABLED IN(0,1) / SALE_TYPE IN('ONE_TIME','SUBSCRIPTION') / DISPLAY_PRICE IS NULL OR >=0 /
  BILLING_INTERVAL IS NULL OR IN('MONTH','YEAR')。SQLite の ADD COLUMN + 列レベル CHECK で付与（テーブルレベル CHECK は不可）。
- Checkout precheck 側にも同一カート内の Price ID 重複検知を安全網として維持（DB UNIQUE が正本、決済後に気付く事態を回避）。

### 商品別 Price env 廃止（operation 文書へ反映）
- env の STRIPE_PRICE_SUN_AND_MOON / STRIPE_PRICE_HANABI / STRIPE_PRICE_HANABI_GOOGLE_EARTH は完全廃止。
  実コード・.dev.vars.example・README・本メモから排除。残す Secret は STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET のみ。
- Test/Live 管理: Local/Test D1 に Test Price、Production D1 に Live Price を設定し環境ごとに独立管理。
  ただし人間が Production D1 へ Test Price を書き込むことは可能なため「構造的に完全防止」ではなく、
  混在防止は Production 設定確認と Test 環境での旧 Session fulfill E2E で担保する。

### テスト（TEST.md へ要約反映）
- `test/product_sale_control.test.mjs`（38件）: 上記に加え、販売列 CHECK 拒否（B〜E）/ STRIPE_PRICE_ID 非空 UNIQUE 拒否・
  NULL/空複数許可（F/G）/ Price snapshot 保存（H）/ Price 変更後の snapshot 解決（I）/ attempt 特定不能=not_found（J）/
  operationId null でも SID 解決（J2）/ snapshot 不正（空 Price・item なし）は invalid で fallback しない安全性 / 新規は
  現在 M_PRODUCT Price（K）/ migration の CHECK・UNIQUE 字面検証。

---

## 11. 商品購入依存関係の DB 化（migration 0008・M_PRODUCT_DEPENDENCY・spec へ反映）

商品購入の依存関係（追加機能商品は前提商品の所有が必要）を、コード固定定義 PRODUCT_DEPENDENCIES から
M_PRODUCT_DEPENDENCY テーブルへ移行した。依存判定の正本は DB。旧コード定義は廃止し二重管理を残さない。
migration 0008 は additive（0007 は変更しない・別責務として分離）。

### database/DDL.sql・TABLES.md へ反映（M_PRODUCT_DEPENDENCY）
- 列: DEPENDENCY_ID(PK AUTOINCREMENT) / PRODUCT_CODE(依存を持つ商品) / REQUIRES_CODE(前提商品) /
  DEPENDENCY_GROUP(グループ番号) / STATUS(1=有効/0=無効) / DEL_FLG / CREATE_DATE / UPDATE_DATE。
- 制約: CHECK(STATUS IN(0,1)) / CHECK(DEL_FLG IN(0,1)) / CHECK(PRODUCT_CODE <> REQUIRES_CODE)（自己依存禁止） /
  FK(PRODUCT_CODE, REQUIRES_CODE → M_PRODUCT.PRODUCT_CODE) / UNIQUE(PRODUCT_CODE, DEPENDENCY_GROUP, REQUIRES_CODE)。
- INDEX: UX_PRODUCT_DEPENDENCY（重複登録防止）/ IX_PRODUCT_DEPENDENCY_PRODUCT（引き当て）。
- 初期データ: HANABI_GOOGLE_EARTH → HANABI（グループ 0）。3D_PREVIEW は商品未登録のため投入しない。
- UPDATE_DATE/CREATE_DATE は JST ISO 8601（strftime +9 hours || '+09:00'）。

### 依存の意味（ANY_OF / ALL_OF）
- 依存は DEPENDENCY_GROUP でまとめる。グループ内=ANY_OF（いずれかの REQUIRES_CODE を満たせば充足）、
  グループ間=ALL_OF（すべてのグループを充足）。
- HANABI_GOOGLE_EARTH は単一グループに HANABI のみ・SATISFY_MODE=ENTITLEMENT_OR_CART=「HANABI を既所有」
  または「HANABI と EARTH を同一カートで購入」で充足（現行仕様と同一）。
- 将来 3D_PREVIEW は単一グループに HANABI と SUN_AND_MOON を SATISFY_MODE=ENTITLEMENT_ONLY で登録=ANY_OF。
  意味は「HANABI OR SUN_AND_MOON のどちらかを Checkout 開始前から有効 entitlement として所有していることが必要。
  同一カートに前提商品を入れても充足しない」。EARTH（ENTITLEMENT_OR_CART）とは充足方法が異なる。
  ※ SATISFY_MODE の詳細は後半「12. 商品依存関係のレビュー補正」を参照。

### api/PURCHASE_API.md へ反映（依存判定の正本）
- checkProductDependencies は M_PRODUCT_DEPENDENCY（STATUS=1 AND DEL_FLG=0）を正本に判定。DB に依存が無い商品は依存なし。
- 「所有」= 有効な T_USER_PRODUCT entitlement（STATUS=1・期間内・DEL_FLG=0）。購入履歴・注文履歴・Stripe 履歴は使わない。
  GRANT_TYPE を問わないため Admin 直接付与・note 移行付与も所有扱い。
- 充足 = 有効 entitlement を所有、または同一注文に前提商品を含む（同時購入）。未充足は DEPENDENCY_REQUIRED(409)。
- 安全側: 無効な依存定義は使わない。自己依存は DB CHECK で登録不可。存在しない/無効な前提商品は充足せず購入不可。
- 依存チェックは Checkout 前（precheckMultiCheckout 内）。既存 entitlement の利用可否（isProductAvailable）には
  購入依存を混入させない（利用可否と新規購入可否は別軸）。

### テスト（TEST.md へ要約反映）
- `test/product_dependency.test.mjs`（20件）: 初期データ / 前提未所有で EARTH 拒否 / 同時購入で可 / 有効 entitlement 所有で可 /
  ★購入履歴なし・Admin 直接付与(GRANT_TYPE=3) HANABI → EARTH 購入可 / note 付与でも可 / 無効 entitlement（STATUS≠1・
  期限切れ・DEL_FLG=1）は所有とみなさない / ANY_OF + ENTITLEMENT_ONLY（3D_PREVIEW は HANABI OR SUN_AND_MOON の既所有必須・
  同一カートでは充足不可）/ ALL_OF（別グループは両方必要）/
  無効依存定義は使わない / 前提商品無効は安全側拒否 / 自己依存 CHECK / 利用可否に依存非混入 / 旧 PRODUCT_DEPENDENCIES 廃止 /
  migration 0008 の制約・初期データ・JST 日時。

---

## 12. 商品依存関係のレビュー補正（SATISFY_MODE・循環検出・0008 最終形）

11 章の依存 DB 化に対するレビュー補正。migration 0008 を最終形へ整理し（0009 は追加しない）、
充足方法の区別・循環検出を追加した。checkout lifecycle / Price snapshot / migration 0007 / entitlement 付与は不変。

### SATISFY_MODE（充足方法の区別）
- M_PRODUCT_DEPENDENCY に SATISFY_MODE 列を追加。CHECK (SATISFY_MODE IN ('ENTITLEMENT_ONLY','ENTITLEMENT_OR_CART'))。
  - ENTITLEMENT_OR_CART: 有効 entitlement を所有、または同一注文（同時購入）に前提商品を含めば充足。
  - ENTITLEMENT_ONLY   : Checkout 開始前から有効 entitlement を持つ場合のみ充足（同一注文では充足しない）。
- 同一 PRODUCT_CODE + DEPENDENCY_GROUP 内は同一 SATISFY_MODE 必須（ANY_OF の評価単位）。DB 列 CHECK は単一行値のみ
  強制するため、複数行にまたがる一貫性は判定時に検証し、混在は DependencyConfigError（内部設定エラー）で拒否（二重防御）。
- EARTH: HANABI_GOOGLE_EARTH → HANABI / ENTITLEMENT_OR_CART（現行の同一カート挙動を維持・初期データ）。
- 将来 3D_PREVIEW: HANABI と SUN_AND_MOON を同一グループ・ENTITLEMENT_ONLY（HANABI OR SUN_AND_MOON を既所有の場合のみ購入可）。

### DEPENDENCY_GROUP と ANY_OF / ALL_OF（維持）
- 同一グループ内 = ANY_OF、グループ間 = ALL_OF。例: (A OR B) AND (C OR D)。

### entitlement 正本・Admin 直接付与
- 「所有」= 有効な T_USER_PRODUCT entitlement（isProductAvailable）。T_PURCHASE / T_ORDER / Stripe 履歴 / GRANT_TYPE は不参照。
  Stripe 購入・note 移行・Admin 直接付与・テスター付与など取得経路を問わず、有効 entitlement なら所有扱い。
  Admin 直接付与 HANABI（購入履歴 0 件）でも EARTH / 3D_PREVIEW の依存を満たす。
- 依存関係・循環検出は新規購入可否のみに影響し、既存 entitlement の利用可否（isProductAvailable）には非混入。

### 循環依存の拒否
- assertNoDependencyCycle: M_PRODUCT_DEPENDENCY 全体（STATUS=1 AND DEL_FLG=0 のみ）を DFS 3 色塗り分けで検査。
  A→B→A / A→B→C→A を検出し DependencyConfigError で拒否（A+B 同時カートでも抜けられない）。自己依存は DB CHECK。
  無効化・削除済み依存は循環判定に含めない。checkProductDependencies の冒頭で実行。
- DependencyConfigError（循環・SATISFY_MODE 混在・未知 SATISFY_MODE）は INTERNAL_ERROR(500) へ変換。
  SQL・テーブル名・内部 ID・stack trace をブラウザへ出さず、詳細はサーバーログのみ（StripeConfigError と同方針）。

### migration 0008 最終形（DDL）
- 列: DEPENDENCY_ID(PK) / PRODUCT_CODE / REQUIRES_CODE / DEPENDENCY_GROUP / SATISFY_MODE / STATUS / DEL_FLG / 日時。
- CHECK: STATUS IN(0,1) / DEL_FLG IN(0,1) / PRODUCT_CODE<>REQUIRES_CODE（自己依存禁止） /
  SATISFY_MODE IN('ENTITLEMENT_ONLY','ENTITLEMENT_OR_CART')。FK(PRODUCT_CODE, REQUIRES_CODE→M_PRODUCT)。
- UNIQUE(PRODUCT_CODE, DEPENDENCY_GROUP, REQUIRES_CODE)。IX_PRODUCT_DEPENDENCY_PRODUCT。
- PRAGMA foreign_keys = ON を明示（0001 からの同一 connection に依存しない）。
- seed は INSERT OR IGNORE（再適用安全・UNIQUE と整合）。EARTH→HANABI / ENTITLEMENT_OR_CART。日時 JST ISO 8601。

### テスト（TEST.md へ要約反映・product_dependency.test.mjs 34件）
- EARTH: HANABI 所有 OK / 同時カート OK（現行維持）/ 単品 NG / Admin 付与 OK。
- 3D_PREVIEW(ENTITLEMENT_ONLY): HANABI 既所有 OK / SUN_AND_MOON 既所有 OK / 両方 OK / どちらも未所有 NG /
  HANABI+3D 同時カート NG / SUN+3D 同時カート NG / Admin 付与 HANABI・T_PURCHASE 0件 OK。
- ANY_OF / ALL_OF 維持。循環（A→B→A, A→B→C→A）拒否 / 循環なし多段 OK / 無効依存は循環判定に含めない。
- SATISFY_MODE 不正値 DB CHECK 拒否 / 同一グループ混在 DependencyConfigError。seed 再適用安全。
- 自己依存 DB CHECK。entitlement 利用可否に依存非混入。既存 Price snapshot / Checkout / Webhook / fulfill テスト全 pass。

### 次工程（サブスク前）残件
- STORE の「購入済み」表示を granted と available で再整理（期限切れでも購入済み表示になり得る問題）。
- 期限切れ subscription の再契約導線。expired entitlement を購入済みで購入不可にしない。現買い切り商品には非影響。

---

## 13. セッション観測・不正検知観測（SESSION_ID_HASH 記録・PERIODIC_CHECK heartbeat）

「強制的なセッション期限・定期再ログインは導入せず、ログイン状態を維持したまま通常利用中のセッション観測を
追加して不正利用検知を成立させる」方針の実装。checkout lifecycle / Price snapshot / 商品依存 DB 化 / entitlement 付与は不変。

### Supabase セッション仕様の前提
- refresh token は固定有効期限で失効するのではなく、refresh 時にローテーションされる。
- デフォルトでは session は logout 等がない限り継続し得る。
- time-box / inactivity timeout / single-session は別設定（本実装では使わない・single session 強制もしない）。
- access token には session_id claim が含まれる。実装時は JWT payload.session_id の型・UUID 形式を検証する。

### SESSION_ID_HASH 記録（生 session_id 非保存）
- requireUser（src/shared/auth.ts）が検証済み JWT payload から session_id を取得し UUID 形式を確認、AuthContext.sessionId として返す。欠落・不正形式は null（安全側）。
- computeSessionIdHash（src/shared/session_hash.ts）がサーバー鍵 env.SESSION_ID_HASH_SECRET で HMAC-SHA256 し "v1:<hex>" を生成。生 session_id は保存しない。同一 session→同一 hash、別 session→別 hash、鍵が別→別 hash。session_id 欠損・鍵未設定なら null（SESSION_ID_HASH は NULL・記録は継続）。クライアント入力を鍵にしない。
- writeAccessLog（src/shared/logs.ts）に sessionIdHash 引数を追加し T_ACCESS_LOG.SESSION_ID_HASH へ保存（従来 NULL 固定を解除）。既存列を使い migration 追加なし。
- app-start（ACCESS_TYPE=0）/ entitlement-check（ACCESS_TYPE=1）も session_id を渡すよう更新。AUTH_USER_ID + SESSION_ID_HASH で同一アカウント内の別 session を区別できる。

### PERIODIC_CHECK heartbeat（継続利用中の低頻度観測）
- 新エンドポイント POST /api/apps/sun-and-moon/heartbeat（src/apps/sun-and-moon/heartbeat.ts）。
- requireProduct(SUN_AND_MOON) で権限確認（ログイン必須・有効 JWT 必須・未購入/停止は拒否）。authUserId/session_id は JWT 正本。
- recordPeriodicAccess（src/shared/entitlement.ts）が ACCESS_TYPE=2 を既存 ACCESS_LOG_INTERVAL_MIN（60分）抑制付きで append 記録。LAST_SEEN 型集約は導入しない（DB 変更なし）。抑制キーは AUTH_USER_ID/PRODUCT_ID/ACCESS_TYPE/DEVICE_ID（session_id は抑制キーに含めず記録のみ）。
- DEVICE_ID は既存 X-Device-Id、IP/国/地域/市/UA は既存 Cloudflare request 情報を再利用。GPS 非取得。entitlement/購入権限は変更しない。記録失敗・設定エラーでもアプリ本体利用を妨げない。
- フロント（public/apps/sun-and-moon/auth-integration.js）は権限確認成功後、アプリ表示中(visible)のみ60分間隔で heartbeat 送信。非表示・離脱中は停止（バックグラウンド無限送信なし・閉じている間の追跡なし）。best-effort。

### 不正判定は今回無変更
- MANY_DEVICES / MANY_REGIONS / COUNTRY_CHANGE / warning Cron / cooldown・NOTIFIED_DATE / 管理者メール / 自動BANなし を維持。IP 単独で warning する処理は追加しない。SESSION_ID_HASH 記録後も「複数 session だから即 warning」は追加しない（まずログ蓄積）。将来、実ログを見て必要なら session ベース warning を検討。

### 環境変数
- SESSION_ID_HASH_SECRET（HMAC 鍵・任意）。Cloudflare Secret / .dev.vars で設定し Git/toml に書かない。未設定なら SESSION_ID_HASH は NULL のまま。.dev.vars.example に説明追記。

### テスト（session_hash.test.mjs 7件 / session_observation.test.mjs 9件）
- HMAC 決定性（同一 session→同一 hash・別 session→別 hash・別鍵→別 hash）、生 session_id 非含有、session_id/鍵欠損で null。
- app-start / entitlement-check / heartbeat の各ログに SESSION_ID_HASH 記録、heartbeat は ACCESS_TYPE=2、IP/地域/DEVICE_ID/UA 記録、生 session_id 非保存、鍵未設定で NULL・記録継続、60分抑制、別 ACCESS_TYPE 独立。
- 既存 warning 判定・checkout・依存 DB 化テストは全 pass（回帰なし）。

### 残件（LAUNCH_CHECKLIST に記録）
- LOGIN_FAILURE warning は T_LOGIN_LOG 未接続のため現在未稼働（別課題・認証フロー大規模変更はしない）。
- Admin から本人確認メールを送る導線 / session 単位 Admin 表示 / access log 保持期間・削除運用 / 将来の session ベース warning 条件。
- セッション期限は現時点で強制導入しない。
