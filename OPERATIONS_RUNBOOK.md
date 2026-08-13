# shingo_camera LABO 運用・テスト手順書（OPERATIONS RUNBOOK）

本書は Platform（Cloudflare Workers + D1 + Supabase Auth + Hosted Stripe Checkout）の運用・テスト手順をまとめる。
コマンド例・レスポンス形式は実装（`src/`）に基づく。**commit / push / deploy はしんごさん自身が行う**。本書に破壊的操作を含む項目は、実行前に対象環境（Local / Test / Production）を必ず確定すること。

対象環境の呼称は `APP_ENV`（`local` / `test` / `production`）で区別する。

---

## 収録トピック

1. 商品追加
2. 価格変更・セール
3. 販売 ON/OFF
4. 商品依存関係
5. 購入 E2E リセット（テストユーザー購入状態リセット）
6. ユーザー完全削除
7. note 復元データ初期化
8. Local/Test/Production D1 migration
9. Stripe Test/Live Price 設定
10. SESSION_ID_HASH_SECRET 設定
11. 補足：正本テーブルと識別子早見表

---

## 5. 購入 E2E リセット（テストユーザー購入状態リセット）★最頻用

Local/Test で「購入 → reset → 再購入」を反復試験するための正規手順。**DB を手動 DELETE する代替として、このAPIを優先する。**

### 正本実装
- API: `POST /api/admin/test/reset-purchases`
- 実装: `src/routes/admin_test.ts`（`handleAdminResetPurchases` / `deletePurchaseStateForUser`）

### リクエスト
- ボディ: `{ "authUserId": "<対象AUTH_USER_ID>" }`（`{ "email": "<対象メール>" }` でも可。AUTH_USER_ID を正本に解決する）
- ヘッダ: `Authorization: Bearer <Admin JWT>` / `X-Device-Id: <deviceId>` / `Content-Type: application/json`

### Admin 画面ブラウザ Console からの実行
Admin 画面（ログイン済み）を開き、ブラウザの開発者ツール Console で実行する。
既存 `public/admin/assets/admin.js` が公開する `AdminUI.getToken()` と `AdminUI.deviceId` を使う。

```js
const token = await AdminUI.getToken();

await fetch("/api/admin/test/reset-purchases", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + token,
    "X-Device-Id": AdminUI.deviceId,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    authUserId: "<対象AUTH_USER_ID>"
  })
}).then(async r => ({
  status: r.status,
  body: await r.json()
}));
```

### 正常時の確認
- `status: 200` かつ レスポンス `body` が `{ "result": "OK", "data": { "authUserId": "...", "deleted": { ... } } }` であること。
  - `deleted` は削除した各テーブルの件数（userProducts / purchases / orders / checkoutAttempts / checkoutAttemptItems / checkoutLocks / paymentEvents）。
- その後 **Admin 画面を再読込**し、対象ユーザーの保有商品（entitlement）が消えていることを確認する。

### このAPIが削除する範囲（実装準拠）
`deletePurchaseStateForUser` が対象 AUTH_USER_ID について削除するのは以下（FK を考慮した子→親の順・D1 batch で全 rollback 保証）:
1. T_USER_PRODUCT
2. T_PURCHASE
3. T_PAYMENT_EVENT（AUTH_USER_ID または対象 ORDER 経由）
4. T_ORDER
5. T_PRODUCT_CHECKOUT_LOCK
6. T_CHECKOUT_ATTEMPT_ITEM（ATTEMPT_ID 経由）
7. T_CHECKOUT_ATTEMPT

> active な Checkout attempt（CREATING/OPEN）がある場合、Stripe 側の状態を確認し、状態不明なら中止する（部分削除を作らない）。open は expire 成功後のみ削除。

### このAPIが**削除しない**もの（重要）
- **T_LOGIN_LOG / T_ACCESS_LOG / T_WARNING**（ログ・不正検知履歴）
- **T_NOTE_PURCHASE**（note 復元台帳。トピック7参照）
- **M_USER 本体**（ユーザーは残る。トピック6参照）
- **Supabase Auth ユーザー自体**（Platform からは削除しない）
- **Stripe 側の決済履歴そのもの**（このAPIは Stripe の決済を消す機能ではない）

### 注意事項
- **Local/Test 専用 API**。`isResetAllowedEnv` が `APP_ENV === "local" | "test"` のみ true。
- **Production では利用不可**：`APP_ENV === "production"` では機能の存在を隠すため **404（PRODUCTION_FORBIDDEN）** を返す。
- **Admin JWT 必須**：環境ガード通過後も `requireAdmin` が必須。
- **`Authorization` を付けない単純な `fetch()` は 401** になる（UNAUTHORIZED）。Admin 以外の JWT は 403（FORBIDDEN）。
- **Supabase Auth ユーザー自体は削除しない**（再ログイン・再購入に使い回せる）。
- **購入 → reset → 再購入の反復試験用**。
- **DB を手動 DELETE する代替として、このAPIを優先する**（FK 順序・rollback を実装が保証するため手動より安全）。
- **Stripe 側の決済履歴そのものを削除する機能ではない**（Stripe Dashboard 側は別途 Test Mode のデータ管理で対応）。

---

## 6. ユーザー完全削除

テストユーザーを Platform から完全に消す手順。**購入E2Eリセット（トピック5）はユーザー本体・ログ・note台帳を消さない**ため、完全削除は追加作業が必要。

### 残すユーザー（削除しない）
- Admin アカウント（`env.ADMIN_AUTH_USER_ID` に一致する AUTH_USER_ID）
- 運用者本人の通常ユーザーアカウント

上記2つの AUTH_USER_ID を先に確定し、それ以外を削除候補とする。

### AUTH_USER_ID に紐づく全テーブル（12）と削除順序（FK考慮・CASCADEなし＝子→親）
1. T_USER_PRODUCT
2. T_NOTE_PURCHASE の該当行（MATCH_AUTH_USER_ID＝対象。トピック7と統合可）
3. T_PURCHASE
4. T_PAYMENT_EVENT（AUTH_USER_ID / ORDER_ID 経由）
5. T_ORDER
6. T_PRODUCT_CHECKOUT_LOCK
7. T_CHECKOUT_ATTEMPT_ITEM（ATTEMPT_ID 経由）
8. T_CHECKOUT_ATTEMPT
9. T_WARNING
10. T_ACCESS_LOG
11. T_LOGIN_LOG
12. 最後に M_USER

> 1・3〜8 はトピック5の reset API でほぼ実行できる。**9〜12 と T_NOTE_PURCHASE は reset に含まれず、別途の DELETE が必要**。かつ reset は Local/Test のみ。Production の完全削除は現状ツールに無く、実施する場合は専用処理の実装合意が必要。

### Supabase Auth 側の扱い（区別）
- Platform D1 の M_USER と Supabase Auth ユーザーは別物。M_USER は Supabase sub をキーにした同期レコード。
- **Platform には Supabase Auth ユーザーを削除するコードは無い**。D1 の M_USER を消しても Auth 側は残る。
- 完全削除するなら **Supabase ダッシュボード（または Auth Admin API）で Auth ユーザーも別途削除**する。D1 と Auth の両方を消して初めて完全。

---

## 7. note 復元データ初期化（HANABI 販売開始前）

### データの流れ
1. CSV 取込（`note_import`）→ T_NOTE_PURCHASE に INSERT（NOTE_TRANSACTION_ID 冪等キー・MATCH_STATUS=0 未使用）
2. 利用者が「商品 + note 取引ID」で復元（`note_migration`）→ 照合成立で T_PURCHASE（PURCHASE_SOURCE=1）/ T_USER_PRODUCT（GRANT_TYPE=1）を作成し、T_NOTE_PURCHASE を MATCH_STATUS=1 に更新（D1 batch）

### 初期化方針（本番開始前の未使用状態へ戻す）
1. 公開の復元導線を一時非表示（`public/migration/note/index.html`、mypage の `#note-migration` は site.js が条件表示）
2. **T_NOTE_PURCHASE を全クリア（案X）**。CSV から完全再生成できるため最もクリーン
3. 復元で生成した T_PURCHASE（SOURCE=1）/ T_USER_PRODUCT（GRANT_TYPE=1）をクリーンアップ（トピック6のユーザー削除に含めれば重複処理不要）
4. **テーブル定義・API・CSV取込機能・note_migration は残す**
5. 販売開始前に正本 CSV を再取込（Admin の note 取込機能）
6. 取込件数・全行 MATCH_STATUS=0（未使用）を確認
7. 復元導線を再表示

### CSV 再取込で完全復旧できる根拠
`note_import` は NOTE_TRANSACTION_ID を冪等キーとした増分 INSERT（同一CSV再投入・複数月・順不同でも既存を壊さず新規のみ INSERT）。T_NOTE_PURCHASE を空にしても正本 CSV 再取込で取込対象行が完全再生成される（MATCH_STATUS=0）。

### トピック5/6との重複
T_NOTE_PURCHASE / T_PURCHASE(SOURCE=1) / T_USER_PRODUCT(GRANT_TYPE=1) は「ユーザー削除」と重複する。**テストユーザーを AUTH_USER_ID 単位で完全削除すれば復元結果は消える**。CSV取込台帳（T_NOTE_PURCHASE）はユーザーに紐づかないため案Xで別途クリアする。

---

## 8. Local/Test/Production D1 migration

- migration は `migrations/NNNN_*.sql`。**追加型のみ（CREATE TABLE / ADD COLUMN / CREATE INDEX）で既存を書き換えない**運用。
- 現行は **0001〜0008**。0007（商品販売列）・0008（商品依存）が新しい。
- **0007 の ADD COLUMN は SQLite の仕様上 IF NOT EXISTS 不可＝初回のみ適用**。二重適用しない。
- 0008 の seed は `INSERT OR IGNORE`＝再適用安全。
- **DB定義（migration で作られる）と DBデータ（seed / 手動設定）を区別する**：
  - migration で作られる: 各テーブル・列・CHECK・INDEX
  - seed で入る: 0007（PURCHASE_ENABLED / SALE_TYPE / DISPLAY_PRICE の UPDATE）、0008（EARTH→HANABI 依存）
  - **seed で入らない・手動設定が必要**: M_PRODUCT.STRIPE_PRICE_ID（トピック9）
- 適用は各環境（Local / Test / Production）の D1 に対して個別に行う。Production 適用済みか否かはコードから判断できない＝Production の実状態を確認してから適用する。

---

## 9. Stripe Test/Live Price 設定

- **販売可否の正本は M_PRODUCT.PURCHASE_ENABLED、表示価格は DISPLAY_PRICE、Stripe Price ID は M_PRODUCT.STRIPE_PRICE_ID、実課金額は Stripe Price**（商品別 `STRIPE_PRICE_*` 環境変数は廃止済み）。
- 手順:
  1. Stripe Dashboard で Price を作成（Test Mode Price / Live Mode Price）
  2. 対象環境の D1 で `M_PRODUCT.STRIPE_PRICE_ID` を手動 UPDATE（**Test 環境には Test Price、Production には Live Price。混在禁止**）
  3. Live は Webhook endpoint を登録し Webhook Secret を設定
- fulfill は T_CHECKOUT_ATTEMPT_ITEM.STRIPE_PRICE_ID の snapshot を正本に Price→商品コードを逆引きする（Price 変更後も旧 Checkout Session を正しく fulfill）。snapshot が invalid のときは安全側でエラーにし fallback しない。
- 部分 UNIQUE INDEX `UX_PRODUCT_STRIPE_PRICE_ID` により、非空の STRIPE_PRICE_ID は一意。

---

## 10. SESSION_ID_HASH_SECRET 設定

- 用途: 検証済み Supabase JWT の session_id を HMAC-SHA256 して T_ACCESS_LOG.SESSION_ID_HASH に保存（生 session_id は保存しない）。アカウント共有・多地点利用検知の補助。
- **Production 必須設定**。未設定でもアプリは fail-open で動作しログ記録は継続するが、SESSION_ID_HASH が NULL になり session 識別が実質無効になる。
- 手順:
  1. 十分長いランダム値を生成（例: `openssl rand -hex 32`）
  2. **Local/Test と Production で別の値**を使う（環境間でハッシュを突き合わせられないように）
  3. Local/Test は `.dev.vars`、Production は Cloudflare Secret に設定
  4. **実値をソース・README・ZIP・Git/toml へ含めない**
  5. Production で app-start / entitlement-check / heartbeat 実行後、T_ACCESS_LOG.SESSION_ID_HASH が NULL でなく `v1:` 形式で記録されることを確認

---

## 1. 商品追加

- 商品は M_PRODUCT が正本。追加時は PRODUCT_CODE / PRODUCT_NAME / SORT_NO と、販売列（PURCHASE_ENABLED / SALE_TYPE / DISPLAY_PRICE / BILLING_INTERVAL / STRIPE_PRICE_ID）を設定する（DISPLAY_ORDER は廃止・SORT_NO に一本化）。
- 販売するなら PURCHASE_ENABLED=1 とし、STRIPE_PRICE_ID を各環境で手動設定（トピック9）。
- 既存の商品追加は seed / 手動 INSERT で行い、コード改修は原則不要（依存が要るならトピック4）。

## 2. 価格変更・セール

- 表示価格は M_PRODUCT.DISPLAY_PRICE を UPDATE。実課金額は Stripe Price 側で管理し、変更時は新しい Stripe Price を作成して STRIPE_PRICE_ID を差し替える。
- Price を差し替えても、既発行の Checkout Session は T_CHECKOUT_ATTEMPT_ITEM.STRIPE_PRICE_ID snapshot により正しく fulfill される（過去購入に影響しない）。

## 3. 販売 ON/OFF

- M_PRODUCT.PURCHASE_ENABLED を 1（販売）/ 0（停止）で UPDATE。販売可否の唯一の正本。
- 販売停止中でも既存 entitlement は有効（利用は継続）。購入導線のみ止まる。

## 4. 商品依存関係

- 依存は M_PRODUCT_DEPENDENCY が正本（旧ハードコード PRODUCT_DEPENDENCIES は廃止）。
- 列: PRODUCT_CODE / REQUIRES_CODE / DEPENDENCY_GROUP / SATISFY_MODE。
- SATISFY_MODE: `ENTITLEMENT_OR_CART`（既所有 or 同一カートで充足）/ `ENTITLEMENT_ONLY`（既所有のみ充足・同一カート不可）。同一グループ内でモード混在は不可。
- グループ内は ANY_OF（いずれか）、グループ間は ALL_OF（すべて）。所有判定は有効 entitlement（GRANT_TYPE 非依存＝Admin 直接付与も所有扱い）。
- 循環依存は投入前に検出されエラーになる。将来の商品追加（例: 3D_PREVIEW）は M_PRODUCT 登録＋M_PRODUCT_DEPENDENCY へ行を足すだけでコード改修不要。

---

## 11. 補足：正本テーブルと識別子早見表

| 対象 | 正本 | 備考 |
|---|---|---|
| 商品 | M_PRODUCT | PRODUCT_CODE / SORT_NO |
| 販売可否 | M_PRODUCT.PURCHASE_ENABLED | 1/0 |
| 表示価格 | M_PRODUCT.DISPLAY_PRICE | 円 |
| Stripe Price ID | M_PRODUCT.STRIPE_PRICE_ID | 環境ごと手動設定・非空一意 |
| 実課金額 | Stripe Price | Test/Live 別 |
| 商品依存 | M_PRODUCT_DEPENDENCY | SATISFY_MODE / GROUP |
| 所有（利用権） | 有効 T_USER_PRODUCT | STATUS=1 / 期間内 / DEL_FLG=0 |
| note 由来購入 | T_PURCHASE.PURCHASE_SOURCE=1 | GRANT_TYPE=1 |
| note 台帳 | T_NOTE_PURCHASE | NOTE_TRANSACTION_ID 冪等キー |
| ユーザー | M_USER（AUTH_USER_ID＝Supabase sub） | Auth は別系統 |
| session 観測 | T_ACCESS_LOG.SESSION_ID_HASH | v1: HMAC・生値非保存 |

### 破壊的操作の環境ガード早見
- `POST /api/admin/test/reset-purchases`: Local/Test のみ（Production は 404）・Admin JWT 必須。
- migration 適用 / M_PRODUCT・M_PRODUCT_DEPENDENCY の手動 UPDATE / note 台帳クリア / ユーザー完全削除 / Secret 設定: 各環境で個別。Production は実状態を確認してから。
- **commit / push / deploy はしんごさん自身が行う**。
