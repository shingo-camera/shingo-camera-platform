# REPORT — 正式 DEV 環境構築 Phase 2（P0 対応版・レビュー待ち）

## BASELINE
- **BASELINE_MAIN_COMMIT = 7f3b46656b8c4c85d35717d4d9b432672f20e84c**（GitHub 最新 main のみ正本）。
- baseline = **376 pass / 2 existing fail**（SUN AND MOON 検索・今回修正禁止）。

## P0 対応（フロントの環境 URL 分離を完成）
### P0-1 自前 API を全経路 apiFetch へ統一
- 文字列リテラル `fetch("/api/...")` に加え、**変数経由・API_BASE・helper 内部**まで追跡して統一：
  - SUN AND MOON `auth-integration.js`：`SMApi`（`return apiFetch(url, opt)`）、`app-start`／`heartbeat`
    （`apiFetch(API_BASE + ...)`）。
  - `admin.js`：`apiGet`/`apiPut` の `fetch(path)`→`apiFetch(path)`。
- 外部 fetch（open-meteo / GSI / Google 等）は不変。Production は base="" で `/api/...` のまま。

### P0-2/P0-3 Platform navigation を appUrl で一元化
- `api-base.js` に `appUrl()` を追加（`apiUrl` と基底計算を共有・/dev 判定は 1 箇所）。
  - Production：`appUrl("/login/")==="/login/"`（不変）。DEV：`"/dev/login/"`。
- JS navigation（`location.href/assign/replace`）、要素 `.href/.action` 代入、JS 生成 `<a href="/...">`
  を全て `appUrl` 経由へ：`site.js`（ヘッダー/フッター/CTA/ログイン誘導/ロゴ/LOGOUT）、`auth.js`
  （signup emailRedirect / selector / dest||mypage / reset-password）、`admin.js`、`purchase/success`、
  `support`、`admin/users`、`admin/index`、`contact`、`migration/note`。
- 静的 HTML の `href/src/action` は DEV Worker の HTMLRewriter が `/dev` 前置（サーバ側）。

### P0-4 SUN AND MOON
- SMApi/app-start/heartbeat → DEV は `/dev/api/apps/sun-and-moon/*`。login→`/dev/login/`、
  no-entitlement→`/dev/products/sun-and-moon/`。Production 挙動は完全不変。

### P0-5 Admin
- apiGet/apiPut→apiFetch、非認証 redirect→`appUrl("/login/")`、一覧の detail リンク・warnings リンクも
  `appUrl` 経由。Admin だけ Production へ抜ける状態を解消。

### P0-6 静的監査 test（変数経由も helper 直接 test）
`test/dev_env.test.mjs`（12 件）：
- apiUrl/appUrl の Production 恒等・DEV 前置（直接 test）。SUNMOON 自前 API の /dev 解決。
- **静的監査**：`<script>` 内 JS に「素の自前 API fetch（`fetch("/api`・`fetch(API_BASE`）」「appUrl を通らない
  location/要素href/生成 `<a href>`」が残っていないこと（静的 markup は HTMLRewriter 管轄として除外）。
- auth-integration.js / admin.js の resolver 経由を個別固定。

## P1 訂正
Phase 2 初版の「fetch→apiFetch 全統一」は当時未完了だった。**本 P0 対応で、自前 Platform API の呼び出し
（文字列・変数・API_BASE・helper）を apiFetch へ、Platform navigation を appUrl へ実際に全統一した**。
再棚卸しの結果：
- **DEV UI から Production `/api` への自前リクエスト = 0**（静的監査 test で固定）。
- **DEV 内 navigation の Production root 脱出 = 0**（静的監査 test で固定）。
- **Production URL 挙動不変**（apiUrl/appUrl は base="" で旧 URL と完全一致・characterization test）。

## テスト結果
`npm test` = **390 / 388 pass / 2 fail（既存 SUN AND MOON のみ）＝新規 fail 0**。
`tsc --noEmit` exit 0。変更 JS（api-base/site/auth/admin/auth-integration）すべて `node --check` OK。
api-base.js は全 24 HTML で共有 JS より先行ロード（順序検証済み）。
Production wrangler `--dry-run`（top-level）成功・D1 `52a29812-...` 不変。

## 凍結（変更していない設計）
/dev/*→DEV Worker、ASSETS binding + prefix strip、Cloudflare Access、DEV D1 別 Database、Stripe Test、
Supabase Auth 共用、localStorage 共用、readonly R2 共用、X-Robots-Tag、develop→DEV / main→Production、
既存 baseline 2 fail（不修正）。アーキテクチャ再設計なし。

## 明言（指示 最終確認）
- 最新 Git main を baseline にした（commit 上記）。Production ロジック不変（新規 fail 0・dry-run 一致）。
- DEV UI→Production /api の自前リクエスト 0／DEV navigation の Production root 脱出 0／Production URL 挙動不変／
  新規 fail 0／typecheck 0／JS 構文 OK。
- D1 は DEV 専用／Stripe Test／Supabase Auth 共用／localStorage 共用／readonly R2 共用／DEV write は
  Production へ到達しない（fail-closed）／noindex／Production 既存 deploy 維持／Terrain・HANABI・3D 未変更。

## Cloudflare 側 human 手順（Claude 未実行）
DEV D1 作成＋id 置換／DEV Secrets（Stripe Test 等）／Route /dev/*／Cloudflare Access allowlist／
Workers Builds develop→DEV。CLOUDFLARE_DEV_SETUP.md ほか参照。

## 停止
deploy / commit / push / main 変更 / Production D1・Stripe・route 変更 / Cloudflare 設定変更は行っていない。

---
## 追補（レビュー指摘 P0-1 / P1-1 / P1-2 対応）
- **P0-1 Webhook×Access 衝突解消**：`POST /dev/api/stripe/webhook`（exact）のみ Cloudflare Access 対象外
  （Worker も `isDevWebhookExempt` で当該 path だけ Access JWT を要求しない）。認証境界は既存 Stripe 署名検証
  （Test）。前方一致では除外せず、webhook 以外は bypass しない。Production webhook ロジックは未変更。
- **P1-1 Worker で Access JWT 本検証**：`Cf-Access-Jwt-Assertion` を jose で検証（署名/issuer=TEAM_DOMAIN/
  audience=AUD）。payload.email 取得時のみ許可。env（DEV_ACCESS_TEAM_DOMAIN/AUD）不足・JWT 不正は fail-closed。
  ＝ Access policy（メール allowlist）＋ Worker JWT 検証の二段。
- **P1-2 docs/comment 同期**：wrangler.toml 冒頭を ADR-012（Local/DEV/Production）へ。CLOUDFLARE_DEV_SETUP は
  確定手順＋Stripe webhook Access Bypass 手順を追加。DEV_SECRETS は cookie 方式（DEV_ALLOWED_USER_IDS）を
  「不採用」と明示し、DEV_ACCESS_* を追加。
- **テスト A〜G**：`test/dev_access.test.mjs`（7 件）＝ webhook exempt（POST のみ）、issuer 解決、正 JWT→email、
  JWT 無→拒否、不正 JWT（署名/aud/issuer/email無/改ざん）→拒否、env 不足→fail-closed、resolve の
  ヘッダ有無。E（Stripe 署名不正→拒否）は既存 handleStripeWebhook（未変更）が境界として担保。
- テスト合計 **397 / 395 pass / 2 fail（既存 SUN AND MOON のみ）＝新規 fail 0**。tsc 0／変更 JS 構文 OK／
  Production dry-run 一致（D1 52a29812 不変・webhook route 未変更）。

---
## 追補（コメント同期 / Phase 4 手順確定）
- **src/index.ts コメント同期**：DEV shim 冒頭コメントを現実装へ更新（`Cf-Access-Jwt-Assertion` を jose で
  署名/issuer/audience/email 本検証、`POST /api/stripe/webhook` exact のみ Access 対象外＝Stripe 署名を境界）。
  **ロジックは一切変更していない**（非コメント行の差分なし・tsc 0・テスト不変）。
- **PHASE4_HUMAN_SETUP.md 新規**：DEV D1 作成→migration（--env dev 明示・実行前確認）→Secrets/Vars 完全一覧
  （共用/DEV 専用/Test/公開 Var/Secret 区分）→Access Application→**webhook exact path のみ Bypass（Access の
  method 非区別制約と Worker 二重防御を明記）**→DEV Worker/Route→route 優先順位の期待値表→Workers Builds
  （main 不変・develop 追加）→develop 初回作成→deploy 前チェック→smoke test A〜L→Stripe Test E2E→
  develop→main 昇格（migration 順序）→Rollback（DEV のみ撤去・Production 不変）を 1 工程ずつ収録。
- DEV_D1_SETUP / DEV_DEPLOY_FLOW / PRODUCTION_PROMOTION / ROLLBACK は PHASE4 を正本として参照する形へ更新。
- テスト合計 **397 / 395 pass / 2 fail（既存のみ）＝新規 fail 0**。tsc 0。変更 JS 構文 OK。Cloudflare 設定は未実行。

---
## 追補（DEV URL 解決の Production 脱出・根本修正）
- 症状: `/dev/purchase/success/` で apiBase 未定義・recover が Production `/api/purchases/recover` へ脱出。
- 根本原因: DEV URL 解決が外部 api-base.js のロード成功に単一依存する **fail-open** 構造（＋リダイレクト
  Location の /dev 未前置）。HTMLRewriter 自体は正常（miniflare で確認）。
- 修正（shim 1 箇所・最小構造的）: (1) DEV HTML の `<head>` 先頭へ resolver を **inline 注入**（外部ロード成否に
  依存しない＝fail-closed。api-base.js に冪等ガード）、(2) リダイレクト 3xx の Location を **/dev 前置**、
  (3) 既存の src/href /dev 前置は維持。Production は DEV_BASE_PATH 未設定で no-op（不変）。
- 検証: 実ランタイム miniflare 回帰（inline 注入・src/href 前置・Location 前置）＋横断監査（全ページ脱出 0）。
  全体 399/397 pass/2 fail（既存のみ）＝新規 fail 0。tsc 0。Production dry-run 一致。詳細 DEV_URL_RESOLUTION_FIX.md。
- 実機確認手順は DEV_URL_RESOLUTION_FIX.md に収録（recover が /dev/api へ向くこと等）。
