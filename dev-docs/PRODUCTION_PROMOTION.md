# PRODUCTION_PROMOTION — DEV 確認済みを Production へ昇格

## 標準手順
1. develop 最新を DEV へ自動 deploy。
2. PC / iPhone で `https://shingo-camera.com/dev/...` を実機確認（登録地点そのままで検証）。
3. テスト green（既存 regression＋当該変更のテスト）。
4. **DB migration が必要な変更**は先に順序を確定：
   - スキーマ追加（後方互換）→ 先に Production migration → その後コード deploy。
   - コードが新カラム前提の場合、migration→deploy の順を厳守（逆順で本番エラー）。
5. `develop → main` merge（PR）。
6. main push で Production 自動 deploy。
7. Production smoke test（/api/health, ログイン, 主要導線）。

## 原則
本番で試して直すのではなく、**DEV で確認済みのものだけ**を main へ。migration とコードの依存順序を必ず明記。


---
> 本手順の**最終確定版・1工程ずつの再現手順**は `PHASE4_HUMAN_SETUP.md` STEP 14（develop→main 昇格・migration 順序） を正本とする。
> 本ファイルは方針の要約。実施時は PHASE4 を参照。
