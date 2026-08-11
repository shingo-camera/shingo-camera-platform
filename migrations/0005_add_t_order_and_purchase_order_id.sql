-- shingo-camera Platform
-- migration 0005: 複数商品 Checkout 基盤（T_ORDER 新設・T_PURCHASE.ORDER_ID 追加）（WORK-011）
-- Status: Approved
--
-- 背景:
--   購入基盤を「1 Checkout = 1 商品」から複数商品（HANABI / HANABI_GOOGLE_EARTH /
--   SUN_AND_MOON）を 1 回の Stripe Checkout でまとめ買いできる構造へ拡張する。
--   注文（1 回の決済）と購入明細（各商品）を分離するため、注文ヘッダ T_ORDER を新設し、
--   既存 T_PURCHASE を「購入明細」として継続利用する（note 移行の正本利用を壊さない）。
--
-- 正本仕様:
--   api/PURCHASE_API.md（複数商品 Checkout）
--   api/DATABASE.md（T_ORDER 定義・T_PURCHASE.ORDER_ID）
--   adr/ADR-008_D1_BATCH.md（db.batch による注文・明細・権限の原子的反映）
--   adr/ADR-012_JST_DATETIME_AND_MIGRATION_POLICY.md（追加型 migration・既存データ非破壊）
--   implementation/WORK-011_MULTI_CHECKOUT.md
--
-- 方針:
--   - 追加型のみ（CREATE TABLE / ADD COLUMN / CREATE INDEX）。既存データの削除・再作成をしない。
--   - Stripe 新方式: T_ORDER 1 注文 1 行、T_PURCHASE 商品数分 N 行（ORDER_ID あり）。
--   - 既存 note 購入 / 既存 Stripe 単品: T_ORDER なし、T_PURCHASE.ORDER_ID = NULL（現状維持）。
--   - T_PURCHASE.EXTERNAL_PURCHASE_ID / UX_T_PURCHASE_EXTERNAL は変更しない（note 冪等の正本）。
--     Stripe 新方式では Checkout Session ID を T_ORDER.EXTERNAL_ORDER_ID に保持し、
--     T_PURCHASE.EXTERNAL_PURCHASE_ID は NULL とする（部分 UNIQUE 索引の対象外で衝突しない）。
--
-- 命名・型・STATUS 定義は 0001 の既存規則に合わせる:
--   - PK は INTEGER PRIMARY KEY AUTOINCREMENT（T_PURCHASE と同様）
--   - 日時は TEXT（JST ISO 8601）
--   - PURCHASE_SOURCE は T_PURCHASE と同義（0=Stripe, 1=note, 2=予備）。CHECK (0,1,2)
--   - PAYMENT_STATUS は T_PURCHASE と同義。CHECK (0,1,2,3,9)
--   - DEL_FLG は CHECK (0,1)
--
-- 冪等性:
--   本 migration は CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS を用いる。
--   ADD COLUMN は IF NOT EXISTS を SQLite が持たないため、初回のみ適用する前提とする
--   （wrangler d1 migrations は適用済みを記録するため二重適用されない）。

PRAGMA foreign_keys = ON;

-- ============ T_ORDER（注文ヘッダ：1 回の決済 = 1 行） ============
CREATE TABLE IF NOT EXISTS T_ORDER (
    ORDER_ID           INTEGER PRIMARY KEY AUTOINCREMENT,
    AUTH_USER_ID       TEXT NOT NULL,
    PURCHASE_SOURCE    INTEGER NOT NULL,            -- 0=Stripe, 1=note, 2=予備（T_PURCHASE と同義）
    EXTERNAL_ORDER_ID  TEXT,                        -- Stripe: Checkout Session ID / note: 当面 NULL
    ORDER_DATE         TEXT NOT NULL,               -- JST ISO 8601
    TOTAL_AMOUNT       INTEGER NOT NULL DEFAULT 0,  -- 注文時点の合計金額（購入時価格を履歴保持）
    PAYMENT_STATUS     INTEGER NOT NULL DEFAULT 1,  -- 0=未,1=支払済,2=返金,3=一部返金,9=無効（T_PURCHASE と同義）
    REFUND_DATE        TEXT,
    DEL_FLG            INTEGER NOT NULL DEFAULT 0,
    CREATE_DATE        TEXT NOT NULL,
    UPDATE_DATE        TEXT NOT NULL,
    FOREIGN KEY (AUTH_USER_ID) REFERENCES M_USER (AUTH_USER_ID),
    CHECK (PURCHASE_SOURCE IN (0, 1, 2)),
    CHECK (PAYMENT_STATUS IN (0, 1, 2, 3, 9)),
    CHECK (DEL_FLG IN (0, 1))
);

-- 同一 Stripe Checkout Session の Webhook 再送による注文二重作成を防止する。
-- EXTERNAL_ORDER_ID が NULL の行（将来の note 等）は対象外とする部分 UNIQUE。
CREATE UNIQUE INDEX IF NOT EXISTS UX_T_ORDER_EXTERNAL
ON T_ORDER (PURCHASE_SOURCE, EXTERNAL_ORDER_ID)
WHERE EXTERNAL_ORDER_ID IS NOT NULL;

-- 注文履歴の取得（ユーザー×日時降順）。
CREATE INDEX IF NOT EXISTS IX_T_ORDER_USER_DATE
ON T_ORDER (AUTH_USER_ID, ORDER_DATE DESC);

-- ============ T_PURCHASE に ORDER_ID を追加（購入明細を注文へ紐付け） ============
-- 既存行（note 購入・既存 Stripe 単品）は NULL のまま（現状維持）。
ALTER TABLE T_PURCHASE ADD COLUMN ORDER_ID INTEGER REFERENCES T_ORDER (ORDER_ID);

-- 注文ヘッダからの明細参照。
CREATE INDEX IF NOT EXISTS IX_T_PURCHASE_ORDER
ON T_PURCHASE (ORDER_ID);

-- 同一注文内で同一商品を二重登録しない（LINE_NO は持たず、ORDER_ID + PRODUCT_ID で一意）。
-- ORDER_ID が NULL の既存行（note 等）は対象外とする部分 UNIQUE。
CREATE UNIQUE INDEX IF NOT EXISTS UX_T_PURCHASE_ORDER_PRODUCT
ON T_PURCHASE (ORDER_ID, PRODUCT_ID)
WHERE ORDER_ID IS NOT NULL;
