# DEV_URL_RESOLUTION_FIX — /dev の Production 脱出（apiBase 未定義）根本修正

BASELINE_MAIN_COMMIT = 7f3b46656b8c4c85d35717d4d9b432672f20e84c

## 症状
DEV の `/dev/purchase/success/` で購入完了が確定せず、`recover` が Production `/api/purchases/recover` へ 3 回 404
（INVALID_SESSION）。Console で `apiBase is not defined`。DEV D1 側の決済/権利付与は成功済み。

## 根本原因（構造的）
DEV の URL 解決が **外部ファイル `api-base.js` のロード成功に単一依存**し、失敗時に **fail-open（Production 脱出）**
する設計だった。正しく動くには「HTMLRewriter が script src を /dev へ書換 → ブラウザが /dev/assets/api-base.js を
200 取得 → 他スクリプトより前に実行」が全て成立する必要があり、どれか 1 つでも失敗すると
`window.apiBase/apiUrl/appUrl/apiFetch` が未定義になり、自前 API/navigation が素の `/api`・`/store/` へ流れて
Production へ脱出する。Production main には api-base.js が無く `/assets/api-base.js` は 404 になり得るため、脱出が
起きやすい。加えて **ASSETS のリダイレクト(3xx) Location が /dev 前置されていない**第 2 の脱出経路もあった。

（HTMLRewriter の書換ロジック自体は miniflare 実行で正常であることを確認済み。問題は「api-base.js が載らない時に
全解決が壊れる」構造。）

`T_CHECKOUT_ATTEMPT.TOTAL_AMOUNT=0 / EXPECTED_AMOUNT=0` は本脱出の直接原因ではない（checkout attempt 記録側の
別事象。recover の Production 脱出は resolver 未ロードが原因）。

## 修正（最小・構造的・shim 1 箇所。Production 不変／共通 resolver 維持／HTML の DEV 専用コピーなし）
1. **DEV HTML の `<head>` 先頭へ URL resolver を inline 注入**（`src/index.ts` handleDevRequest → `getApiBaseSrc`
   が api-base.js を ASSETS から一度取得しキャッシュ、`src/shared/dev_html.ts` `transformDevHtml` が
   `<head>` へ prepend）。→ 外部ファイルのロード成否に依存せず `apiBase/apiUrl/appUrl/apiFetch` が **必ず・最初に**
   定義される＝**DEV が fail-closed**。api-base.js に冪等ガード（`if(window.apiBase) return`）を追加し、外部版との
   二重実行を無害化（先勝ち）。
2. **リダイレクト(3xx) の Location を /dev 前置**（`dev_html.ts` `finalizeDevResponse`。ASSETS/route 双方）。→
   末尾スラッシュ等のリダイレクト脱出を封鎖。外部 URL の Location は不変。
3. HTMLRewriter による `src/href/action/poster` の /dev 前置は維持（CSS・画像・他 JS のサブリソースが DEV から
   読まれるため必要）。

Production は `DEV_BASE_PATH` 未設定で handleDevRequest が即 return＝**完全 no-op（挙動不変）**。

## 検証
- **実ランタイム（miniflare/workerd）回帰** `test/dev_shim_runtime.test.mjs`：実コード dev_html を workerd 上で実行し、
  (a) resolver が `<head>` 先頭へ inline 注入される、(b) 内部 src/href が /dev 前置・外部/hash 不変、
  (c) リダイレクト Location が /dev 前置・外部不変 を固定。
- 横断監査（要件 6）`test/dev_env.test.mjs` P0-6：success/cancel/store/mypage/login/signup/reset/admin/migration/
  sun-and-moon を含む public 全 JS/HTML に、素の自前 API fetch・appUrl 未経由の navigation・生成リンク脱出が
  無いことを固定（現状 0）。
- 全体 `npm test` = **399 / 397 pass / 2 fail（既存 SUN AND MOON のみ）＝新規 fail 0**。`tsc --noEmit` 0。
  api-base.js `node --check` OK。Production wrangler `--dry-run` 一致（D1 52a29812 不変）。

## 実機での確認手順（DEV 再 deploy 後）
1. `https://shingo-camera.com/dev/purchase/success/?session_id=cs_test_...` を Access 通過で開く。
2. DevTools Console: `apiBase()` → `"/dev"`（未定義でないこと）。`apiUrl("/api/purchases/recover")` →
   `"/dev/api/purchases/recover"`。
3. DevTools Network: `recover` の Request URL が `https://shingo-camera.com/dev/api/purchases/recover`（Production
   `/api/...` へ出ていないこと）。レスポンスで購入完了が確定。
4. ページソースの `<head>` 先頭に inline `<script>`（resolver）があり、`<script src="/dev/assets/api-base.js">` も
   /dev 前置されていること。全レスポンスに `X-Robots-Tag: noindex, nofollow`。
5. `/dev/purchase/success`（末尾スラッシュ無）でアクセス → `Location` が `/dev/purchase/success/`（/dev 付き）に
   なり Production へ飛ばないこと。
6. Production 側 `https://shingo-camera.com/store/` 等が従来どおり正常（inline 注入なし・/api のまま）。
