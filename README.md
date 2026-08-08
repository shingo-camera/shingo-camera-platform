# shingo-camera Platform 共通基盤

shingo-camera Platform（SUN AND MOON / HANABI / 将来アプリ）の共通認証・購入・
商品権限・管理基盤のコードリポジトリ。設計の正本は別リポジトリ
`shingo-camera-platform-spec` にある。

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
- 秘密情報（Cloudflare Secrets）: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_SUN_AND_MOON。

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
