# 発売前チェックリスト（shingo_camera LABO / SUN AND MOON PLANNER）

更新日: 2026-08-13

本ファイルは、この実装リポジトリにおける **発売前残件の一元管理正本** とする。
spec リポジトリ（`shingo-camera-platform-spec`）側の `operation/RELEASE_CHECKLIST.md` は
Production 環境作業（インフラ・Stripe Live・Supabase 本番等）の運用手順の正本であり、
役割が重複しないよう、本ファイルでは「この実装リポジトリのコード・ローカル検証で確定できる範囲」と
「Production／コンテンツ待ちとして残る範囲」を区別して管理する。

状態区分:
- [完了] コード・仕様・ローカル検証まで完了
- [Production作業待ち] 本番環境／Live Secret がないと確定できない
- [コンテンツ待ち] note 記事・画像等の素材待ち
- [任意改善] 発売 BLOCKER ではない改善候補

---

## [完了] コード・ローカル検証まで完了

### 公開サイト・ブランド
- [x] 公開名称を `shingo_camera LABO` に統一（HOME/Products/STORE/商品/認証/法務/SUPPORT/フッター）
- [x] 公開 UI 上の旧 `Platform` 表記を除去（バッジ「準備中」統一・STORE 移行文言・store meta description・robots.txt コメント）。内部コメント/CSS 設計名の Platform は内部呼称として保持
- [x] 認証4ページ（login/signup/forgot-password/reset-password）の title・brand を `shingo_camera LABO` に統一
- [x] 公開 UI・metadata から旧 `shingo-camera Platform` / `shingo_camera Platform` 表記を除去し、公開名称方針と矛盾しない状態を確認（公開 HTML の旧 Platform 表記ゼロ）。各ページ title の実体は HOME=`shingo_camera LABO` / STORE=`Store — shingo_camera` / Products=`Products — shingo_camera` / SUN AND MOON=`SUN AND MOON PLANNER — shingo_camera LABO`。OGP `og:site_name`/`og:title` は既存方針どおり `shingo_camera`（LABO なし）で不変
- [x] robots.txt（`Disallow: /api/` のみ・Sitemap 行）
- [x] sitemap.xml（公開4ページ: `/` `/store/` `/products/` `/products/sun-and-moon/`）
- [x] 公開4ページ canonical / meta description / OGP 基礎（type/title/description/url/site_name）
- [x] 内部ページ noindex（法務4ページ・contact・認証・purchase 系）
- [x] フッター Instagram / note リンク有効化（Instagram: https://www.instagram.com/shingo_camera/ , note: https://note.com/shingo_camera ）
- [x] `/contact/` → `/support/` 誘導（meta refresh + JS + 明示リンク・noindex 維持）。公開ページで `/contact/` を正式窓口として案内しない

### 法務
- [x] 利用規約（全15条＋第9条の2）反映
- [x] プライバシーポリシー（全10項）反映
- [x] 特定商取引法に基づく表記（開示請求文面維持・価格は各商品ページ参照）反映
- [x] SUPPORT 本文反映
- [x] フッターからの法務導線（利用規約/プライバシー/特商法/お問い合わせ）
- [x] 商品購入前の法務導線（商品ページ購入導線付近に terms/commercial/privacy/support、STORE 購入操作付近に利用規約同意文＋リンク、法務全般はフッターから到達可能）
- [x] 外部サービス依存条項（第8条）・オフライン免責（第9条の2・第11条）
- [x] 不正利用検知時のログ確認・登録メールへの本人確認/注意喚起条項（第2条・プライバシー2）

### SUPPORT
- [x] ページ閲覧は未ログインでも可能
- [x] 問い合わせ送信はログイン必須（UI ゲート＋API `requireUser`）
- [x] request body の email を信用せず、認証済み JWT の email を正本にする
- [x] 管理者通知メール（問い合わせ者メール・種別・対象商品・件名・本文・内部 AUTH_USER_ID）
- [x] 利用者への受付完了メール（内部識別子を含めない・返信期限を約束しない・機密情報注意）
- [x] 管理者通知の成功を「受理」の基準とする（受理できていないのに受付済み表示にしない）
- [x] honeypot / server-side validation（種別 allowlist・本文長・空拒否・ヘッダインジェクション回避）
- [x] 内部エラー・Secret・stack trace を非露出
- [x] 既存 Resend 基盤を再利用（新規メールサービス未導入）。SUPPORT_NOTIFY_EMAIL は任意 override

### 商品・販売制御（M_PRODUCT を商品販売設定の正本に一本化）
- [x] 販売可否を `M_PRODUCT.PURCHASE_ENABLED` に一本化。旧 `SELLABLE_PRODUCT_CODES`（サーバー宣言的集合）を廃止、旧フロント `site-config.js` の `purchasable` フィールドも削除（販売可否の二重管理を解消）
- [x] 表示価格を `M_PRODUCT.DISPLAY_PRICE` に一本化。site-config の `amount` / `priceDisplay` を全商品から削除。公開価格表示（STORE 商品カード・STORE 合計・購入確認モーダル・SUN AND MOON 商品詳細ページ）はすべて同じ DB DISPLAY_PRICE を参照。DB 取得失敗時は古い静的価格へフォールバックせず「価格情報を取得できません」等の安全側表示
- [x] Stripe Price ID を `M_PRODUCT.STRIPE_PRICE_ID` に一本化。`resolvePriceId` の商品コード switch・`KNOWN_PRODUCT_CODES` 固定配列・env の商品別 `STRIPE_PRICE_*` を廃止。Checkout（precheck）も Webhook の Price→商品コード逆引き（`buildPriceIdToCodeMap`）も DB の STRIPE_PRICE_ID が唯一の正本
- [x] migration 0007（additive・DROP なし）で `PURCHASE_ENABLED` / `SALE_TYPE` / `DISPLAY_PRICE` / `BILLING_INTERVAL` / `STRIPE_PRICE_ID` を追加。UPDATE_DATE は既存仕様の JST ISO 8601（`strftime(...,'+9 hours')||'+09:00'`）で生成。実 Price ID は migration にハードコードせず、環境ごとの D1 へ別途設定
- [x] 表示順は既存 `SORT_NO` に一本化（DISPLAY_ORDER は追加しない＝列の重複を避ける）
- [x] Checkout（precheckMultiCheckout）は `STATUS=1` かつ `DEL_FLG=0` かつ `PURCHASE_ENABLED=1` かつ `SALE_TYPE='ONE_TIME'` かつ `STRIPE_PRICE_ID` 設定済みの商品のみ新規購入可能。いずれも Stripe Session 作成より前に判定
- [x] STRIPE_PRICE_ID が NULL/空（販売設定未完了）は Stripe API 呼び出し前に安全に拒否
- [x] `SALE_TYPE`: ONE_TIME=買い切り（現行 Checkout 対応）/ SUBSCRIPTION=サブスク。SUBSCRIPTION は現状 Stripe Session 作成前に `SALE_TYPE_NOT_SUPPORTED` で安全に拒否（将来対応）
- [x] SUBSCRIPTION は STORE / HOME でも購入不可（`purchaseEnabled===true && saleType==='ONE_TIME'` のみ購入 UI）。価格（¥x / 月 等）は表示可能だが購入操作は不可・準備中扱い
- [x] STATUS（マスタ有効性）と PURCHASE_ENABLED（販売受付）の責務を分離。entitlement（`isProductAvailable`）には PURCHASE_ENABLED / SALE_TYPE / STRIPE_PRICE_ID を混入させない
- [x] DISPLAY_PRICE を Stripe Session の金額として送らない。Session は line_items の price（Price ID）で作成。実課金額の正本は Stripe Price
- [x] Stripe Secret（STRIPE_SECRET_KEY）・Webhook Secret（STRIPE_WEBHOOK_SECRET）は従来どおり env/Cloudflare Secret 管理。DB に持つのは商品設定としての STRIPE_PRICE_ID のみ
- [x] `/api/products`・`/api/account/products` は productCode/purchaseEnabled/saleType/displayPrice/billingInterval のみ返し、STRIPE_PRICE_ID・Stripe Secret・内部 PRODUCT_ID は返さない
- [x] SUN AND MOON PLANNER は販売可能（PURCHASE_ENABLED=1・ONE_TIME・DISPLAY_PRICE=13000・既存購入フロー維持）
- [x] HANABI PLANNER / HANABI Google Earth 連携は STORE で「準備中」表示・選択不可・新規購入不可（PURCHASE_ENABLED=0）
- [x] 複数商品 Checkout に未発売が1つでも含まれれば注文全体を拒否（部分成功なし）
- [x] 既存 HANABI / EARTH 購入者の entitlement（利用権）には影響しない（PURCHASE_ENABLED=0・STRIPE_PRICE_ID 未設定でも利用継続）
- [x] 新しい ONE_TIME 商品追加に必要な作業（DB INSERT だけの完全ノーコードではない）: ①M_PRODUCT 登録 ②Stripe Price 作成 ③M_PRODUCT.STRIPE_PRICE_ID 設定 ④site-config 等へ商品説明/features/画像等の静的 UI 情報を追加 ⑤PURCHASE_ENABLED=1。ONE_TIME 商品の Checkout 販売制御ロジック自体は商品ごとのコード改修が不要（商品コード switch 追加なし）
- [x] Test/Live の STRIPE_PRICE_ID は環境ごとの D1（Local/Test D1・Production D1）に別々の Price ID を設定する方式。Local/Test D1 には Test Price、Production D1 には Live Price を設定し、DB が別なので環境ごとに独立管理できる。ただし人間が Production D1 へ Test Price を書き込むこと自体は可能なため「構造的に完全防止」ではなく、混在防止は Production 設定確認と E2E で担保する
- [x] Checkout 開始時に、その手続きで使う Stripe Price ID を `T_CHECKOUT_ATTEMPT_ITEM.STRIPE_PRICE_ID` へ snapshot 保存（migration 0006）
- [x] fulfill（Webhook/recovery）の Price→商品コード逆引きは attempt item の Price snapshot を正本にする。Session ID または operationId から attempt を特定し、開始時 snapshot で line item price を検証・解決する
- [x] Checkout 開始後に運用者が M_PRODUCT.STRIPE_PRICE_ID を変更しても、旧 Session（旧 Price）を snapshot から正常 fulfill できる（unknown price id による付与不能を防止）
- [x] fallback の限定: attempt を特定できた場合はその snapshot が正本。snapshot の欠損・空 Price・重複割当は安全側エラー（現在の M_PRODUCT へ fallback しない）。現在 M_PRODUCT 逆引きへの fallback は「SID/operationId のどちらでも attempt を特定できない限定互換経路」のみ
- [x] STRIPE_PRICE_ID の一意性を DB で担保（部分 UNIQUE INDEX `UX_PRODUCT_STRIPE_PRICE_ID`。NULL/空は複数許可、非空 Price ID は商品間で一意）。Checkout precheck 側にも同一カート内 Price 重複の安全網を維持（決済後 Webhook で初めて気付く事態を回避）
- [x] M_PRODUCT 販売列の CHECK 制約（PURCHASE_ENABLED IN(0,1) / SALE_TYPE IN('ONE_TIME','SUBSCRIPTION') / DISPLAY_PRICE IS NULL OR >=0 / BILLING_INTERVAL IS NULL OR IN('MONTH','YEAR')）で不正値を DB で拒否
- [x] 商品別 STRIPE_PRICE_* env を完全廃止（実コード・.dev.vars.example・README・Spec メモから排除。残る Secret は STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET のみ）
- [x] SUN AND MOON 商品ページに動作環境・利用条件（Web アプリ・PC/スマホ・要オンライン・オフライン非保証・KMZ/Google Earth 連携・外部ソフト条件は提供元依存で将来変更あり）
- [x] Google Earth 等の将来的な提供変更・終了に依存しない免責表現（永続提供を保証しない）

### 商品購入依存関係（M_PRODUCT_DEPENDENCY へ DB 化）
- [x] 商品購入依存関係を DB（`M_PRODUCT_DEPENDENCY` / migration 0008）へ移行。旧コード固定の `PRODUCT_DEPENDENCIES` を廃止し二重管理を解消。依存判定の正本は DB
- [x] migration 0008 は additive（CREATE TABLE IF NOT EXISTS / INDEX / seed のみ・0007 は変更しない）。既存データ非破壊。`PRAGMA foreign_keys = ON` を明示。seed は `INSERT OR IGNORE`（再適用安全）。UPDATE_DATE/CREATE_DATE は JST ISO 8601
- [x] 依存は DEPENDENCY_GROUP で表現。グループ内=ANY_OF（いずれか充足）、グループ間=ALL_OF（すべて充足）
- [x] 充足方法を SATISFY_MODE で表現（CHECK 制約: ENTITLEMENT_ONLY / ENTITLEMENT_OR_CART のみ）。ENTITLEMENT_OR_CART=有効 entitlement 所有または同一注文に前提商品を含めば充足 / ENTITLEMENT_ONLY=Checkout 前から有効 entitlement を持つ場合のみ充足（同一注文では充足しない）
- [x] 同一 PRODUCT_CODE + DEPENDENCY_GROUP 内は同一 SATISFY_MODE 必須（ANY_OF の評価単位）。DB 列 CHECK＋判定時の一貫性検証の二重防御。混在は内部設定エラー（DependencyConfigError）で安全側に拒否
- [x] EARTH: HANABI_GOOGLE_EARTH → HANABI / ENTITLEMENT_OR_CART（現行の「HANABI 既所有」も「HANABI+EARTH 同時カート」も許す挙動を維持・初期データ投入済み）
- [x] 将来 3D_PREVIEW: 同一グループに HANABI と SUN_AND_MOON を ENTITLEMENT_ONLY で登録＝「HANABI OR SUN_AND_MOON を既に所有」した場合のみ購入可（同一カートでは充足しない）。今回は商品未登録のためデータ投入しない（DB 設計とテスト用仮商品で検証済み）
- [x] 「所有」の正本は有効な T_USER_PRODUCT entitlement（STATUS=1・期間内・DEL_FLG=0）。購入履歴（T_PURCHASE）・注文履歴・Stripe 履歴・GRANT_TYPE は依存判定に使わない。Admin 直接付与・note 移行・テスター付与も有効 entitlement なら所有扱い（テストで「購入履歴なし・Admin 直接付与 HANABI → EARTH / 3D_PREVIEW 購入可能」を検証）
- [x] 循環依存の検出: M_PRODUCT_DEPENDENCY 全体（STATUS=1 AND DEL_FLG=0 のみ）を DFS で検査し、A→B→A / A→B→C→A 等の循環を検出。循環時は A+B 同時カート等でも抜けられず内部設定エラーで拒否。自己依存は DB CHECK で登録不可
- [x] 依存設定の不正（循環・SATISFY_MODE 混在・未知 SATISFY_MODE）は内部設定エラー（DependencyConfigError → INTERNAL_ERROR(500)）。SQL・テーブル名・内部 ID・stack trace をブラウザへ露出せず、詳細はサーバーログのみ
- [x] DB に依存定義が無い商品は依存なし（通過）。無効な依存定義（STATUS=0/DEL_FLG=1）は判定・循環検査とも使わない。存在しない/無効な前提商品は充足せず購入不可（安全側）
- [x] 依存チェックは Checkout 前（precheckMultiCheckout 内）に実行。依存関係・循環検出は新規購入可否のみに影響し、既存 entitlement の利用可否（isProductAvailable）には非混入（EARTH を直接付与されたユーザーは HANABI 未所有でも EARTH を利用可能）

### セッション観測・不正検知（ログインしっぱなしでも観測できる状態にする）
- [x] SESSION_ID_HASH 記録: 検証済み Supabase JWT の session_id クレームを requireUser で取得し UUID 形式を確認。サーバー鍵（SESSION_ID_HASH_SECRET）で HMAC-SHA256 して T_ACCESS_LOG.SESSION_ID_HASH に保存（生 session_id は保存しない）。同一 session→同一 hash、別 session→別 hash。鍵未設定・session_id 欠損なら NULL（記録は継続）。既存列を使い migration は追加しない
- [x] app-start（ACCESS_TYPE=0）/ entitlement-check（ACCESS_TYPE=1）のアクセスログにも SESSION_ID_HASH を記録（従来 NULL 固定を解除）
- [x] PERIODIC_CHECK heartbeat: POST /api/apps/sun-and-moon/heartbeat を追加。ログイン必須・有効 JWT 必須・authUserId/session_id は JWT 正本・DEVICE_ID は既存 X-Device-Id・IP/国/地域/市/UA は既存 Cloudflare request 情報を再利用・GPS 非取得。ACCESS_TYPE=2 で既存 ACCESS_LOG_INTERVAL_MIN（60分）抑制付き append 記録（LAST_SEEN 型集約は導入せず・DB 変更なし）。entitlement/購入権限は変更しない・失敗してもアプリ本体利用を妨げない
- [x] ログインしっぱなしでも利用中の地点/session を低頻度観測: フロント（auth-integration.js）はアプリ表示中(visible)のみ60分間隔で heartbeat 送信。非表示・離脱中は停止（バックグラウンド無限送信なし・閉じている間の追跡なし）
- [x] 強制再ログインに依存しない不正検知観測: セッション期限・定期再ログインは導入せず、通常利用中の観測で多地点利用検知を成立させる。現時点では強制期限を導入しない
- [x] 既存不正判定は無変更: MANY_DEVICES / MANY_REGIONS / COUNTRY_CHANGE / warning Cron / cooldown・NOTIFIED_DATE / 管理者メール / 自動BANなし をそのまま維持。IP 単独で warning する処理は追加しない。SESSION_ID_HASH 記録後も「複数 session だから即 warning」という新判定は追加しない（まずログ蓄積のみ）


- [x] STORE 購入操作付近に利用規約同意文を常設（「購入手続きを進めることで、利用規約に同意したものとします。」／「利用規約」のみ /terms/ へリンク）
- [x] 新規購入時の購入確認モーダルは簡潔版（購入する商品名・合計金額（税込）・返品/キャンセルの短い注意・「Stripeで購入手続きへ」「戻る」の2ボタン）。複数商品選択時も各商品名と合計税込を表示
- [x] 購入確認モーダルからは利用規約・特商法・プライバシー・SUPPORT のリンク、および支払方法・支払時期・提供時期の詳細説明を除去（法務ページは既存フッターおよび購入操作付近の同意文から到達可能）
- [x] 既存購入手続きが残っている場合の破棄確認は別目的として維持（順序: 購入内容確認 → 必要な場合のみ破棄確認 → Stripe）。「購入手続きを再開」経路では購入確認モーダルを表示しない
- [x] 確認で承認したときのみ既存 startMultiCheckout を呼ぶ（キャンセル時は checkout API 未呼び出し）
- [x] Stripe Session 作成: mode=payment / customer_email 固定（認証メール）/ idempotencyKey / metadata・client_reference_id / success_url（{CHECKOUT_SESSION_ID}）/ cancel_url / payment_method_types 非固定（Dynamic Payment Methods）
- [x] checkout lifecycle（operationId/attempt/idempotency/Session recovery/restart/cancel/Webhook/fulfill/rollback/T_ORDER/T_PURCHASE/T_USER_PRODUCT/購入者メール固定/Stripe Price を課金額の正本とする設計）は無変更

### 不要物・セキュリティ・テスト
- [x] hello.js（疎通確認コード）撤去・参照残骸ゼロ
- [x] Secret・実個人メールアドレスのハードコードなし
- [x] typecheck 0 エラー
- [x] npm test 236/236 全 pass（No.198 STALE TEST をテスト側で現行仕様に修正済み）

---

## [Production作業待ち] 本番環境／Live でしか確定できない

- [ ] Cloudflare Production へ deploy（commit / push は [帰宅後作業] に記載）
- [ ] Production 環境変数 / Secret 最終確認（MAIL_API_KEY / ADMIN_AUTH_USER_ID / SUPPORT_NOTIFY_EMAIL[任意] / STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / APP_BASE_URL / SUPABASE_URL 等。商品別 STRIPE_PRICE_* env は廃止済み＝設定不要）
- [ ] SESSION_ID_HASH_SECRET を Production Secret として設定（**Production 必須設定**。未設定でもアプリは fail-open で動作しログ記録は継続するが、SESSION_ID_HASH が NULL になり session 識別＝アカウント共有検知の補助機能が実質無効になる）
  - [ ] Local/Test と Production で別の Secret を使用する（環境間でハッシュを突き合わせられないようにする）
  - [ ] 実値をソース・README・ZIP・Git/toml へ含めない（Cloudflare Secret / .dev.vars のみ。十分に長いランダム値。例: openssl rand -hex 32）
  - [ ] Production で app-start / entitlement-check / heartbeat 実行後、T_ACCESS_LOG.SESSION_ID_HASH が NULL ではなく "v1:" 形式で記録されることを確認
- [ ] Stripe Live: SUN_AND_MOON の Price（¥13,000）を作成し、Production D1 の `M_PRODUCT.STRIPE_PRICE_ID` へ設定。HANABI/EARTH は PURCHASE_ENABLED=0 のため未設定でも新規販売停止
- [ ] Stripe Live: Webhook endpoint 登録・Webhook Secret 登録
- [ ] Stripe Dashboard: Link OFF / カード ON / Apple Pay 表示可（Dynamic Payment Methods）
- [ ] Production D1 migration 適用状態確認（0001〜0008。0007=商品販売専用列、0008=商品購入依存関係テーブル）
- [ ] Production M_PRODUCT_DEPENDENCY 初期データ確認（HANABI_GOOGLE_EARTH → HANABI が投入されていること）
- [ ] Production D1 テストデータ／不要データ確認・M_PRODUCT 初期データ確認
- [ ] Production M_PRODUCT 新列（PURCHASE_ENABLED/SALE_TYPE/DISPLAY_PRICE/BILLING_INTERVAL/STRIPE_PRICE_ID）の実データ確認
- [ ] Production 実データ確認: SUN_AND_MOON の DISPLAY_PRICE=13000・PURCHASE_ENABLED=1・SALE_TYPE=ONE_TIME・STRIPE_PRICE_ID=Live Price
- [ ] Production 実データ確認: HANABI / HANABI_GOOGLE_EARTH の PURCHASE_ENABLED=0（新規販売停止）
- [ ] Test/Live の STRIPE_PRICE_ID 混在なし確認（Local/Test D1 には Test Price、Production D1 には Live Price。Test Price を Production で使う／Live Price を Local で使う混在がないこと）
- [ ] Price 変更後の旧 Session 安全 fulfill を Test 環境で E2E 確認（Test Session 作成 → M_PRODUCT.STRIPE_PRICE_ID を別 Test Price へ変更 → 旧 Session を決済 → attempt snapshot 経由で正常 fulfill されること）。※Production で価格変更する必要はなく Test 環境で確認可能
- [ ] Stripe Live Price（実課金額）と DISPLAY_PRICE（表示価格 13,000 円）の一致確認（乖離検知は既存になし＝下記「任意改善」参照。当面は E2E で目視確認）
- [ ] SUPPORT 実メール送信 E2E（管理者通知＋利用者受付メールの実受信・開示請求カテゴリ動作）
- [ ] SUN AND MOON Live 購入 E2E（¥13,000 実決済・Webhook Price→商品コード逆引きが DB STRIPE_PRICE_ID で成立すること）
- [ ] Stripe Webhook → entitlement 反映確認（T_ORDER/T_PURCHASE/T_USER_PRODUCT）
- [ ] MY PAGE 購入済み表示確認
- [ ] Production 公開ページ最終スモーク（法務4ページ・SUPPORT・商品ページ・STORE・robots/sitemap・全画面の価格が DB DISPLAY_PRICE で一致）
- [ ] スマホ実機確認（SUN AND MOON 本体スマホトグル・STORE 準備中表示・購入確認モーダル）
- [ ] STORE 販売表示の安全側動作確認（/api/products 取得失敗時に購入可能表示にならず準備中になること）

---

## [帰宅後作業] Git／リポジトリ運用／Spec 反映（Production 前後で実施）

- [ ] 最終成果物を Git 正本へ反映（commit / push）
- [ ] source リポジトリ（`shingo-camera-platform`）の Private 化
- [ ] spec リポジトリ（`shingo-camera-platform-spec`）の Private 化
- [ ] spec リポジトリへ今回の DB／商品販売設計を反映（下記「Spec 追従残件」参照）
- [ ] spec `operation/RELEASE_CHECKLIST.md` の最終更新（本ファイルの最新状態を反映）

### Spec 追従残件（spec リポジトリは本作業ツリーに含まれないため、帰宅後に反映）
- [ ] `database/DDL.sql`: M_PRODUCT に PURCHASE_ENABLED / SALE_TYPE / DISPLAY_PRICE / BILLING_INTERVAL / STRIPE_PRICE_ID を追記（migration 0007 と一致させる。DISPLAY_ORDER は追加しない＝表示順は SORT_NO）
- [ ] `database/TABLES.md`: M_PRODUCT の列定義・各列の責務（STATUS=マスタ有効性 / PURCHASE_ENABLED=販売受付 / SALE_TYPE / DISPLAY_PRICE=表示専用 / BILLING_INTERVAL / STRIPE_PRICE_ID=Checkout・Webhook 逆引きの正本・公開しない / 表示順=SORT_NO）を追記
- [ ] `api/PRODUCT_API.md`: `/api/products` が販売情報（purchaseEnabled/saleType/displayPrice/billingInterval）を返すこと、Stripe Price ID・Secret・内部 PRODUCT_ID を返さないことを追記
- [ ] `api/PURCHASE_API.md`: 新規販売可否の正本が M_PRODUCT.PURCHASE_ENABLED であること、SUBSCRIPTION は現状 `SALE_TYPE_NOT_SUPPORTED` で拒否することを追記
- [ ] 販売可否の正本が SELLABLE_PRODUCT_CODES から DB へ移行した旨を spec 側の該当記述へ反映（実装リポジトリ内の追従メモは `WORK-011_SPEC_UPDATES.md` に集約）

---

## [コンテンツ待ち] 素材待ち

- [ ] SUN AND MOON note 記事の完成（使い方記事。現在作成中）
- [ ] note 記事 URL 確定
- [ ] note 記事 URL 確定後、`site-config.js` 等（SUPPORT・商品ページ）への該当リンク反映（現在は「準備中」表記）
  - 状態: **発売可否は運営判断**。これらは技術的に決定できる事項ではなく、運営者の販売判断に依存する。BLOCKER・非BLOCKER のどちらにも固定しない
- [ ] 商品ページ画像・スクリーンショット差し替え（現在は「準備中」プレースホルダ）
  - 状態: **法的・技術的 BLOCKER ではない。発売時に準備中表示を許容するかは運営判断**

---

## [任意改善] 発売 BLOCKER ではない

- [ ] 表示価格（DB DISPLAY_PRICE）と Stripe Price（実課金額）の自動乖離検知。現在は既存になし（stripe_fulfill.ts の検証は Stripe 内部整合性=unit_amount 合計==amount_total のみ）。当面は Production E2E での目視確認で代替。将来は fulfill 時などに DISPLAY_PRICE と unit_amount を突き合わせる監査を追加可能（EXPECTED_AMOUNT 予約列を活用）
- [ ] 準備中2商品（HANABI/EARTH）の STORE 価格表示の要否（現在は DB DISPLAY_PRICE を表示。非表示にするかは運用判断）
- [ ] og:image / Twitter Card（SNS 共有画像。基礎 OGP は実装済みのため発売後対応可）
- [ ] `/contact/` の恒久的な扱い（現在は /support/ 誘導ページとして残置。将来的にページ削除するか誘導維持かは運用判断）
- [ ] SUPPORT 問い合わせ履歴の DB 保存（現在はメール通知のみ。監査証跡が必要なら将来 DB 設計追加。今回のスコープ外）

## [残件/改善] 不正検知・セッション観測（発売 BLOCKER ではない）

今回、SESSION_ID_HASH 記録と PERIODIC_CHECK heartbeat を追加し「ログインしっぱなしでも利用中の地点/session を低頻度観測できる状態」にした。以下は将来の改善候補。

- [ ] LOGIN_FAILURE warning は現在未稼働: T_LOGIN_LOG / writeLoginLog / LOGIN_FAILURE 判定は実装済みだが、writeLoginLog が実際のログイン処理へ接続されていない（ログイン成功/失敗は Supabase Auth 側で発生し Worker を経由しないため）。今回のセッション観測とは別課題。認証フローを Worker 経由へ作り替える大規模変更は行わない。将来、失敗ログの捕捉方式を別途検討する
- [ ] Admin から対象ユーザーへ本人確認メールを送る運用導線: 現在は「検知→管理者通知→人間確認」まで実装済み。本人向け自動確認メールは未実装（今回も自動送信は追加しない）。将来、Admin 画面から対象ユーザーの登録メールへ本人確認・注意喚起を送る導線を追加する候補
- [ ] session 単位の Admin 表示: SESSION_ID_HASH を記録できるようになったため、将来 Admin のアクセスログ表示に session 列を足し「同一アカウントの別 session からの利用」を人間が確認しやすくする
- [ ] access log 保持期間 / 削除運用: 現在は無期限。生アクセス履歴 / セキュリティ warning / 管理者対応履歴で保持期間を分ける運用ルールを策定する（プライバシーポリシー7条「不正利用防止その他運営上必要な範囲で保存」と整合。本文修正は不要）
- [ ] 将来必要なら session ベース warning 条件検討: 実ログ（SESSION_ID_HASH の蓄積）を見て、必要なら「同一時間帯に別 session から複数地点」等の session ベース warning 条件を追加する。今回は「複数 session だから即 warning」という新判定は追加しない（まずログを正しく蓄積する）
- [ ] セッション期限: 現時点では強制期限を導入しない。不正検知は通常利用中の session 観測で成立させる（撮影現場での頻繁なログイン要求を避けるため。SUN AND MOON は外出先利用が前提）


---

## [次工程 / 設計改善] 将来の商品追加・依存拡張

商品購入依存関係は M_PRODUCT_DEPENDENCY（migration 0008）へ DB 化済み。以下は将来の拡張。

- [ ] 3D_PREVIEW 商品を追加する際は、商品追加 migration で M_PRODUCT へ登録し、M_PRODUCT_DEPENDENCY へ
      3D_PREVIEW → HANABI と 3D_PREVIEW → SUN_AND_MOON を同一 DEPENDENCY_GROUP・SATISFY_MODE='ENTITLEMENT_ONLY'
      （ANY_OF・既所有必須）で登録する（どちらも所有しないユーザーには 3D_PREVIEW を購入させない・同一カートでは充足しない）。
      依存ロジック自体の改修は不要
- [ ] 依存関係の Admin 編集 UI（現状は migration / D1 直接操作。運用頻度が上がれば検討。今回スコープ外）

## [次工程 / サブスク実装前] 購入済み表示と entitlement の再整理

現在の買い切り（ONE_TIME）商品には影響しないが、期限付き / サブスク商品を導入する前に対応が必要な残件。
※今回の依存 DB 化とは別責務のため実装は変更していない。

- [ ] STORE の「購入済み」表示が granted（付与された事実）を見ており available（現在有効な entitlement）を見ていない。
      期限付き / サブスク商品では期限切れでも「購入済み」表示になり得るため、granted と available を分けて再整理する
- [ ] 期限切れ subscription の再契約導線（expired 状態からの再購入フロー）
- [ ] expired entitlement を「購入済み」として購入不可にしないこと（再購入を妨げない）。現在の買い切り商品には影響させない

---

## 発売可否判定

**コード上は発売可能**。この実装リポジトリのコード・ローカル検証で確定できる発売前 BLOCKER は 0 件
（typecheck 0 / npm test 236 全 pass / 総監査クリア）。

ただし最終的な販売開始条件は、次のすべてが満たされることとする。

- Production 作業完了（deploy・環境変数/Secret 確認・D1 migration 状態確認 等）
- Stripe Live E2E 完了（Live Price 確認・Live Webhook・実決済 → entitlement 反映）
- SUPPORT 実メール E2E 完了（管理者通知・利用者受付メールの実受信）
- Production 最終スモーク完了（公開ページ・法務・SUPPORT・商品・STORE・スマホ実機）
- note 記事 / 商品画像等の [コンテンツ待ち] 項目について、運営者が発売可否を判断

**最終判定: Production 作業完了後、かつコンテンツ待ち項目について運営判断が完了すれば発売可能。**
