# DEV_D1_SETUP —（人間が実施）DEV 専用 D1 の作成と migration

## STEP 1 DEV D1 作成
- `wrangler d1 create shingo-camera-platform-dev` を実行し、出力の database_id を控える。
- `[env.dev]` の `[[d1_databases]] binding="DB" database_name="shingo-camera-platform-dev" database_id=<新ID>`
  に設定（Phase 2 proposal）。**Production の database_id（52a29812-...）は絶対に流用しない**。

## STEP 2 schema 構築（Production 相当）
- `wrangler d1 migrations apply shingo-camera-platform-dev --remote --env dev` で 0001〜0008 を適用。
- 破壊的 down は前提にしない（現行 migration 方針に合わせ、前進 migration で管理）。

## STEP 3 初期データ（seed）
- Production D1 のユーザーデータは丸ごとコピーしない。DEV 動作に必要なのは：
  - **商品定義 M_PRODUCT**（SUN AND MOON / HANABI 等・Stripe **Test** の Price ID）。
  - 自分の DEV テスト権限（entitlement）。必要なら seed SQL を作る（Phase 2 で提示）。
- Production から何をコピーするか/seed のみで足りるかは、M_PRODUCT と entitlement の実カラムを Phase 2 で確定。

## 標準フロー
DEV migration → DEV で確認 → 合格 → Production migration → Production 反映（Production D1 を開発確認のために
直接 ALTER しない）。


---
> 本手順の**最終確定版・1工程ずつの再現手順**は `PHASE4_HUMAN_SETUP.md` STEP 3（DEV D1 作成・--env dev 明示・seed） を正本とする。
> 本ファイルは方針の要約。実施時は PHASE4 を参照。
