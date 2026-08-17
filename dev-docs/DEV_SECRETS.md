# DEV_SECRETS —（人間が実施）DEV Worker の Secrets / Vars（fail-closed）

`wrangler secret put <NAME> --env dev` で **DEV Worker にのみ**登録（Production Secret は変更しない）。
不足時は Production へ fallback せず **fail-closed**。

## Vars（[env.dev.vars]・非秘密）
- `APP_ENV=development`（DEV badge / health）
- `DEV_BASE_PATH=/dev`（prefix-strip shim の有効化キー。Production では未設定＝no-op）
- `APP_BASE_URL=https://shingo-camera.com/dev`（Stripe Test の success/cancel 用）
- `DEV_ACCESS_TEAM_DOMAIN`（例 "myteam" → issuer https://myteam.cloudflareaccess.com）
- `DEV_ACCESS_AUD`（Access Application の Audience(AUD) タグ）
  ※ DEV_ACCESS_* は Worker 側の Access JWT 本検証（署名/issuer/aud）に使用。不足時 fail-closed。

## Secrets（Test/DEV 値のみ）
- `STRIPE_SECRET_KEY`（**sk_test_…**）／`STRIPE_WEBHOOK_SECRET`（**Test webhook**。webhook の認証境界）
- `SUPABASE_URL` / `SUPABASE_ANON_KEY`（Auth 共用のため Production と同値でよい）
- `ADMIN_AUTH_USER_ID`（DEV で admin 検証が要る場合）／`SESSION_ID_HASH_SECRET` / `MAIL_API_KEY` 等は必要範囲で。

## 不採用（採用しない代替案・混乱防止のため明記）
- **アプリ層の署名付き DEV cookie 方式は不採用**。したがって `DEV_ALLOWED_USER_IDS` 等の
  アプリ内 allowlist env は**設けない**。DEV 利用者制御は **Cloudflare Access のメール allowlist（Zero Trust 側）**
  ＋ **Worker の Access JWT 本検証**の二段に一元化する。
