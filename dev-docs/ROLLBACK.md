# ROLLBACK — 各層の切り戻し

- **DEV code**：develop を直前 commit へ revert→push（DEV のみ再 deploy）。または Cloudflare で DEV Worker を
  前バージョンへ rollback。
- **DEV D1 migration**：前進 migration 方針のため安易な down は前提にしない。DEV D1 は再作成が容易
  （`d1 create`→migrations apply→seed）なので、壊れたら **DEV D1 を作り直す**のを第一手とする。
- **DEV Worker**：Cloudflare の Deployments から前バージョンへ rollback。
- **DEV route**：Route `shingo-camera.com/dev/*` を無効化すれば DEV 入口が閉じる（Production は無影響）。
- **Production 昇格後の code**：main を直前へ revert→push（Production 再 deploy）。または Cloudflare
  Deployments で前バージョンへ rollback。
- **Production DB migration**：現行 Platform の migration 方針（前進）に従い、down を前提にしない。必要時は
  補正 migration を前進で当てる。Production D1 のバックアップ/point-in-time は Cloudflare の機能に従う。


---
> 本手順の**最終確定版・1工程ずつの再現手順**は `PHASE4_HUMAN_SETUP.md` STEP 15（DEV のみ撤去・Production 不変） を正本とする。
> 本ファイルは方針の要約。実施時は PHASE4 を参照。
