-- shingo_camera LABO
-- migration 0007: 商品販売専用情報の追加（M_PRODUCT）
-- Status: Approved
--
-- 背景:
--   販売可否・販売方式・表示価格・Stripe Price ID を商品マスタ（M_PRODUCT）で一元管理する。
--   これまで販売可否はサーバー側 SELLABLE_PRODUCT_CODES とフロント site-config.js の
--   purchasable の2箇所、Stripe Price ID は env の商品別 STRIPE_PRICE_* で管理していた。
--   これらを M_PRODUCT へ一本化し、新商品追加・買い切り/サブスク切替・販売開始/停止を
--   コード改修なし（商品マスタ設定）で行える土台を作る。
--
-- 方針:
--   - 追加型のみ（ADD COLUMN）。既存データ非破壊。DROP / destructive なし。
--   - ADD COLUMN は SQLite が IF NOT EXISTS を持たないため初回のみ適用する前提
--     （wrangler d1 migrations apply が適用済みを管理する。0005/0006 と同方針）。
--   - M_PRODUCT.STATUS の意味（商品マスタ自体の有効/無効）は変更しない。販売可否は別軸。
--   - 販売可否の正本は PURCHASE_ENABLED（STATUS=1 かつ DEL_FLG=0 かつ PURCHASE_ENABLED=1
--     かつ SALE_TYPE='ONE_TIME' かつ STRIPE_PRICE_ID 設定済みで新規購入可）。
--   - DISPLAY_PRICE は表示専用。実課金額の正本は Stripe Price（STRIPE_PRICE_ID が指す価格）。
--   - 日時は既存仕様（JST ISO 8601・+09:00）に合わせる（0002 で datetime('now') の UTC を是正済み）。
--
-- 列の責務:
--   PURCHASE_ENABLED  0=新規購入不可（準備中）/ 1=新規購入可能。販売受付のON/OFF正本。
--                     ※ entitlement（既存利用権）とは無関係。0 でも既存購入者は利用継続。
--   SALE_TYPE         'ONE_TIME'=買い切り / 'SUBSCRIPTION'=サブスク。将来の決済分岐に使用。
--                     現行 Checkout 基盤は ONE_TIME のみ対応（SUBSCRIPTION は安全側で拒否）。
--   DISPLAY_PRICE     STORE 等に表示する金額（整数・税込想定）。表示専用。
--   BILLING_INTERVAL  ONE_TIME は NULL。SUBSCRIPTION は 'MONTH' / 'YEAR' 等の課金周期。
--   STRIPE_PRICE_ID   Stripe 上の Price オブジェクト識別子（price_xxx）。Checkout / Webhook 逆引きの
--                     正本。API Secret ではない。公開 API / ブラウザへは返さない。
--                     Test/Live で値が異なるため migration ではハードコードせず、環境ごとの D1 へ
--                     別途 UPDATE で設定する（下記「STRIPE_PRICE_ID の設定」参照）。NULL=販売設定未完了。
--
-- 表示順:
--   既存 SORT_NO を商品表示順の正本として継続使用する（HOME/STORE/Admin すべて SORT_NO）。
--   管理順と表示順を分ける要件が現時点でないため、DISPLAY_ORDER は追加しない（列の増やしすぎを避ける）。

-- 列追加（DEFAULT 付きで既存行にも安全に値が入る。列レベル CHECK で不正値を DB で拒否）
--   PURCHASE_ENABLED: 0/1 のみ
--   SALE_TYPE       : 'ONE_TIME' / 'SUBSCRIPTION' のみ
--   DISPLAY_PRICE   : NULL または 0 以上の INTEGER
--   BILLING_INTERVAL: NULL / 'MONTH' / 'YEAR' のみ
--   STRIPE_PRICE_ID : TEXT。形式（price_...）までは強制しない。空白のみの値は入れない運用
--                     （設定時は非空の Price ID か、未設定なら NULL）。一意性は部分 UNIQUE INDEX で担保。
ALTER TABLE M_PRODUCT ADD COLUMN PURCHASE_ENABLED INTEGER NOT NULL DEFAULT 0 CHECK (PURCHASE_ENABLED IN (0, 1));
ALTER TABLE M_PRODUCT ADD COLUMN SALE_TYPE TEXT NOT NULL DEFAULT 'ONE_TIME' CHECK (SALE_TYPE IN ('ONE_TIME', 'SUBSCRIPTION'));
ALTER TABLE M_PRODUCT ADD COLUMN DISPLAY_PRICE INTEGER CHECK (DISPLAY_PRICE IS NULL OR DISPLAY_PRICE >= 0);
ALTER TABLE M_PRODUCT ADD COLUMN BILLING_INTERVAL TEXT CHECK (BILLING_INTERVAL IS NULL OR BILLING_INTERVAL IN ('MONTH', 'YEAR'));
ALTER TABLE M_PRODUCT ADD COLUMN STRIPE_PRICE_ID TEXT;

-- STRIPE_PRICE_ID の一意性（部分 UNIQUE INDEX）。
--   - NULL は複数商品で許可（未設定＝販売設定未完了を複数持てる）。
--   - 空文字も未設定扱いとして複数許可。
--   - 実際に設定された非空の Price ID は商品間で一意（同一 Price を別商品へ割り当てる誤設定を DB で防ぐ）。
CREATE UNIQUE INDEX IF NOT EXISTS UX_PRODUCT_STRIPE_PRICE_ID
    ON M_PRODUCT (STRIPE_PRICE_ID)
    WHERE STRIPE_PRICE_ID IS NOT NULL AND STRIPE_PRICE_ID <> '';

-- 既存3商品へ初期値を設定（現時点の販売状態）。
-- 日時は JST ISO 8601（+09:00）で生成する（0002 と同じ書き方）。
-- STRIPE_PRICE_ID は Test/Live で異なるためここでは設定しない（NULL のまま＝販売設定未完了）。
--   → 環境ごとの D1 へ Production 作業/初期設定で UPDATE する（LAUNCH_CHECKLIST 参照）。

-- SUN_AND_MOON: 販売中・買い切り・¥13,000（STRIPE_PRICE_ID は環境ごとに別途設定）
UPDATE M_PRODUCT
   SET PURCHASE_ENABLED = 1,
       SALE_TYPE        = 'ONE_TIME',
       DISPLAY_PRICE    = 13000,
       BILLING_INTERVAL = NULL,
       UPDATE_DATE      = strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '+09:00'
 WHERE PRODUCT_CODE = 'SUN_AND_MOON';

-- HANABI: 準備中・買い切り・¥4,000
UPDATE M_PRODUCT
   SET PURCHASE_ENABLED = 0,
       SALE_TYPE        = 'ONE_TIME',
       DISPLAY_PRICE    = 4000,
       BILLING_INTERVAL = NULL,
       UPDATE_DATE      = strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '+09:00'
 WHERE PRODUCT_CODE = 'HANABI';

-- HANABI_GOOGLE_EARTH: 準備中・買い切り・¥10,000
UPDATE M_PRODUCT
   SET PURCHASE_ENABLED = 0,
       SALE_TYPE        = 'ONE_TIME',
       DISPLAY_PRICE    = 10000,
       BILLING_INTERVAL = NULL,
       UPDATE_DATE      = strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '+09:00'
 WHERE PRODUCT_CODE = 'HANABI_GOOGLE_EARTH';
