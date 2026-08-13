# shingo-camera Platform 共通基盤

shingo-camera Platform（SUN AND MOON / HANABI / 将来アプリ）の共通認証・購入・
商品権限・管理基盤のコードリポジトリ。設計の正本は別リポジトリ
`shingo-camera-platform-spec` にある。

発売前の残件・完了状況は `LAUNCH_CHECKLIST.md`（この実装リポジトリでの発売状態の正本）で管理する。

本リポジトリは **WORK-001〜003** の成果物。現時点で以下を含む。

- 共通レスポンス骨格 / 共通エラーハンドラ / `GET /api/health`（WORK-001）
- D1 スキーマ（migration・9テーブル）/ DB接続共通関数（WORK-002）
- Supabase Auth 認証: 認証画面（Static Assets）、JWKS+jose による JWT 検証
  （issuer/audience/role/anonymous 検証）、M_USER 同期の最小骨格、`/api/config`（WORK-003）

Stripe / 商品権限 / 管理画面 / note移行 等は後続 WORK で追加する。

## 技術構成

| 項目 | 採用 |
|---|---|
| ランタイム | Cloudflare Workers |
| 言語 | TypeScript |
| デプロイ | Wrangler (`wrangler deploy`) |
| 追加フレームワーク | なし（依存最小） |

追加フレームワーク（Hono 等）は現時点で導入しない。API が増える後続 WORK で
要否を判断する。

## 環境方針

環境は **Local** と **Production（非公開）** の 2 つのみ。専用 Staging は作らない。
Production を開発・結合テストに使用し、完成後にそのまま公開する。
（設計根拠: ADR-011）

非公開の維持は、`workers.dev` の標準ドメインで到達可能にしつつ、公開用の
カスタムドメインを紐付けないことで行う。公開時にカスタムドメインを追加する。

## ディレクトリ構成

```text
shingo-camera-platform/
├─ src/
│  ├─ index.ts              エントリ（fetch ハンドラ + 最小ルーティング）
│  ├─ routes/
│  │  └─ health.ts          GET /api/health
│  └─ shared/
│     ├─ response.ts        共通JSONレスポンス骨格
│     ├─ errors.ts          共通エラーハンドラ骨格
│     └─ db.ts              DB接続共通関数（getDb）
├─ migrations/
│  └─ 0001_initial_schema.sql  承認済みDDL（9テーブル・初期データ）
├─ wrangler.toml
├─ tsconfig.json
├─ package.json
├─ .gitignore
├─ .dev.vars.example        環境変数・Secrets の例（実値なし）
└─ README.md
```

## セットアップ

```bash
npm install
```

## 型チェック

```bash
npm run typecheck
```

## Local 起動

```bash
# 初回のみ Cloudflare アカウントへログイン
npx wrangler login

# ローカル開発サーバ起動
npm run dev
```

起動後、別ターミナルで疎通確認:

```bash
curl http://localhost:8787/api/health
# => {"result":"OK","data":{"service":"shingo-camera-platform","environment":"local"}}
```

`environment` は環境変数 `APP_ENV` で切り替わる。Local は `.dev.vars` の
`APP_ENV=local`、Production は `wrangler.toml` の `[vars] APP_ENV="production"`
が使われる。`APP_ENV` は秘密情報ではない。

## Production（非公開）へのデプロイ

```bash
npm run deploy
```

デプロイ後に表示される `*.workers.dev` の URL で疎通確認:

```bash
curl https://<your-worker-subdomain>.workers.dev/api/health
# => 200, {"result":"OK","data":{"service":"shingo-camera-platform","environment":"production"}}
```

## 環境変数・Secrets

### 非秘密の環境変数

- `APP_ENV`: 実行環境識別子（`local` / `production`）。`/api/health` の
  `environment` に使う。Production は `wrangler.toml` の `[vars]` で `production`、
  Local は `.dev.vars` の `APP_ENV=local` が優先される。
- `SUPABASE_URL` / `SUPABASE_ANON_KEY`: フロント配布可（/api/config 経由）。
  ただし Git へ実値を保存しない。Local は `.dev.vars`、Production は Cloudflare
  Dashboard の通常環境変数として登録する。`wrangler.toml` には書かない。
- `ADMIN_AUTH_USER_ID`: 秘密情報ではない。Production は Dashboard の通常環境変数
  として管理してよい。Git へ実値を書かない。

### Production 変数の保持（keep_vars）

`wrangler.toml` に `keep_vars = true` を設定している。

- 目的: Dashboard で管理している Production の通常環境変数（`SUPABASE_URL` /
  `SUPABASE_ANON_KEY` / `ADMIN_AUTH_USER_ID` 等）を、`wrangler deploy` 時に
  削除・上書きしないため。
- 背景: wrangler は既定で `[vars]` を宣言的に同期し、toml に無い変数を deploy が
  消す。`keep_vars = true` により Dashboard 設定が保持される。
- 運用: 通常の `npm run deploy` でそのまま保持される（deploy コマンドへ毎回
  `--keep-vars` を書く必要はない）。手動 deploy でも保持される。
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` は公開可の値のため Secret 化は必須ではないが、
  Dashboard の通常環境変数として管理し、deploy で消えないことを keep_vars で担保する。

### 秘密情報

Local: `.dev.vars`（`.dev.vars.example` をコピーして実値を記入。Git 除外）。
Production: `wrangler secret put <KEY>` で登録。コードにも Git にも保存しない。
Secret は deploy では消えない（keep_vars とは別管理）。

秘密情報キー一覧（SECURITY.md 2、フロントへ絶対に渡さない）:

```text
SUPABASE_SERVICE_ROLE_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
MAIL_API_KEY
```

## 共通レスポンス形式

設計根拠: `api/API.md` 4「共通レスポンス」。

成功:

```json
{ "result": "OK", "data": { "...": "..." } }
```

業務エラー:

```json
{ "result": "NG", "error": { "code": "ERROR_CODE", "message": "..." } }
```

入力エラー（フィールド別メッセージを添える場合）:

```json
{ "result": "NG", "error": { "code": "VALIDATION_ERROR", "message": "...", "fields": { "email": "..." } } }
```

利用者向け `message` には内部詳細を含めない。内部詳細は Cloudflare ログへ出力する。

## D1 データベース（WORK-002）

業務データは Cloudflare D1（SQLite互換）で管理する。スキーマの正本は
設計リポジトリ `database/DDL.sql`。本リポジトリの
`migrations/0001_initial_schema.sql` はその承認済みDDLをそのまま取り込んだもの。

含まれるもの: 9テーブル（M_USER / M_PRODUCT / M_SYSTEM_SETTING /
T_PURCHASE / T_USER_PRODUCT / T_NOTE_PURCHASE / T_LOGIN_LOG /
T_ACCESS_LOG / T_WARNING）、初期商品3件、M_SYSTEM_SETTING 初期値7件、
外部キー・一意制約・CHECK制約・インデックス。

### 1. D1（作成済み）

D1 database_id は wrangler.toml へ設定済み。
新規環境を作り直す場合のみ、`d1 create` で発行された ID へ更新する。

```bash
# 新規環境を作り直す場合のみ
npx wrangler d1 create shingo-camera-platform
# 表示された database_id を wrangler.toml の database_id へ設定する
```

### 2. migration を適用する

```bash
# Local（wrangler dev 用のローカル D1）
npx wrangler d1 migrations apply shingo-camera-platform --local

# Production（非公開）
npx wrangler d1 migrations apply shingo-camera-platform --remote
```

### 3. 適用結果を確認する

```bash
# テーブル一覧（9件）
npx wrangler d1 execute shingo-camera-platform --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"

# 初期商品（3件）
npx wrangler d1 execute shingo-camera-platform --local \
  --command "SELECT PRODUCT_ID, PRODUCT_CODE FROM M_PRODUCT ORDER BY PRODUCT_ID;"

# 初期設定（7件）
npx wrangler d1 execute shingo-camera-platform --local \
  --command "SELECT SETTING_KEY FROM M_SYSTEM_SETTING ORDER BY SETTING_KEY;"
```

Production 側を確認する場合は `--local` を `--remote` に置き換える。

### 外部キー強制について

`0001_initial_schema.sql` 冒頭に `PRAGMA foreign_keys = ON;` を含む（正本DDL準拠）。
D1 では実行コンテキストにより PRAGMA の効き方が異なる場合があるため、
実 D1 適用後に、無効な外部キーを含む INSERT が拒否されるかを確認すること。

### コードからの利用

`src/shared/db.ts` の `getDb(env)` で D1 を取得する。SQL は必ず
`db.prepare(sql).bind(...)` の Prepared Statement を使い、複数テーブル同時更新は
`db.batch(...)` を使う（後続 WORK）。

## 認証（WORK-003）

Supabase Auth を用いた共通アカウント認証。認証操作（登録・ログイン・ログアウト・
再設定）はブラウザの Supabase JS が担当し、Worker は JWT 検証・M_USER 同期を担う。

### 構成

```text
public/
├─ index.html               トップ（導線）
├─ login/index.html         ログイン
├─ signup/index.html        新規登録
├─ forgot-password/index.html  再設定メール送信
├─ reset-password/index.html   新パスワード登録
└─ assets/
   ├─ common.css / auth.css
   ├─ auth.js               DEVICE_ID・Supabase初期化・各画面ロジック
   └─ vendor/supabase.js    @supabase/supabase-js UMD 固定版（同梱）

src/
├─ routes/config.ts         GET /api/config（フロント初期化用の公開設定）
├─ routes/account.ts        POST /api/account/sync（M_USER 同期・最小骨格）
└─ shared/
   ├─ auth.ts               requireUser（JWKS + jose によるJWT検証）
   ├─ device.ts             getDeviceId（X-Device-Id）
   └─ datetime.ts           nowIso
```

### JWT 署名方式の前提

Supabase プロジェクトは **非対称署名鍵（RS256 / ES256 等）** を使用し、JWKS で
検証可能であること。Legacy の共通 secret（HS256）は前提にしない。

### JWKS / issuer / audience

- JWKS URL: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
- issuer 検証: `${SUPABASE_URL}/auth/v1` と一致することを検証
- 有効期限: `jwtVerify` が exp / nbf を検証
- audience: `authenticated` を必須として検証する
- role/anonymous: `payload.role === "authenticated"` かつ `payload.is_anonymous !== true`
  を確認し、不一致は 401
- 検証済み `sub` のみを AUTH_USER_ID として使用（本文の値は信用しない）
- 不正・失効・改竄・issuer不一致・JWKS取得失敗は 401。完全な JWT はログ出力しない

### ルーティング（/api と静的Assets）

```text
/api/*    → Worker（run_worker_first = ["/api/*"]）
それ以外  → Workers Static Assets（public/）
```

`html_handling = "auto-trailing-slash"` により `/login` は `/login/` へ正規化され
`public/login/index.html` を返す。`not_found_handling = "none"` のため、存在しない
通常画面は Static Assets 側の 404（SPA フォールバックなし）。`/api/*` の 404 は
Worker の共通 JSON（NOT_FOUND）を返し、HTML へフォールバックしない。

### 環境変数

フロントへ露出してよい（/api/config 経由で配布）:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
```

Worker Secret として登録（フロントへ絶対に渡さない、後続 WORK で使用）:

```text
SUPABASE_SERVICE_ROLE_KEY
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` の設定先（wrangler.toml へは書かない）:

- Local: `.dev.vars` に記入（`.dev.vars.example` をコピー。Git 除外）
- Production: Cloudflare 側の環境変数として登録

```bash
# Production へ登録する例（プレーンな環境変数）
npx wrangler deploy   # デプロイ後、または以下で個別設定
# ダッシュボード: Workers & Pages > 対象Worker > Settings > Variables and Secrets
# もしくは wrangler の secret/vars 機能で登録する
```

実値は Git へコミットしない（`wrangler.toml` にも書かない）。

### Redirect URL（Supabase 管理画面で設定）

- メール認証後の戻り先: `${ORIGIN}/login/`
- パスワード再設定リンクの戻り先: `${ORIGIN}/reset-password/`

`${ORIGIN}` は Production Worker の URL、ローカルは `http://127.0.0.1:8787`。

### Supabase 管理画面で設定する項目

1. プロジェクト作成、JWT 署名を非対称鍵（RS256 等）に設定
2. Authentication > URL Configuration に上記 Redirect URL を許可リスト登録
3. Email 認証を有効化（確認メール送信）
4. `SUPABASE_URL` / `SUPABASE_ANON_KEY` を取得し、Local は `.dev.vars`、
   Production は Cloudflare の環境変数として登録（wrangler.toml には書かない）

### Local / Production 検証手順

```bash
# Local
npm run dev
# ブラウザ/curl で以下を確認
#   /login /login/ /signup /signup/ /forgot-password /reset-password
#   /api/health /api/config /api/unknown
# 認証画面が表示され、実際に登録→確認メール→ログイン→ログアウト→再設定が通ること

# Production
npm run deploy
# 同様に Production URL で確認
```

## 共通サーバー関数（WORK-004）

全 API で利用する共通処理。設計根拠: api/API.md 12, SECURITY.md, REVIEW_RULE.md。

| 関数 | 配置 | 責務 |
|---|---|---|
| `requireUser(req, env)` | shared/auth.ts | JWT 検証（署名/issuer/audience/role/anonymous）→ AuthContext |
| `requireAdmin(req, env)` | shared/admin.ts | requireUser 後、AUTH_USER_ID === ADMIN_AUTH_USER_ID を判定（403/未設定拒否） |
| `jsonOk/jsonError` | shared/response.ts | 共通レスポンス（result OK/NG、VALIDATION_ERROR+fields） |
| `validateJson(req, schema)` | shared/validate.ts | Content-Type/JSON/必須/型/文字数/UUID/コード値/想定外項目 検証 |
| `getDeviceId/requireDeviceId` | shared/device.ts | X-Device-Id 取得（任意/必須） |
| `nowIso()` | shared/datetime.ts | JST +09:00 ISO 8601 |
| `getSystemSetting/AsInt` | shared/settings.ts | M_SYSTEM_SETTING 取得（不在は null / fallback） |
| `writeLoginLog/writeAccessLog` | shared/logs.ts | T_LOGIN_LOG / T_ACCESS_LOG 記録 |
| `getDb(env)` | shared/db.ts | D1 取得 |

- 管理者判定は AUTH_USER_ID のみ（メールでは判定しない）。`ADMIN_AUTH_USER_ID` は Secret。
- ログは日時 `nowIso()`、SQL は Prepared Statement + bind。OS/ブラウザ等は推測生成せず取得不能値は NULL。
- 入力検証は追加ライブラリ不使用（Zod 等なし）。想定外項目は黙って受け入れない。

## アカウント・商品権限 API（WORK-005）

| Method | Path | 認証 | 主なテーブル | エラー |
|---|---|---|---|---|
| POST | /api/account/sync | 必須 | M_USER | UNAUTHORIZED |
| GET | /api/account/me | 必須 | M_USER, M_PRODUCT, T_USER_PRODUCT | USER_SUSPENDED(403) |
| GET | /api/account/products | 必須 | M_PRODUCT, T_USER_PRODUCT | — |
| POST | /api/account/password-changed | 必須 | M_USER | USER_NOT_FOUND(404) |
| GET | /api/products | 任意 | M_PRODUCT | — |
| GET | /api/products/{code} | 任意 | M_PRODUCT | PRODUCT_NOT_FOUND(404) |
| GET | /api/entitlements/{code} | 必須 | M_USER, M_PRODUCT, T_USER_PRODUCT, T_ACCESS_LOG | USER_SUSPENDED / PRODUCT_NOT_FOUND / PRODUCT_NOT_GRANTED(403) |

- 同期ロジックは shared/account.ts の `syncMUser` に集約（sync/me 共用）。
- `requireProduct(request, env, code)` は shared/entitlement.ts。各アプリ計算APIから権限確認に使う。
- available 判定は Date 変換比較（文字列辞書順比較はミリ秒有無で破綻するため不採用）。9999-12-31 対応。
- entitlements の権限確認ログは ACCESS_TYPE=1、`ACCESS_LOG_INTERVAL_MIN`（分）で抑制。DEVICE_ID は NULL 同士も同一グループ。設定不在/非整数/負数は内部設定エラー、0 は抑制なし。
- 権限なし（未購入/停止/期限前/期限切れ）は PRODUCT_NOT_GRANTED で区別しない。

## 管理コンソール API（WORK-006）

すべて `requireAdmin`（ADMIN_AUTH_USER_ID 厳密一致）を通す。一般ユーザーは 403、未認証は 401。

| Method | Path | 内容 | 主なテーブル |
|---|---|---|---|
| GET | /api/admin/dashboard | 集計（総数/商品別/当日新規・購入/note未移行/未対応Warning/直近Warning） | 全般（読み取り） |
| GET | /api/admin/users | ユーザー検索（email/status/productCode/limit/offset） | M_USER, T_USER_PRODUCT, T_ACCESS_LOG |
| GET | /api/admin/users/{authUserId} | ユーザー詳細（全7テーブル、ログ新しい順・LIMIT） | 全7テーブル |
| PUT | /api/admin/users/{authUserId}/status | 停止/再開/退会（管理者自身の停止・退会は不可） | M_USER |
| PUT | /api/admin/users/{authUserId}/products/{productCode} | 商品権限 付与/停止/再開 | T_USER_PRODUCT |
| GET | /api/admin/warnings | Warning 検索 | T_WARNING |
| PUT | /api/admin/warnings/{warningId} | 対応状態・MEMO 更新（ユーザー自動停止しない） | T_WARNING |

- 画面: `/admin/`（ダッシュボード）, `/admin/users/`（一覧）, `/admin/users/detail.html?id=`（詳細）, `/admin/warnings/`（Warning）, `/admin/products/`（商品・閲覧のみ）。PC専用。
- 破壊的操作（停止/退会/商品停止）は confirm 必須。MEMO 等は textContent で挿入（HTML エスケープ）。
- 商品管理は閲覧のみ（商品編集 API は未実装）。note 取込・紐付けは WORK-006 では未実装（詳細画面での note 履歴表示のみ）。パスワード再設定メール送信も未実装。
- 管理者自身の停止・退会は `ADMIN_SELF_STATUS_CHANGE_NOT_ALLOWED`(400) で禁止（有効化は許可）。

## 購入・Stripe API（WORK-007）

SUN AND MOON PLANNER の買い切り販売。権限付与の正本は署名検証済み Webhook のみ（完了画面から付与しない）。

| Method | Path | 認証 | 内容 |
|---|---|---|---|
| POST | /api/purchases/checkout | 必須 | Checkout Session 作成（Price ID はサーバー env、metadata に auth_user_id/product_code） |
| POST | /api/stripe/webhook | 不要（署名検証必須） | checkout.session.completed かつ payment_status=paid で権限付与 |
| GET | /api/purchases/status | 必須 | 購入反映状況（available）を返す。付与はしない |

- 決済手段は **Stripe Dashboard の Payment methods 設定を正**とし、`payment_method_types` をコードで固定しない。card で開始可能、PayPay 等は審査承認後に Dashboard で有効化（コード変更不要）。
- Webhook は raw body を 1 回だけ取得し、Stripe SDK の `constructEventAsync` + `createSubtleCryptoProvider`（Workers 用 Web Crypto）で署名検証。
- 冪等性: `UX_T_PURCHASE_EXTERNAL`（PURCHASE_SOURCE, EXTERNAL_PURCHASE_ID、migration 0001 既適用）。再送は「処理済み」として 200。
- DB 反映は D1 batch（アトミック）。T_USER_PRODUCT は `last_insert_rowid()` で T_PURCHASE の PURCHASE_ID を参照。
- T_PURCHASE: PURCHASE_SOURCE=0 / PAYMENT_STATUS=1 / EXTERNAL_PURCHASE_ID=Session ID。T_USER_PRODUCT: STATUS=1 / GRANT_TYPE=0 / END_DATE=9999-12-31T23:59:59+09:00。
- 二重購入: Checkout 作成前に available を確認し ALREADY_PURCHASED(409)。Stripe 側で二重決済成立時は T_PURCHASE を購入事実として保持、T_USER_PRODUCT は 1 件のまま（管理者が返金判断）。
- 画面: `/purchase/success/`（status をリトライ確認）, `/purchase/cancel/`（DB 更新なし）。
- 秘密情報（Cloudflare Secrets）: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET。商品別 Stripe Price ID は M_PRODUCT.STRIPE_PRICE_ID（DB）で管理し、env の商品別 STRIPE_PRICE_* は使わない。

## 注文ライフサイクル堅牢化（WORK-011）

WORK-007 の Stripe 買い切り販売を、複数商品購入・二重 Checkout 排他・障害回復・返金/係争追跡まで含めて堅牢化する（設計正本は ORDER_LIFECYCLE_DESIGN 群）。権限付与の正本は引き続き署名検証済み Webhook（主経路）。共通 fulfill を webhook / success recovery / admin reconcile の 3 経路で共有する。

### 追加 API

| Method | Path | 認証 | 内容 |
|---|---|---|---|
| POST | /api/purchases/checkout | 必須 | `{ productCodes[], operationId }`。attempt+lock を 1 batch 確定 → Stripe create（DB snapshot 完全再現）。既存 operationId は再利用/回復 |
| POST | /api/purchases/recover | 必須 | success 画面から。`{ sessionId }`。metadata.auth_user_id 照合（他人 403）→ 共通 fulfill（Webhook より先でも即時反映） |
| POST | /api/purchases/cancel | 必須 | cancel 画面から。`{ operationId }`（sessionId は受けない）。open は Stripe Expire API → CANCELLED / lock 解放 |
| POST | /api/stripe/webhook | 不要（署名必須） | completed→共通 fulfill / expired→EXPIRED+lock 解放 / refund・dispute→T_PAYMENT_EVENT 記録 |
| POST | /api/admin/purchases/reconcile | 管理者 | `{ sessionId }` から共通 fulfill を実行。結果種別を返す（DB 直接編集しない） |
| GET | /api/admin/orders | 管理者 | 注文一覧（最新 100 件） |
| GET | /api/admin/orders/{orderId} | 管理者 | 注文詳細（明細・PaymentIntent・payment_event） |
| GET | /api/admin/payment-events | 管理者 | 決済運用イベント一覧（duplicate/refund/dispute/B2 追跡） |

### 排他・冪等・回復の要点

- **並行排他（方式B）**: `T_PRODUCT_CHECKOUT_LOCK` の PRIMARY KEY(AUTH_USER_ID, PRODUCT_ID)。行の存在＝active 予約。in-memory lock を使わない。
- **1 batch 原子性**: 新規 attempt＋item＋cart 全 lock を 1 batch。lock は素 INSERT（ON CONFLICT なし）で、1 件でも PK 競合すれば batch 全体が rollback（部分ロックを残さない）→ ALREADY_IN_PROGRESS(409)。Local D1（node:sqlite）で実測。
- **operationId**: browser 生成 UUID を server 検証。既存 attempt の再利用条件は OPERATION_ID + AUTH_USER_ID + CART_KEY の 3 一致。不一致は OPERATION_MISMATCH(409)。
- **idempotencyKey**: server 生成 `checkout:<AUTH_USER_ID>:<OPERATION_ID>`（別 user は別 key）。
- **create パラメータ完全再現**: BUYER_EMAIL / STRIPE_PRICE_ID / PRODUCT_CODE / SORT_NO を attempt 開始時に snapshot し、retry 時は実行時の auth.email / Price 解決 / 時刻を使わず DB から再現。EXPECTED_AMOUNT は将来の監査用予約列で現行フローでは未使用（0 を許容）。金額の正本は Stripe Price / Checkout Session。
- **create 失敗分類**: 確定失敗(InvalidRequest/Authentication/Permission)のみ lock 解放。RATE_LIMIT / INCONSISTENT / NETWORK / SERVER は lock 維持（迷えば維持側）。判定不能は SERVER_INDETERMINATE。
- **共通 fulfill**: Session を Stripe から expand 取得し再検証（payment_status / currency / line_items / Price / quantity / amount 合計 / metadata.auth_user_id）。metadata を正本にしない。paid なら T_ORDER＋T_PURCHASE×N＋T_USER_PRODUCT×N を原子 batch、T_ORDER に PAYMENT_INTENT_ID 保存。Session ID 冪等。
- **二重 paid**: fulfill 時に AUTH_USER_ID＋PRODUCT_ID で別注文 paid を検出。entitlement は 1 件維持、T_PAYMENT_EVENT に DUPLICATE_PAID 記録・管理者通知。自動返金しない。
- **refund / dispute**: T_ORDER.PAYMENT_INTENT_ID で逆引き。T_PAYMENT_EVENT へ記録（event.id 冪等）。自動剥奪しない。

### 追加テーブル（migration 0006）

- `T_CHECKOUT_ATTEMPT` / `T_CHECKOUT_ATTEMPT_ITEM`: 支払い試行層（paid 前）。既存 T_ORDER/T_PURCHASE/T_USER_PRODUCT は無改変維持。
- `T_PRODUCT_CHECKOUT_LOCK`: 二重 Checkout 排他（PK(AUTH_USER_ID, PRODUCT_ID)）。
- `T_PAYMENT_EVENT`: 運用イベント（DUPLICATE_PAID/REFUND/DISPUTE/FULFILL_FAILURE/RECONCILE/SERVER_INDETERMINATE。event.id 一意で冪等）。
- `T_ORDER.PAYMENT_INTENT_ID` 列追加（refund/dispute 逆引き）。

### STORE / 完了・キャンセル画面

- STORE: 複数選択→合計→1 回 Checkout。ログイン必須。既保有は選択不可、進行中は「購入手続き中」バナー（再開/取消）。依存 HANABI_GOOGLE_EARTH←HANABI を UI ガイド（正本は server の precheck）。表示価格は参考値で、実課金は Stripe Price を正本とする。
- success: `session_id` を recover API へ渡し即時反映を試み、`/api/account/products` で反映確認 polling。
- cancel: `operation_id` を cancel API へ渡し attempt を明示キャンセル（呼ばれない場合は expired Webhook / 開始時 stale 確認で回収）。

### Stripe Dashboard / Secrets（デプロイ前に要確認）

- **APP_BASE_URL**（非秘密の環境変数）を設定する。Stripe の success_url / cancel_url はこの固定オリジンから生成し、`request.url.origin` は使わない（同一 operation の retry で origin が揺れて Stripe create パラメータが変わるのを防ぐ）。Local は `.dev.vars` に `http://localhost:8787`、Production は wrangler.toml `[vars]` か Dashboard の Variables に実 URL を設定。未設定だと checkout は 500（壊れた URL の Session を作らない）。
- 商品別 Stripe Price ID: `M_PRODUCT.STRIPE_PRICE_ID`（DB）で管理する。Local/Test D1 には Test Price、Production D1 には Live Price を設定（環境ごとに独立管理。混在防止は Production 設定確認と E2E で担保）。env の商品別 STRIPE_PRICE_* は廃止。
- Webhook イベント有効化: `checkout.session.completed` / `checkout.session.expired` / `charge.refunded`（または `refund.*`）/ `charge.dispute.created|updated|closed`。

### 障害回復の要点（追補）

- **CREATE_ATTEMPTED**: Stripe create を呼ぶ直前に `T_CHECKOUT_ATTEMPT.CREATE_ATTEMPTED=1` を DB 確定する。`CREATE_ATTEMPTED=0 + SID=NULL`＝create 未試行（cancel で lock 解放可）、`CREATE_ATTEMPTED=1 + SID=NULL`＝create 結果不明（Session が存在し得るため cancel だけで lock を解放せず、同一 idempotencyKey の recover で収束）。
- **cancel の lock 解放**: open は Stripe Expire API が成功したときのみ「expired 確定」として解放。expire 失敗時は再 retrieve で complete/expired を確定できたときのみ対応し、確定できなければ lock 維持。「Session が存在するかもしれないのに再購入を許可しない」を優先。
- **CASE C（SID 保存失敗）**: fulfill 後の attempt 特定は第一に STRIPE_SESSION_ID 一致。見つからない場合のみ Session の `client_reference_id`(=operationId) で再特定し、①OPERATION_ID 一致 ②検証済み AUTH_USER_ID 一致 ③Stripe 実 line_items の商品構成 = ATTEMPT_ITEM snapshot = CART_KEY、を全て満たしたときのみ SID 回収 → attempt PAID → lock 解放（attempt/lock の残留を防ぐ）。
- **success 画面**: recover API が返す「今回 Session の購入商品コード（purchasedCodes）」だけを追跡し、その全てが available になったときのみ購入完了表示（既保有の別商品による誤判定を避ける）。
- **cancel 画面**: server の結果（cancelled / expired / already_paid / 結果不明）に応じて表示。already_paid や結果不明のときに「請求されていません」と断定しない。

### E2E 手順（Stripe 実機依存・自動テスト対象外）

以下は Stripe テスト環境での手動 E2E で確認する（unit/DB テストは `npm test` で自動化済み）:

1. 単一/複数商品購入 → success 画面で反映 → `/api/account/products` に granted。
2. 同一 operationId 再送（ネットワーク切断再現）→ 既存 Checkout URL に戻る（多重 Session を作らない）。
3. 別 user が他人の `session_id` で recover → 403 SESSION_FORBIDDEN。
4. Checkout を離脱 → cancel 画面 → 再度同一商品を購入可能（lock 解放）。
5. Checkout 放置で expire → expired Webhook で attempt EXPIRED / lock 解放。
6. 二重支払い（Webhook 再送・二重タブ）→ entitlement 1 件、payment-events に DUPLICATE_PAID。
7. 返金・チャージバックを Dashboard で発生 → payment-events に REFUND/DISPUTE（entitlement は自動剥奪されない）。
8. admin reconcile に paid Session を渡す → newly_fulfilled / already_fulfilled。

### Local/Test 専用: 購入状態リセット（Production 不可）

同一テストユーザー（Supabase Auth・メール・パスワード・AUTH_USER_ID は維持）で「購入前 → 購入 → 確認 → リセット → 再購入」を繰り返すための **Local/Test 環境専用**機能。Production では使用できない。

- **エンドポイント**: `POST /api/admin/test/reset-purchases`、body は `{ "authUserId": "..." }`（AUTH_USER_ID を正本）または `{ "email": "..." }`（内部で AUTH_USER_ID へ解決）。
- **二重防御**: ①環境ガード（**`APP_ENV` が `local` または `test` のときのみ利用可能**。`production` / 未設定 / 空文字 / 未知値 / typo は全て 404 `PRODUCTION_FORBIDDEN` で拒否する deny-by-default）②`requireAdmin` 必須。一般ユーザーは自分の購入履歴も消せない。
- **削除対象**（対象ユーザー分のみ・FK 安全順・1 D1 batch で全成功 or 全 rollback）: T_USER_PRODUCT / T_PURCHASE / T_PAYMENT_EVENT（`AUTH_USER_ID` 一致 or 対象ユーザーの `ORDER_ID` 由来）/ T_ORDER / T_PRODUCT_CHECKOUT_LOCK / T_CHECKOUT_ATTEMPT_ITEM / T_CHECKOUT_ATTEMPT。他ユーザー・無関係データは削除しない。M_USER（Auth ユーザー）は削除しない。
- **active Checkout の安全処理**（DB 削除前の Phase 1）: 対象ユーザーの進行中 attempt（CREATING/OPEN）を Stripe で確認し、`CREATE_ATTEMPTED=1 + SID=NULL`（create 結果不明）や Stripe 状態を確定できない場合は `ACTIVE_CHECKOUT_INDETERMINATE`(409) で中止し **DB を一切削除しない**（部分削除を作らない）。open Session は Stripe Expire 成功時のみ削除に進む。paid/complete Session は expire しない。
- **Stripe 側は削除しない**: Checkout Session / PaymentIntent / Charge / Refund 等の実履歴は残す。リセットするのは Platform DB のみ。
- **reconcile との関係**: reset で未購入に戻した後でも、過去の Stripe Session ID を `POST /api/admin/purchases/reconcile` に渡せば再付与できる（正常。reset → reconcile 再付与のテストが可能）。
- **reset 後の期待状態**: `GET /api/account/products` で対象 3 商品（SUN_AND_MOON / HANABI / HANABI_GOOGLE_EARTH）が granted=false になり、STORE で購入済み表示が消えて再購入可能になる。
- **注意**: Stripe API と D1 は 1 トランザクションにできないため、Phase 1 で一部 Session を expire した後に別の active attempt が状態不明で全体中止するケースは許容する（DB は無変更のため、次回 reset で expired として安全に処理される）。
- **秘密情報**: テストユーザーの実メール / 実 AUTH_USER_ID / 実 Stripe Session ID をソース・spec に固定で書かない。
- **response 例**: `{ "result": "OK", "data": { "authUserId": "...", "deleted": { "userProducts": 3, "purchases": 3, "orders": 3, "checkoutAttempts": 3, "checkoutAttemptItems": 3, "checkoutLocks": 3, "paymentEvents": 3 } } }`。

## note移行 API（WORK-008）

既存HANABI/Google Earth購入者を共通アカウントへ移行する。

| Method | Path | 認証 | 内容 |
|---|---|---|---|
| POST | /api/migrations/note/apply | 必須 | 移行申請（productCode + transactionId）。理由を区別しない共通エラー |
| GET | /api/migrations/note/status | 必須 | 自分の移行済み商品一覧 |
| POST | /api/admin/note/import | 管理者 | note販売履歴CSV取込（multipart/form-data） |
| GET | /api/admin/note/purchases | 管理者 | note購入一覧（noteId/transactionId/productCode/matchStatus） |
| PUT | /api/admin/note/purchases/{id} | 管理者 | 手動修正（MATCH_STATUS状態変更のみ） |

- CSV取込は必須ヘッダ（決済/返金日時・購入者名・決済種別・コンテンツ種別・コンテンツ名・販売額・取引ID）の存在を確認。列数固定でなく、余分列・将来追加列は無視。必須欠落は取込エラー。
- 取込対象は決済種別=販売 かつ コンテンツ種別=有料記事。チップ・販売以外は対象外（ignoredTips）。
- コンテンツ名→PRODUCT_CODEは空白正規化後の完全一致（既知4タイトル）。未知タイトルは取込エラー行（DB非保存）。
- 冪等: NOTE_TRANSACTION_ID UNIQUE。同一CSV再投入・複数月・順不同でも二重登録なし。
- 取込結果: {read, imported, ignoredTips, duplicates, errors[]}（errorは行番号・コンテンツ名・取引ID）。
- 日時: 14桁YYYYMMDDHHmmss（JST）→ YYYY-MM-DDTHH:mm:ss+09:00。
- 移行成立: D1 batchでT_PURCHASE(SOURCE=1/EXTERNAL_PURCHASE_ID=取引ID) + T_USER_PRODUCT(GRANT_TYPE=1) + T_NOTE_PURCHASE(MATCH_STATUS=1)。元note購入日時をPURCHASE_DATE/START_DATEへ。last_insert_rowid()でPURCHASE_ID引き継ぎ。
- 購入者名はNOTE_IDに保持（実名/ハンドル/ゲスト）。認証照合には使わない。
- 先行テスター（Earth購入者へのHANABI本体付与）は既存の商品権限更新APIでgrantType=2/memo付与。
- 画面: 利用者向け /migration/note/、管理者向け /admin/note/。
