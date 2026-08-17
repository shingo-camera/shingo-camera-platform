# TEST_REPORT — 正式 DEV 環境 Phase 2

BASELINE_MAIN_COMMIT = 7f3b46656b8c4c85d35717d4d9b432672f20e84c

## 合格条件（指示 D5）
「既存 2 fail（SUN AND MOON 検索）は修正禁止。DEV 変更による新規 fail 0」。

## baseline（無変更 clone 時）
`npm test` = **378 tests / 376 pass / 2 fail**。失敗 2 件（今回修正禁止）：
1. `実 /api/chance：pinpoint 全件 m≤30・上端中央近傍（altPct≈100）・全件収束`
2. `P0-1/P0-2: 月chanceで、真の日別最小moveMをエンドポイントが落とさず代表もmoveM最小`

## Phase 2 実装後
`npm test` = **397 tests / 395 pass / 2 fail**。
- 追加テスト `test/dev_env.test.mjs`（12 件）はすべて pass。
- 失敗は上記 baseline の 2 件のみ。**DEV 変更による新規 fail = 0**（合格）。
- `tsc --noEmit` exit 0（typecheck 通過）。`public/assets/api-base.js` は `node --check` 構文 OK。
- Production wrangler `--dry-run`（top-level）成功：Worker `shingo-camera-platform`・D1 `env.DB
  (shingo-camera-platform)`・database_id `52a29812-...` 不変。`[env.dev]` 追加は top-level ビルドへ影響なし。

## 追加テスト内容（dev_env.test.mjs）
- [D4] Production で apiBase=""・apiUrl が既存 `/api/...` と完全一致（挙動不変）。
- [D4] DEV(/dev 配下)で apiBase="/dev"・`/api`→`/dev/api` へ解決。
- [D4] apiUrl は外部 URL・非 /api・既 /dev を変換しない。
- [D2] stripDevPrefix：/dev 除去（配下外 null）。
- [D2] devPrefixAttr：ルート相対のみ /dev 前置（外部/既済/hash/相対は不変）。

## 実 Cloudflare でのみ検証可能（Phase 4・human step 後）
Route `/dev/*`→DEV Worker、Cloudflare Access allowlist、ASSETS.fetch、HTMLRewriter による資産 prefix、
DEV D1 分離、Stripe Test、X-Robots-Tag、DEV badge の実挙動。指示 19 A〜R のうちサーバ実行が要るものは
DEV デプロイ後に確認する（本 Phase では純関数・wrapper・no-op 設計・非回帰を offline で固定）。
