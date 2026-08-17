# CLOUDFLARE_DEV_SETUP —（人間が実施）確定手順

決定: D2=prefix strip + ASSETS（採用済）／D3=Cloudflare Access（採用済）。Claude は Dashboard 操作・Worker 作成・
Secret 登録・Route 設定・Access 設定を実行しない。以下は再現手順。

## STEP 0 前提の確認（変更しない）
1. Cloudflare Dashboard を開く。
2. `shingo-camera.com` が Production Worker に紐付く方式（Custom Domain / Route）を控える。
3. main push→Production 自動 deploy が Workers Builds（Git 連携）であること・対象 repo/branch を控える。
   （既存 Production 経路は変更しない。）

## STEP 1 DEV D1 作成 → wrangler へ id 反映
1. `wrangler d1 create shingo-camera-platform-dev` を実行。
2. 出力 database_id を `wrangler.toml` の `[[env.dev.d1_databases]] database_id` の
   `REPLACE_WITH_DEV_D1_DATABASE_ID` と置換。Production id（52a29812-…）は流用しない。
3. `wrangler d1 migrations apply shingo-camera-platform-dev --remote --env dev`（0001〜0008）。seed は DEV_D1_SETUP.md。

## STEP 2 DEV Secrets / Vars
1. `[env.dev.vars]` の `DEV_ACCESS_TEAM_DOMAIN` / `DEV_ACCESS_AUD` を実値へ置換（STEP 4 で確定）。
2. `wrangler secret put STRIPE_SECRET_KEY --env dev`（sk_test_…）、`STRIPE_WEBHOOK_SECRET --env dev`（Test）、
   `SUPABASE_URL` / `SUPABASE_ANON_KEY`（Auth 共用のため Production と同値）等（DEV_SECRETS.md）。
   不足時は fail-closed（Production へ fallback しない）。

## STEP 3 Route
1. `shingo-camera.com/dev/*` を DEV Worker（shingo-camera-platform-dev）へ Route（[env.dev].routes と一致）。
2. 既存 Production の Custom Domain/Route は変更しない（`/dev/*` は Route が優先）。

## STEP 4 Cloudflare Access（Zero Trust）で /dev/* を保護
1. Zero Trust → Access → Applications → Add（Self-hosted）。
2. Application domain: `shingo-camera.com` / path: `dev`（= `shingo-camera.com/dev`）。サブパス含め保護。
3. Policy: Allow、Include = Emails = 自分のメールのみ（allowlist はここで管理。ソース hardcode しない）。
4. Application の **Audience(AUD) タグ**を控え、`DEV_ACCESS_AUD` に設定。**Team domain**（`https://<team>.cloudflareaccess.com`）
   の `<team>` を `DEV_ACCESS_TEAM_DOMAIN` に設定。
5. これで DEV HTML / static asset / `/dev/api/*` がすべて Access 配下になる（未通過は 403）。
   Worker 側も Cf-Access-Jwt-Assertion を本検証（署名/issuer/aud）し二段で防御（fail-closed）。

## STEP 4B Stripe Webhook だけ Access 対象外（P0-1）
Stripe Test からの `POST /dev/api/stripe/webhook` は Cloudflare Access を通れないため、この **exact path のみ**
Access のユーザー認証対象から外す。Webhook 以外を広く Bypass しない。
1. 同 Access Application 内に **Bypass ポリシー**を追加、または webhook 用に別 Application を作る。
   - 対象 path: `dev/api/stripe/webhook`（exact）。
   - Policy action: **Bypass**（Everyone）。
2. これにより webhook は Access を素通りし Worker の route() → handleStripeWebhook に到達する。
   認証境界は **Stripe 署名検証（既存・Test の STRIPE_WEBHOOK_SECRET）**。署名不正は 400 で拒否。
3. Worker 側も `POST /dev/api/stripe/webhook` のみ Access JWT を要求しない（exact 一致・前方一致は除外しない）。
   その他の `/dev/api/*` は Access JWT 必須のまま。
4. Stripe（Test）Dashboard の Webhook 送信先を `https://shingo-camera.com/dev/api/stripe/webhook` に設定。

## STEP 5 Workers Builds（develop→DEV）
DEV_DEPLOY_FLOW.md 参照。develop → `wrangler deploy --env dev`。main→Production は既存のまま。

## STEP 6 確認
- 未ログイン/許可外メールで `/dev/` が 403（HTML/API とも）。許可メールのみ通る。
- `POST /dev/api/stripe/webhook` は Access 無しでも到達し、Stripe 署名不正は拒否される。
- `GET /dev/api/config` は Access JWT 無しでは絶対に通らない。
