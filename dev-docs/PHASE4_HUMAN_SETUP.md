# PHASE4_HUMAN_SETUP — 正式 DEV 環境 構築手順（人間が 1 工程ずつ実施）

BASELINE_MAIN_COMMIT = 7f3b46656b8c4c85d35717d4d9b432672f20e84c
前提: 本書は Phase 2（P0/Access 対応版）実装を前提とする。**Claude は Cloudflare 変更・deploy・commit・push を
実行しない**。以下はすべて人間が実施する。各工程は前工程の確認後に進む。

## 変更してはいけないもの（全工程共通）
- Production D1（name=`shingo-camera-platform` / id=`52a29812-4239-4dc5-985b-a77cffca09ae`）。
- Production Worker の custom domain / route / main の自動 deploy 経路。
- Production Stripe（Live）・Production Secrets・Production migration。
- wrangler.toml の top-level（Production）セクション。末尾 `[env.dev]` のみ触れる。

---

## STEP 3. DEV 専用 D1 作成 → migration 適用

### 3-1. 事前確認（Production を変更しないための確認）
```
# Production D1 の名前と id を確認（控えるだけ・変更しない）
npx wrangler d1 list
# → shingo-camera-platform / 52a29812-4239-4dc5-985b-a77cffca09ae があること
grep -A3 '^\[\[d1_databases\]\]' wrangler.toml   # top-level が 52a29812 のままであること
```

### 3-2. DEV D1 作成
```
npx wrangler d1 create shingo-camera-platform-dev
```
出力の `database_id`（例 `xxxxxxxx-...`）を控える。**これは Production の 52a29812 とは必ず異なる**。

### 3-3. wrangler.toml へ DEV database_id を反映
`[[env.dev.d1_databases]]` の `database_id = "REPLACE_WITH_DEV_D1_DATABASE_ID"` を、3-2 の値へ置換。
binding 名は `DB`（Production と同じ binding 名だが、参照先 Database は env で分離される）。
```
grep -n "REPLACE_WITH_DEV_D1_DATABASE_ID" wrangler.toml   # 置換後は 0 件
```

### 3-4. 既存 migration を DEV D1 にだけ適用
**必ず `--env dev` を付ける**（付け忘れると Production 側 D1 に適用される事故になる）。
```
# 適用前ドライ確認：どの Database に当たるかを表示（--env dev が効いているか）
npx wrangler d1 migrations list shingo-camera-platform-dev --env dev --remote
# 適用（0001〜0008）
npx wrangler d1 migrations apply shingo-camera-platform-dev --env dev --remote
# 確認
npx wrangler d1 execute shingo-camera-platform-dev --env dev --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

### 3-5. DEV seed（Stripe **Test** の Price 等）
`STRIPE_PRICE_ID` は env ではなく **M_PRODUCT テーブル**に持つ。migration 直後は M_PRODUCT に
`SUN_AND_MOON` / `HANABI` / `HANABI_GOOGLE_EARTH` の行はあるが Stripe Price 未設定。DEV で購入 E2E を試す商品だけ、
**Stripe Test の price_id** と販売フラグを設定する（例: SUN AND MOON を Test で購入可能に）。
```
# 例（Stripe Test の price を各自の値へ）。Production D1 には実行しない。
npx wrangler d1 execute shingo-camera-platform-dev --env dev --remote --command \
 "UPDATE M_PRODUCT SET STRIPE_PRICE_ID='price_test_xxx', PURCHASE_ENABLED=1, SALE_TYPE='ONE_TIME', DISPLAY_PRICE=XXXX WHERE PRODUCT_CODE='SUN_AND_MOON';"
```
自分の DEV テスト用 entitlement が必要な場合は、Stripe Test 決済で付与するのが本筋（STEP 13）。手動付与は必要時のみ。

---

## STEP 4. DEV Secrets / Vars 一覧と設定
`wrangler secret put <NAME> --env dev` は **DEV Worker にのみ**登録する（Production Secret は変更しない）。
不足時は **fail-closed**（Production へ fallback しない）。

| 名前 | 区分 | 値の種別 | 共用/専用 | 備考 |
|---|---|---|---|---|
| `APP_ENV` | Var(公開) | `development` | DEV 専用値 | DEV badge / health |
| `APP_BASE_URL` | Var(公開) | `https://shingo-camera.com/dev` | DEV 専用値 | Stripe success/cancel |
| `DEV_BASE_PATH` | Var(公開) | `/dev` | DEV 専用値 | shim 有効化キー（Production は未設定） |
| `DEV_ACCESS_TEAM_DOMAIN` | Var(公開) | 例 `myteam` | DEV 専用値 | STEP 5 で確定 |
| `DEV_ACCESS_AUD` | Var(公開) | Access AUD tag | DEV 専用値 | STEP 5 で確定 |
| `SUPABASE_URL` | Secret | Production と同値 | **共用** | Auth JWKS/issuer。Auth 共用のため同値 |
| `SUPABASE_ANON_KEY` | Secret | Production と同値 | **共用** | フロントへ /api/config 経由で公開 |
| `STRIPE_SECRET_KEY` | Secret | **sk_test_…** | DEV 専用(Test) | Live を絶対に使わない |
| `STRIPE_WEBHOOK_SECRET` | Secret | **Test whsec_…** | DEV 専用(Test) | webhook の認証境界 |
| `SESSION_ID_HASH_SECRET` | Secret | DEV 用ランダム | DEV 専用 | 無くても動作（不正検知の補助が減るのみ） |
| `MAIL_API_KEY` | Secret | 任意(Test) | DEV 専用 | support 通知を試す場合のみ |
| `SUPPORT_NOTIFY_EMAIL` | Var/Secret | 任意 | DEV 専用 | 同上 |
| `ADMIN_AUTH_USER_ID` | Secret | 自分の auth uid | 共用可 | DEV で admin を試す場合 |

注: `SUPABASE_SERVICE_ROLE_KEY` は現行 Worker では未使用（Auth は JWT 検証のみ）。DEV に設定不要。
Stripe Test の Price ID は Secret ではなく M_PRODUCT（DEV D1）に持つ（STEP 3-5）。

設定例:
```
npx wrangler secret put STRIPE_SECRET_KEY --env dev        # sk_test_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env dev    # Test webhook whsec_...
npx wrangler secret put SUPABASE_URL --env dev             # Production と同値
npx wrangler secret put SUPABASE_ANON_KEY --env dev        # Production と同値
npx wrangler secret list --env dev                         # DEV Worker の secret 一覧確認
```

---

## STEP 5. Cloudflare Access Application（/dev/* 保護）
1. Cloudflare **Zero Trust** → Access → Applications → **Add an application** → **Self-hosted**。
2. Application name: 例 `shingo-camera DEV`。
3. Application domain: `shingo-camera.com` / path: `dev`（= `shingo-camera.com/dev`。サブパス含め保護）。
4. **Policy**: Action=**Allow**、Include=**Emails**=自分のメールのみ（一般ユーザー/未ログイン/他メールは不可）。
5. 作成後、Application 設定で以下を控える：
   - **Application Audience (AUD) tag** → `DEV_ACCESS_AUD` に設定。
   - **Team domain**（Zero Trust の Settings → Custom Pages / General に `https://<team>.cloudflareaccess.com`）→
     `<team>` を `DEV_ACCESS_TEAM_DOMAIN` に設定（`myteam` でも `https://myteam.cloudflareaccess.com` でも可）。
6. STEP 4 の Var へ反映後、DEV Worker 再 deploy 時に有効化（Worker 側 JWT 本検証と二段になる）。
   - Worker 側検証: `Cf-Access-Jwt-Assertion` の署名/issuer/aud/email を jose で検証。env 不足・不正は fail-closed。

---

## STEP 6. Stripe DEV Webhook だけ Access Bypass（exact path）
対象は **`POST /dev/api/stripe/webhook` だけ**。`/dev/*` 全体・`/dev/api/*` 全体を Bypass しない。

### 手順
1. Zero Trust → Access → Applications で、`shingo-camera.com/dev/api/stripe/webhook` を対象にする。
   - 推奨: **webhook 専用の Self-hosted Application** を新規作成（domain=`shingo-camera.com`,
     path=`dev/api/stripe/webhook`）。より **具体的な path の Application が優先**されるため、包括の
     `dev` Application より webhook 専用が先に評価される。
2. その webhook Application の Policy を **Action=Bypass**（Include=Everyone）にする。
   → Stripe Test からの POST が Access を素通りして Worker に到達する。

### Cloudflare Access の制約（正確に）
- **Access の path/Application マッチングは HTTP method を区別しない**。したがって Access 単独では
  「POST だけ Bypass」「GET は保護」を厳密に分離できない。webhook path の Application を Bypass にすると、
  `GET /dev/api/stripe/webhook` も Access 上は素通りになる。
- この制約は **Worker 側の二重防御**で吸収する：
  - Worker の `isDevWebhookExempt(method, inner)` は **`POST` かつ inner==`/api/stripe/webhook`（exact）** のときだけ
    Access JWT を免除する。**GET は免除しない**（GET は Access JWT が無いので 403）。**前方一致
    （`/api/stripe/webhook/xxx`）も免除しない**。
  - つまり Access で webhook path を Bypass しても、GET やサブパスは Worker が Access JWT を要求して弾く。
    実質「POST exact のみ認証境界＝Stripe 署名」に収束する。
- webhook 到達後の認証境界は **Stripe 署名検証（既存 handleStripeWebhook・Test の STRIPE_WEBHOOK_SECRET）**。
  署名が無い/不正なら 400 で拒否。
3. Stripe（Test）Dashboard の Webhook エンドポイントを
   `https://shingo-camera.com/dev/api/stripe/webhook` に設定し、その署名シークレットを
   `STRIPE_WEBHOOK_SECRET`（--env dev）に登録（STEP 4）。

---

## STEP 7. DEV Worker / Route（別環境として deploy）
- DEV Worker は wrangler environment `[env.dev]`（name=`shingo-camera-platform-dev`）。
- 手動 deploy（初回・確認用）:
```
# ドライラン（DEV 環境のビルド確認。実 deploy しない）
npx wrangler deploy --env dev --dry-run --outdir /tmp/devbuild
# 実 deploy（初回。以降は Workers Builds が develop push で自動化）
npx wrangler deploy --env dev
```
- deploy 後、DEV Worker の binding を確認（DEV D1 / ASSETS / vars）:
```
npx wrangler deployments list --env dev
# Dashboard → Workers & Pages → shingo-camera-platform-dev → Settings → Bindings/Variables で
#   D1=DEV database_id / ASSETS 有 / APP_ENV=development / DEV_BASE_PATH=/dev / DEV_ACCESS_* を確認
```
- Route は `[env.dev].routes` の `shingo-camera.com/dev/*` のみ。Production の custom domain/route は変更しない。

---

## STEP 8. /dev Route 優先順位の確認
Production custom domain（全パス）と DEV route（`/dev/*`）が競合しないこと。より具体的な route が優先される。

Dashboard → Workers & Pages → 各 Worker → Triggers/Routes、または以下で期待値を確認（Access 通過後）：

| リクエスト | 期待 |
|---|---|
| `/store/` | Production Worker |
| `/apps/sun-and-moon/` | Production Worker |
| `/api/config` | Production Worker |
| `/dev/store/` | DEV Worker |
| `/dev/apps/sun-and-moon/` | DEV Worker |
| `/dev/api/config` | DEV Worker |

確認例:
```
curl -sI https://shingo-camera.com/api/config | grep -i x-robots-tag   # Production: noindex なし
# /dev/* は Access 保護のためブラウザで（Access 通過）確認。curl は Access で 302/403 になる。
```

---

## STEP 9. Workers Builds / Git branch（main は不変、develop を追加）
現状: main → Production 自動 deploy（Workers Builds Git 連携）。これを壊さず develop→DEV を追加。

1. Dashboard → Workers & Pages → **shingo-camera-platform**（Production）→ Settings → **Builds**：
   - Production branch が **main** であることを確認（変更しない）。
2. Dashboard → **shingo-camera-platform-dev**（DEV Worker）→ Settings → **Builds** → Connect to Git：
   - 同じ repo を接続し、**Production branch = develop**、Deploy command = `npx wrangler deploy --env dev`。
   - これで **develop push は DEV Worker のみ**、**main push は Production Worker のみ**を更新。
3. 確認:
   - develop へ push → DEV Worker の Deployments が更新、Production Worker は不変。
   - main へ push → Production Worker のみ更新、DEV Worker は不変。

---

## STEP 10. develop branch 初回作成（Git・人間）
```
git fetch origin
git status                     # 変更が無いこと（クリーン）を確認
git checkout main
git pull --ff-only origin main # 最新 main（fast-forward のみ）
git rev-parse HEAD             # 7f3b466... 等・baseline と一致を確認
git checkout -b develop        # 最新 main から develop を作成
git push -u origin develop     # develop を push（Production main へは commit/push しない）
```
以降の DEV 変更はすべて develop で行い、main へは merge でのみ昇格（STEP 14）。

---

## STEP 11. DEV 初回 deploy 前チェックリスト
- [ ] DEV D1 `database_id` が Production（52a29812）と**異なる**。
- [ ] `STRIPE_SECRET_KEY` が **sk_test_**（Live でない）。
- [ ] `STRIPE_WEBHOOK_SECRET` が **Test**。
- [ ] `APP_ENV=development` / `APP_BASE_URL=https://shingo-camera.com/dev` / `DEV_BASE_PATH=/dev`。
- [ ] `DEV_ACCESS_TEAM_DOMAIN` / `DEV_ACCESS_AUD` 設定済（STEP 5）。
- [ ] DEV Worker に `ASSETS` binding あり、route は `/dev/*` のみ。
- [ ] Production route / custom domain 不変。DEV 未設定値の Production fallback が無い（fail-closed）。

---

## STEP 12. 初回 DEV deploy 後 smoke test（人間・順番）
A. 未ログイン/Access 未認証で `https://shingo-camera.com/dev/` → **Access で遮断**。
B. 許可メールで Access 通過 → DEV Platform が表示。
C. 右下に **DEV badge** 表示。
D. Supabase 既存ユーザーでログインできる（Auth 共用）。
E. `/dev/store/` `/dev/mypage/` `/dev/apps/sun-and-moon/` が表示。
F. localStorage の既存 SUNMOON 登録地点が DEV でも見える（同一 origin 共用）。
G. DevTools Network で API が `/dev/api/...` へ向いている。
H. `/api/...`（Production）へ自前リクエストが**漏れていない**。
I. DEV で D1 write（例: DEV で購入/設定変更）→ **DEV D1 のみ**変化。
J. Production D1 は**不変**（`wrangler d1 execute shingo-camera-platform --remote --command "SELECT ..."` で確認。--env dev を付けない Production 参照は読み取りのみ）。
K. `/dev/*` レスポンスに `X-Robots-Tag: noindex, nofollow`。
L. Production サイト（`/store/` 等）が正常。

---

## STEP 13. Stripe Test E2E（人間）
1. `/dev/store/` から Test Checkout を開始（Stripe Test カード 4242… を使用）。
2. Checkout 完了 → Stripe Test が `POST https://shingo-camera.com/dev/api/stripe/webhook` を送信。
3. Worker が **Stripe 署名検証**を通す（Access は webhook exact path のみ Bypass、GET/サブパスは不可）。
4. DEV D1 の entitlement（T_USER_PRODUCT 等）が反映。
5. 確認:
   - **Production D1 は不変**（--env dev を付けない Production 参照で当該ユーザー行が増えていない）。
   - **Stripe Live** に Checkout/売上が作られていない（Stripe Dashboard の Live/Test を切替えて確認）。
   - Access Bypass 対象が **webhook exact path だけ**（`/dev/api/config` 等は Access 必須のまま）。

---

## STEP 14. develop → main 昇格（Production 反映）
1. develop 最新を DEV へ自動 deploy → PC/iPhone で確認（STEP 12/13）。
2. テスト green（`npm test`＝既存 baseline の 2 fail 以外が緑）。
3. **DB migration を伴う場合**（後方互換を最優先）:
   - 追加型（ADD COLUMN 等・後方互換）: **先に Production migration → その後コード deploy**。
     （新カラムを使うコードより先にカラムを作る。逆順は本番エラー。）
   - 破壊的変更は down 前提にしない（現行方針）。必要時は前進 migration で補正。
4. `develop → main` を PR で merge。
5. main push → Production 自動 deploy。
6. Production smoke test（`/api/health`・ログイン・主要導線・Stripe Live は触らない範囲で）。

---

## STEP 15. Rollback（DEV だけ撤去・Production 不変）
問題時は以下で DEV のみ撤去でき、Production には一切影響しない。
- **/dev Route 削除**: DEV Worker の route `shingo-camera.com/dev/*` を削除 → DEV 入口が閉じる。
- **DEV Access Application 無効化**: Zero Trust の Application を Disable。
- **DEV Worker 無効化/削除**: `shingo-camera-platform-dev` を Disable または削除（Production Worker は別）。
- **DEV 自動 deploy 停止**: DEV Worker の Builds（develop 連携）を Disconnect。
- **DEV D1**: そのまま残しても Production へ影響なし。作り直す場合は `d1 delete shingo-camera-platform-dev`
  → STEP 3 で再作成（Production 52a29812 には触れない）。
- **昇格後のコード rollback**: main を直前へ revert→push、または Cloudflare Deployments で前版へ rollback。
- Production D1 migration は down 前提にせず、前進 migration で補正（現行方針）。

---

## 参考（実装対応）
- prefix strip / ASSETS / HTMLRewriter / noindex: `src/index.ts` handleDevRequest（DEV_BASE_PATH 未設定の
  Production は no-op）。
- Access JWT 本検証 / webhook exempt: `src/shared/dev_access.ts`（jose）。
- API base / navigation resolver: `public/assets/api-base.js`（apiUrl/appUrl、Production は base=""）。
- wrangler `[env.dev]`: DEV Worker 定義（D1/ASSETS/vars/route）。top-level（Production）は不変。
