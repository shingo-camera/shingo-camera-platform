HANABI_PLATFORM_ADAPTATION_REPORT

HANABI 凍結完成版（windworldfixed-migration-rev2）を現行 Platform 正本 `2cd7bc5` へ適応した報告。
現行 Platform を土台に、HANABI 凍結版の必要差分だけを移植した。
HANABI の仕様・アルゴリズム・計算結果は一切変更していない。
Git commit / push / Cloudflare deploy は行っていない。

==================================================
1. 適応方針（現行 Platform が正本）
==================================================
- 現行 Platform `2cd7bc5` を土台とし、HANABI 凍結版の差分だけを移植した。
- HANABI 凍結版を土台にして現行変更を戻す方式は採っていない。
- SUN AND MOON / src/shared / src/routes / migrations / wrangler.toml / package.json は
  現行のまま（バイト一致・巻き戻しなし）。
- DEV/Production 分離・DEV route・Cloudflare Access・APP_BASE_URL・fail-closed は現行を完全維持。

==================================================
2. 変更ファイル一覧（current → adapted）
==================================================
■ semantic merge（現行を正とし HANABI 差分だけ追加）: 3 ファイル
  - src/index.ts                      … HANABI import 3 行 + route 4 本を SAM route の直後に追加
  - test/build-test-bundle.mjs        … HANABI server core の test bundle 4 本を追加
  - public/assets/site-config.js      … HANABI.appUrl を null → "/apps/hanabi/"（1 行のみ）

■ 新規追加（HANABI 固有・現行に存在しない）
  - public/apps/hanabi/{index.html, auth-integration.js, scene-request-manager.js, terrain-request.js}
  - public/products/hanabi/index.html
  - src/apps/hanabi/{app_start.ts, compute.ts, earth.ts}
  - src/apps/hanabi/core/{hanabi_calc.ts, scene.ts, terrain.ts, terrain_tiles.ts, png.ts, validate.ts}
  - test/_terrain_fixture.mjs + hanabi_*.test.mjs（21 ファイル）

■ 非変更（バイト一致・巻き戻しなし）
  - src/apps/sun-and-moon/**（SAM src 全一致）
  - public/apps/sun-and-moon/**（SAM public 全一致）
  - src/shared/**・src/routes/**（全一致）
  - migrations/**・wrangler.toml・package.json・tsconfig.json（全一致）

==================================================
3. 各共通ファイルの semantic merge 内容
==================================================
■ src/index.ts
  - import 追加（SAM heartbeat import の直後）:
      handleHanabiAppStart / handleHanabiEarthEntitlement / handleHanabiSceneSolve / handleHanabiTerrainSolve
  - route 追加（`/api/apps/sun-and-moon/` ハンドラの直後・Admin ブロックの前。凍結版と同一配置）:
      POST /api/apps/hanabi/app-start        → handleHanabiAppStart
      GET  /api/apps/hanabi/earth-entitlement → handleHanabiEarthEntitlement
      POST /api/apps/hanabi/scene-solve      → handleHanabiSceneSolve
      POST /api/apps/hanabi/terrain-solve    → handleHanabiTerrainSolve
  - 既存ルートの判定順・return 経路・DEV prefix / Access 処理は変更していない。
  - HANABI ハンドラは現行 shared（requireProduct / recordAppStartAccess / AuthError / AppError /
    jsonOk / jsonError）・現行 Env（ADMIN_AUTH_USER_ID 等）とそのまま互換（typecheck 0 error で確認）。
    新 binding / 新 secret / 新 env var は不要。

■ test/build-test-bundle.mjs
  - 現行の purchase_logic / support_validate / dev_* bundle を維持し、
    HANABI server core bundle（hanabi_calc / hanabi_scene / hanabi_terrain / hanabi_validate）を追加。
  - 凍結版で丸ごと置換していない（現行の dev bundle を保持）。

■ public/assets/site-config.js
  - HANABI.appUrl のみ null → "/apps/hanabi/" に変更（Platform 統合済みを示す）。
  - HANABI_GOOGLE_EARTH.appUrl は null のまま（add-on であり単独アプリではない・凍結版と一致）。
  - SUN AND MOON note URL その他現行設定は一切変更していない。

==================================================
4. 凍結 HANABI から意図的に変更した箇所（DEV prefix 適応のみ）
==================================================
現行 Platform の DEV（/dev/ 配下）配信では、client は api-base.js の apiFetch/appUrl を通して
API/navigation を解決する（SUN AND MOON が正本。Production では apiBase()==="" で従来と完全同一）。
HANABI 凍結版は素の fetch / 絶対パス navigation だったため、SAM と同一方式へ適応した
（第二の独自方式は作っていない）。HANABI の仕様・認証条件・遷移先の意味・計算ロジックは不変。

■ public/apps/hanabi/auth-integration.js
  - 素の fetch("/api/...") 4 箇所 → apiFetch(...)（config / app-start / earth-entitlement / callCompute）。
  - redirect 4 箇所を appUrl(...) 経由へ:
      window.location.href = appUrl(LOGIN_URL) + "?redirect=..."（未ログイン 2 箇所）
      window.location.href = appUrl(NO_ENTITLEMENT_URL)（権限なし 1 箇所）
      login.href = appUrl(LOGIN_URL) + "?redirect=..."（エラー UI のログインリンク 1 箇所）
  - 遷移先の意味は不変（未ログイン→/login/、権限なし→/products/hanabi/）。fail-closed 条件も維持。

■ public/apps/hanabi/index.html
  - <head> 先頭に <script src="/assets/api-base.js"></script> を追加（apiFetch/appUrl を他script前に定義）。
  - Google Earth add-on ゲートの Store 誘導 3 箇所を window.location.href = appUrl('/store/') へ。
  - 計算・描画・state・localStorage schema・export/import schema・KML・terrain・scene logic は不変。

■ public/products/hanabi/index.html
  - <head> に <script src="/assets/api-base.js"></script> を追加（現行 SAM 商品ページと同一 shell へ適応）。
  - 共通 shell（site.css / site-config.js / site.js / supabase.js / #site-header / #site-footer）は
    現行商品ページ構造と一致。HANABI 固有内容は保持。

■ HANABI core/server は frozen とバイト一致（非変更）
  - hanabi_calc.ts / scene.ts / terrain.ts / terrain_tiles.ts / png.ts / validate.ts /
    app_start.ts / compute.ts / earth.ts / scene-request-manager.js / terrain-request.js …
    すべて凍結版とバイト一致。world-fixed 風計算・scene・terrain・KML・public secrecy は完全維持。

==================================================
5. テスト結果
==================================================
- typecheck（tsc --noEmit）… 0 error。
- npm test … 595 tests / 583 pass / 12 fail。
- HANABI テスト（hanabi_*.test.mjs）… 全 pass（fail 0）。
- clean ZIP 再展開でも同一（typecheck 0 / HANABI 全 pass / 新規 fail 0）を確認。

■ 既知 baseline fail と新規 fail の区別
  - clean 現行 Platform（HANABI 追加なし）baseline … 420 tests / 12 fail。
  - 適応後 … 595 tests / 12 fail。
  - **新規 fail = 0**（baseline の 12 fail と完全一致）。
  - 既知 12 fail は全て SUN AND MOON / Platform / checkout 系（HANABI 無関係・今回対象外）:
      月chance 日別最小moveM / active-checkout 3 件 / site.js checkout 3 件 / initStore /
      targetOffset 一本化 / 固有建物UI・選択ガード 2 件 / __smKmzDebug / topWidth リセット。
  - assertion を緩めて通した箇所は無い。
  - 適応中に一時的に 13 fail（新規 1: dev_env.test の appUrl navigation 検査）となったが、
    HANABI client の /login/・/products/hanabi/・/store/ navigation を appUrl(...) 経由へ適応して解消。

==================================================
6. 最終監査（§13）
==================================================
■ HANABI
  - HANABI app 存在（public/apps/hanabi/index.html）… OK
  - HANABI product page 存在（public/products/hanabi/index.html）… OK
  - app-start route 接続 … OK（/api/apps/hanabi/app-start）
  - compute route 接続 … OK（scene-solve / terrain-solve）
  - Earth/KML route 接続 … OK（earth-entitlement）
  - entitlement gate 維持 … OK（app_start/compute/earth で requireProduct）
  - scene server-authoritative 維持 … OK（compute.ts が solveScene 実行）
  - terrain server-authoritative 維持 … OK（compute.ts が solveTerrain 実行）
  - world-fixed 風計算維持 … OK（windDriftWorld: scene.ts/hanabi_calc.ts。core バイト一致）
  - public secrecy 維持 … OK（public に calcWindOffset / windDriftWorld / WIND_ALT_FACTOR / seed = 0）
  - KML parity 維持 … OK（hanabi_kml_parity / hanabi_kml_kunitomo 全 pass）
  - localStorage / export/import 互換維持 … OK（hanabi_data_compat / phaseD_compat 全 pass・index.html core 不変）

■ Platform（巻き戻していないこと）
  - SUN AND MOON 差分なし（src/public バイト一致）… OK
  - src/shared/* を旧版へ戻していない（バイト一致）… OK
  - src/routes/* を旧版へ戻していない（バイト一致）… OK
  - migrations 変更なし（バイト一致）… OK
  - Production/DEV D1 分離維持（wrangler.toml バイト一致・[env.dev] 保持）… OK
  - DEV route / Cloudflare Access 維持（wrangler・index.ts の DEV 処理不変）… OK
  - APP_BASE_URL / workers_dev=false 等 Production 方針維持 … OK
  - Stripe / 購入処理 巻き戻しなし（routes/purchases・shared 不変）… OK
  - note 導線 / robots / noindex 巻き戻しなし（site-config の SAM note・dev_html 不変）… OK

==================================================
7. DEV 実機確認で見るべき項目（次工程）
==================================================
本作業は commit/push/deploy を行わないため、以下は DEV 反映後に実機確認する:
  - /apps/hanabi/ が DEV（/dev/apps/hanabi/）で表示され、app-start が /dev/api/apps/hanabi/app-start へ解決される。
  - 未ログイン → /dev/login/?redirect=... へ、権限なし → /dev/products/hanabi/ へ遷移する（appUrl 経由）。
  - Google Earth add-on 未所有時の Store 誘導が /dev/store/ へ向く。
  - Production（/apps/hanabi/）では従来どおり /api/... /login/ /store/ へ（apiBase()==="" で不変）。
  - scene-solve / terrain-solve が requireProduct(HANABI) で保護され、KML 出力が world-fixed 結果で一致。
  - 商品ページ /products/hanabi/ が現行 site shell（header/footer/購入導線）で表示される。

==================================================
8. 成果物 / 禁止事項
==================================================
- 現行 Platform へ HANABI を適応済みの ZIP を提出（node_modules / test/_bundle 除外・secret 非混入）。
- Git commit / push / Cloudflare deploy は行っていない。
- HANABI 仕様・アルゴリズム・計算結果の再設計・再実装はしていない。
- 「凍結版と違う」だけを理由に現行共通ファイルを置換していない。
