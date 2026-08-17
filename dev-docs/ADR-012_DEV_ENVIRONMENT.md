# ADR-012: 正式 DEV 環境の追加（ADR-011 を supersede）

Status: Proposed（レビュー承認後 Accepted）
Supersedes: ADR-011_LOCAL_AND_PRODUCTION_ONLY（「Local と Production のみ・Staging を作らない」方針）

## Context
ADR-011 は環境を Local / Production の 2 つに限定していた。しかし Platform（SUN AND MOON / HANABI /
Store / MyPage / 認証 / API / D1 / 将来の 3D・Terrain v2）を本番反映前に実機（PC/iPhone）で確認し、
確認済みのものだけを Production へ昇格する運用が必要になった。本番で試して直す運用を避ける。

## Decision
正式方針を **Local / DEV / Production** の 3 環境へ変更する。
- Production：main → Production Worker → `https://shingo-camera.com/*`（現状維持・不変）。
- DEV：develop → DEV Worker → `https://shingo-camera.com/dev/*`（新設）。
- 同一コードベースを wrangler environment（`[env.dev]`）で 2 Worker へ deploy（public/dev への手作業
  コピーはしない）。DEV Worker は env-gated prefix-strip shim + ASSETS binding で同一 `public/` を配信。
- DEV は Cloudflare Access（メール allowlist）で前段保護し、指定ユーザーのみ利用可（HTML/API とも）。
- D1 は DEV 専用 Database、Stripe は Test、Supabase Auth と localStorage と読み取り R2 は共用。
- DEV binding/secret 不足時は Production へ fallback せず fail-closed。

## Consequences
- Production 経路（custom domain / D1 / Route / main 自動 deploy）は変更しない。
- develop push は DEV のみ、main push は Production のみ更新（相互不干渉）。
- ADR-011 の「Staging を作らない」は本 ADR で置換されるが、ADR-011 の記録自体は改変・削除しない。
