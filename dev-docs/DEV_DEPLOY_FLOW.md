# DEV_DEPLOY_FLOW —（人間が実施）develop→DEV / main→Production

## branch
- `develop` を開発 branch とする（Claude は branch 作成・push をしない）。
  `git checkout -b develop && git push -u origin develop`。

## 自動 deploy
- Cloudflare Workers Builds を **2 本**用意：
  1. 既存：main → Production Worker（現状のまま・変更しない）。
  2. 追加：develop → DEV Worker（`wrangler deploy --env dev` 相当のビルドコマンド）。
- これにより **develop push は DEV のみ**、**main push は Production のみ**更新（相互に影響しない）。

## 手動 deploy（必要時）
- DEV：`npm run deploy -- --env dev`（`wrangler deploy --env dev`）。
- Production：従来どおり（`wrangler deploy`）。DEV 追加で Production 経路は変えない。

## 確認
- develop push 後、`https://shingo-camera.com/dev/` が更新され、`https://shingo-camera.com/` は不変であること。


---
> 本手順の**最終確定版・1工程ずつの再現手順**は `PHASE4_HUMAN_SETUP.md` STEP 9/10（Workers Builds develop→DEV・develop 初回作成） を正本とする。
> 本ファイルは方針の要約。実施時は PHASE4 を参照。
