# CURRENT_ARCHITECTURE — shingo-camera Platform 現行構成 characterization

BASELINE_MAIN_COMMIT = 7f3b46656b8c4c85d35717d4d9b432672f20e84c
branch = main / working tree clean / 最新commit 2026-08-16 11:54 "Add files via upload"
（本ドキュメントは上記 GitHub 最新 main の実コードのみを正本とする。過去 ZIP・成果物は不使用。）

## 1. Cloudflare / deploy 構成（wrangler.toml 実値）
- **単一 Worker** `name="shingo-camera-platform"`, `main="src/index.ts"`, `compatibility_date=2026-08-01`。
- `workers_dev=false`（*.workers.dev 無効）。正規入口は **custom domain `https://shingo-camera.com`**。
- `keep_vars=true`（Dashboard の [vars] を deploy で消さない）。
- `[vars] APP_ENV="production"`, `APP_BASE_URL="https://shingo-camera.com"`。
- `[assets] directory="./public"`, `run_worker_first=["/api/*"]`, `html_handling="auto-trailing-slash"`,
  `not_found_handling="none"`。**ASSETS binding は無い**（Worker から静的取得しない設計）。
- `[[d1_databases]] binding="DB" database_name="shingo-camera-platform" database_id="52a29812-4239-4dc5-985b-a77cffca09ae"`, `migrations_dir="migrations"`。
- `[triggers] crons=["0 * * * *"]`（毎時 Warning ジョブ）。`[observability] enabled=true`。
- **R2 binding は無い**。R2 は公開URL参照のみ（下記）。
- **設計方針の明記**：toml 冒頭「環境方針: Local と Production（非公開）のみ。専用 Staging は作らない。
  設計根拠 ADR-011_LOCAL_AND_PRODUCTION_ONLY.md」。← 今回の DEV は第3環境で **ADR-011 と矛盾**（要決定）。

## 2. main push → Production 自動 deploy の経路
- リポジトリに `.github/workflows` は **無い**。`package.json` scripts は `deploy=wrangler deploy`（手動）。
- したがって **main push→Production 自動 deploy は Cloudflare Workers Builds（Dashboard の Git 連携）** による
  （repo 内 workflow ではない）。実際の連携先/branch 設定は Cloudflare Dashboard 側にあり、リポジトリからは
  確認できない（Phase 4 の human step で確認する）。

## 3. API routing（src/index.ts）
- 全 `/api/*` を Worker が処理（`run_worker_first=["/api/*"]`）。それ以外は Static Assets。
- 分岐は自前の exact/prefix マッチ：`/api/config`,`/api/account/*`,`/api/products*`,`/api/entitlements/*`,
  `/api/apps/sun-and-moon/*`(app-start/heartbeat/計算API),`/api/admin/*`(routeAdmin→requireAdmin),
  `/api/purchases/*`,`/api/stripe/webhook`,`/api/migrations/note/*`,`/api/support/contact`。
- SUN AND MOON 計算 API は router 内で `requireProduct(SUN_AND_MOON)` を通す。

## 4. 認証・認可
- **Supabase JWT**（`jose` の `createRemoteJWKSet`+`jwtVerify`）。トークンは **`Authorization: Bearer`
  ヘッダー**から取得（`src/shared/auth.ts`）。→ **API fetch でのみ送られ、HTML の画面遷移（top-level
  navigation）では送られない**。
- **admin**：`src/shared/admin.ts requireAdmin` が「検証済み AUTH_USER_ID === `env.ADMIN_AUTH_USER_ID`」
  のみを正本に判定。未設定は fail-closed（403）。**ID は env 管理・ソース hardcode なし**。
- `/api/config`（`src/routes/config.ts`）はフロントへ **`supabaseUrl` / `supabaseAnonKey` のみ**返す（非秘密）。

## 5. Env バインディング（src/index.ts の Env interface）
`APP_ENV`, `DB`(D1), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_AUTH_USER_ID`, `APP_BASE_URL`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `MAIL_API_KEY`, `SUPPORT_NOTIFY_EMAIL`, `SESSION_ID_HASH_SECRET`。
秘密は Secret / .dev.vars 管理（Git/toml に書かない方針）。

## 6. フロントの API 呼び出し
- **絶対パス `fetch("/api/...")` をハードコード**（`/api/config`,`/api/account/sync`,`/api/purchases/checkout`
  等）。**動的 API base / basePath は存在しない**。→ `/dev/` 配下から開いても `/api/*` は origin 直下＝
  **Production Worker** に飛ぶ（DEV 分離には base 変更が必要。下記 D4）。

## 7. R2 / Stripe / Supabase の実利用
- **R2**：`src/apps/sun-and-moon/api/_geo.js` の公開URL `https://pub-...r2.dev/japan_pref.geojson` を **読み取り
  のみ**（HANABI と同一オブジェクト再利用）。**write binding 無し**。
- **Stripe**：`stripe` パッケージ、`getStripe(env)`、`stripe_fulfill.ts`。Checkout/Webhook は D1
  `T_CHECKOUT_ATTEMPT` 等と連携。鍵は `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`（Secret）。
- **Supabase**：Auth（JWT 検証）が主。`SUPABASE_SERVICE_ROLE_KEY` は config で「秘密」と明記（フロント非公開）。
  アプリ DB は **Cloudflare D1**（Supabase の DB/Storage への直書きは確認範囲で見当たらない。service_role の
  実利用箇所は Phase 2 前に要精査）。

## 8. migration / robots
- `migrations/0001〜0008`（初期スキーマ, jst, access-log interval, warning threshold, T_ORDER+order_id,
  checkout lifecycle, product sale columns, product dependency）。適用は `wrangler d1 migrations apply
  shingo-camera-platform --local/--remote`。
- `public/robots.txt`：`Disallow: /api/` のみ。HTML は meta noindex 方針（Disallow するとクローラが noindex を
  読めないため）。Sitemap `https://shingo-camera.com/sitemap.xml`。

## 9. baseline テスト状態（未変更で実行）
`npm test` = **378 tests / 376 pass / 2 fail**（clone 直後・無変更）。失敗2件はいずれも SUN AND MOON 検索:
1. `実 /api/chance：pinpoint 全件 m≤30・上端中央近傍（altPct≈100）・全件収束`
2. `P0-1/P0-2: 月chanceで、真の日別最小moveMをエンドポイントが落とさず代表もmoveM最小`
→ **latest main 自体に存在する既存の失敗**（main 内の _search.js とテストの不整合と推測）。DEV 作業とは無関係で、
本作業では一切変更していない。「既存 regression 全 green」は **baseline 時点で満たされていない**（要認識）。
