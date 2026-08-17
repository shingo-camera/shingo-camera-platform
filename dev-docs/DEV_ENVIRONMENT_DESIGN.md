# DEV_ENVIRONMENT_DESIGN — 実装反映版（Phase 2 完了・レビュー待ち）

BASELINE_MAIN_COMMIT = 7f3b46656b8c4c85d35717d4d9b432672f20e84c

決定（D1〜D5）を反映して実装した。**Production ロジック・Production 経路は不変**（shim は env-gated no-op、
wrapper は base="" で挙動不変、wrangler は additive `[env.dev]`）。Cloudflare Dashboard 設定は未実行（human 手順）。

## 実装（このリポジトリ差分）
### D2 env-gated prefix-strip shim ＋ ASSETS（src/index.ts, src/shared/dev_prefix.ts）
- `handleDevRequest(request, env, ctx)` を fetch 先頭で評価。**`env.DEV_BASE_PATH` 未設定（Production）は
  即 null＝完全 no-op**（既存 route/URL/挙動 不変）。
- DEV では：先頭 `/dev` を `stripDevPrefix` で除去 → API は既存 `route()` を DEV bindings で実行、非 API は
  `env.ASSETS.fetch` で `public/` 配信。HTML は `HTMLRewriter` で `devPrefixAttr` によりルート相対
  `href/src/action/poster` を `/dev` 前置（DEV が develop の静的資産を自己完結で読む）。
- 全 `/dev/*` レスポンスへ `X-Robots-Tag: noindex, nofollow`（要件 16）。

### D3 Cloudflare Access（前段）＋ Worker JWT 本検証（二段）
- `shingo-camera.com/dev/*` を Cloudflare Access のメール allowlist で保護（Dashboard）。Supabase 認証は
  Platform 内でそのまま併用。
- **Worker 側も Access JWT（Cf-Access-Jwt-Assertion）を本検証**（`src/shared/dev_access.ts`）：
  署名（JWKS）／issuer=`DEV_ACCESS_TEAM_DOMAIN`／audience=`DEV_ACCESS_AUD` を jose で検証し、
  payload.email を取得できた場合のみ許可。env 不足・JWT 不正はすべて 403（fail-closed）。
  ＝ Access policy ＋ Worker JWT 検証の二段。ユーザーID/メールはソース hardcode せず Access allowlist で管理。
- **Stripe webhook 例外（P0-1）**：`POST /dev/api/stripe/webhook`（exact）のみ Access 対象外
  （machine-to-machine）。Access JWT を要求せず route()→handleStripeWebhook へ通し、**Stripe 署名検証**
  （Test の STRIPE_WEBHOOK_SECRET）を認証境界とする。前方一致では除外しない／webhook 以外は広く bypass しない。

### D4 API base wrapper（public/assets/api-base.js＋各画面）
- `apiBase()`/`apiUrl()`/`apiFetch()` を 1 ファイルに集約（/dev 判定はここだけ）。
- 既存 `fetch("/api/...")` を全棚卸しし `apiFetch("/api/...")` へ統一（30 箇所）。各 HTML の先頭へ
  `<script src="/assets/api-base.js">` を注入（24 ファイル）。
- **Production は `apiBase()===""` で URL/挙動が完全一致**（characterization test で固定）。DEV は `/dev/api/...`。

### DEV badge（要件 15）
- api-base.js が DEV（/dev 配下）のときだけ右下固定の小 badge を自動表示（`pointer-events:none`）。
  Production では非表示。HTML を手作業で DEV 版に書き換えない。

### wrangler（[env.dev] additive・top-level 不変）
- `name=shingo-camera-platform-dev`, `routes=[shingo-camera.com/dev/*]`, `[env.dev.assets]`（ASSETS binding,
  run_worker_first=["/dev/*"]）, `[env.dev.vars]`（APP_ENV=development / DEV_BASE_PATH=/dev /
  APP_BASE_URL=.../dev）, `[[env.dev.d1_databases]]`（DEV database_id は human が作成し置換）。
- Production の top-level（custom domain / D1 `52a29812-...` / cron）は一切変更していない。

## 【共用】/【分離】（確定）
- 共用：Supabase Auth／同一 origin／localStorage／読み取り専用 R2（japan_pref.geojson）／コードベース。
- 分離：D1 Database（DEV 専用 id）／migration 適用先／Stripe（Live vs Test）／write 系 R2／Worker
  environment／Secrets・Vars 環境値／DEV アクセス権（Access allowlist）／DEV API 実行環境。
  fail-closed（DEV binding/secret 不足時 Production fallback しない）。

## 残（Cloudflare 側 human 手順・Phase 4）
DEV D1 作成＋id 置換／DEV Secrets（Stripe Test 等）／Route `/dev/*`／Cloudflare Access allowlist／
Workers Builds（develop→DEV / main→Production）。CLOUDFLARE_DEV_SETUP.md / DEV_D1_SETUP.md /
DEV_SECRETS.md / DEV_DEPLOY_FLOW.md 参照。
