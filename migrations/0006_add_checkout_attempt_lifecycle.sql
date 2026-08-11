-- shingo-camera Platform
-- migration 0006: 注文ライフサイクル堅牢化（支払い試行層の追加）（WORK-011）
-- Status: Approved
--
-- 背景:
--   Stripe Checkout Session を「支払い試行」として Platform 側で追跡する層を追加する。
--   これにより二重課金の事前防止（DB 制約による並行 Checkout 排他）、HTTP 再送収束、
--   paid 未反映の救済（success recovery / admin reconcile）、refund/dispute 追跡の
--   土台を得る。既存 T_ORDER(paid 注文)/T_PURCHASE/T_USER_PRODUCT/note 移行は無改変。
--
-- 正本設計:
--   ORDER_LIFECYCLE_DESIGN_STAGE1/2, *_FIX, *_FIX2, *_FIX3,
--   ORDER_LIFECYCLE_DESIGN_FINAL_APPENDIX, ORDER_LIFECYCLE_DESIGN_ERROR_CLASSIFICATION_FINAL
--   adr/ADR-008_D1_BATCH.md（batch 原子性）, adr/ADR-012（追加型・非破壊）
--
-- 方針:
--   - 追加型のみ（CREATE TABLE / ADD COLUMN / CREATE INDEX）。既存データ非破壊。
--   - 支払い試行層は Stripe 専用。note 移行は一切通らない。
--   - 並行 Checkout 排他は T_PRODUCT_CHECKOUT_LOCK の PRIMARY KEY を正本とする。
--   - 命名・型・規則は 0001/0005 に合わせる（PK は INTEGER AUTOINCREMENT、日時は TEXT/JST ISO）。

PRAGMA foreign_keys = ON;

-- ============================================================
-- T_CHECKOUT_ATTEMPT（支払い試行ヘッダ：1 行 = 1 回の Checkout 試行 ≒ 1 Stripe Session）
-- ============================================================
CREATE TABLE IF NOT EXISTS T_CHECKOUT_ATTEMPT (
    ATTEMPT_ID         INTEGER PRIMARY KEY AUTOINCREMENT,
    OPERATION_ID       TEXT NOT NULL,               -- browser 生成の安定キー（HTTP 再送収束・idempotency の基）
    AUTH_USER_ID       TEXT NOT NULL,               -- 検証済み sub（購入者）
    CART_KEY           TEXT NOT NULL,               -- server 正規化した商品構成の安定表現（同一試行判定）
    BUYER_EMAIL        TEXT NOT NULL,               -- attempt 開始時の認証 email スナップショット（retry でも不変）
    STATUS             INTEGER NOT NULL DEFAULT 0,  -- 0=CREATING,1=OPEN,2=PAID,3=EXPIRED,4=CANCELLED
    CREATE_ATTEMPTED   INTEGER NOT NULL DEFAULT 0,  -- Stripe create を呼ぶ直前に 1 を確定（0+SID=NULL=未試行 / 1+SID=NULL=結果不明）
    STRIPE_SESSION_ID  TEXT,                        -- Stripe 作成後にセット（作成前は NULL）
    TOTAL_AMOUNT       INTEGER NOT NULL DEFAULT 0,  -- 期待合計（表示・照合補助。正本は Webhook 再取得値）
    EXPIRES_AT         TEXT,                        -- Stripe Session の expires_at（JST ISO）
    DEL_FLG            INTEGER NOT NULL DEFAULT 0,
    CREATE_DATE        TEXT NOT NULL,
    UPDATE_DATE        TEXT NOT NULL,
    FOREIGN KEY (AUTH_USER_ID) REFERENCES M_USER (AUTH_USER_ID),
    CHECK (STATUS IN (0, 1, 2, 3, 4)),
    CHECK (DEL_FLG IN (0, 1))
);

-- 同一 operationId の HTTP 再送を同一 attempt 行へ収束させる（idempotency の DB 保証）。
CREATE UNIQUE INDEX IF NOT EXISTS UX_ATTEMPT_OPERATION
ON T_CHECKOUT_ATTEMPT (OPERATION_ID);

-- 同一 Stripe Session を二重に試行記録しない（NULL は対象外の部分 UNIQUE）。
CREATE UNIQUE INDEX IF NOT EXISTS UX_ATTEMPT_SESSION
ON T_CHECKOUT_ATTEMPT (STRIPE_SESSION_ID)
WHERE STRIPE_SESSION_ID IS NOT NULL;

-- ユーザー×状態での追跡（active 試行の探索・管理画面）。
CREATE INDEX IF NOT EXISTS IX_ATTEMPT_USER_STATUS
ON T_CHECKOUT_ATTEMPT (AUTH_USER_ID, STATUS);

-- ============================================================
-- T_CHECKOUT_ATTEMPT_ITEM（試行で確定した immutable 商品/Price スナップショット）
--   Stripe create を同一パラメータで再実行するために必要な値を固定保持する。
-- ============================================================
CREATE TABLE IF NOT EXISTS T_CHECKOUT_ATTEMPT_ITEM (
    ATTEMPT_ITEM_ID  INTEGER PRIMARY KEY AUTOINCREMENT,
    ATTEMPT_ID       INTEGER NOT NULL,              -- T_CHECKOUT_ATTEMPT への参照
    PRODUCT_ID       INTEGER NOT NULL,              -- 付与対象（内部 ID）
    PRODUCT_CODE     TEXT NOT NULL,                 -- 監査・CART_KEY・metadata 用
    STRIPE_PRICE_ID  TEXT NOT NULL,                 -- create 再実行で使う price（attempt 時点で固定）
    EXPECTED_AMOUNT  INTEGER NOT NULL,              -- 将来の監査用予約列（試行時点の期待額）。現行フローでは未使用・0 を許容。金額正本は Stripe 側
    SORT_NO          INTEGER NOT NULL,              -- line_items の安定順序（create 再現の決定性）
    CREATE_DATE      TEXT NOT NULL,
    FOREIGN KEY (ATTEMPT_ID) REFERENCES T_CHECKOUT_ATTEMPT (ATTEMPT_ID)
);

CREATE INDEX IF NOT EXISTS IX_ATTEMPT_ITEM_ATTEMPT
ON T_CHECKOUT_ATTEMPT_ITEM (ATTEMPT_ID);

-- 同一試行内での同一商品の重複を防止。
CREATE UNIQUE INDEX IF NOT EXISTS UX_ATTEMPT_ITEM_PRODUCT
ON T_CHECKOUT_ATTEMPT_ITEM (ATTEMPT_ID, PRODUCT_ID);

-- ============================================================
-- T_PRODUCT_CHECKOUT_LOCK（active な同一商品購入の競合防止・行の存在=active 予約）
--   PRIMARY KEY(AUTH_USER_ID, PRODUCT_ID) が並行 Checkout 排他の正本。
-- ============================================================
CREATE TABLE IF NOT EXISTS T_PRODUCT_CHECKOUT_LOCK (
    AUTH_USER_ID TEXT NOT NULL,
    PRODUCT_ID   INTEGER NOT NULL,
    ATTEMPT_ID   INTEGER NOT NULL,                  -- どの試行が押さえているか（解放・stale 掃除用）
    CREATE_DATE  TEXT NOT NULL,
    PRIMARY KEY (AUTH_USER_ID, PRODUCT_ID),         -- ★同一ユーザー・同一商品の active 予約は最大 1
    FOREIGN KEY (ATTEMPT_ID) REFERENCES T_CHECKOUT_ATTEMPT (ATTEMPT_ID)
);

-- 試行単位での lock 解放（attempt 完了/expire/cancel 時）。
CREATE INDEX IF NOT EXISTS IX_LOCK_ATTEMPT
ON T_PRODUCT_CHECKOUT_LOCK (ATTEMPT_ID);

-- ============================================================
-- T_PAYMENT_EVENT（決済運用イベント記録：duplicate paid / refund / dispute /
--   fulfill failure / reconcile / server indeterminate）
--   既存 4 種の不正利用 warning（T_WARNING）とは意味が異なるため分離する。
-- ============================================================
CREATE TABLE IF NOT EXISTS T_PAYMENT_EVENT (
    PAYMENT_EVENT_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
    EVENT_TYPE         INTEGER NOT NULL,            -- 1=DUPLICATE_PAID,2=REFUND,3=DISPUTE,4=FULFILL_FAILURE,5=RECONCILE,6=SERVER_INDETERMINATE
    AUTH_USER_ID       TEXT,
    ORDER_ID           INTEGER,                     -- 該当注文（あれば）
    STRIPE_SESSION_ID  TEXT,
    PAYMENT_INTENT_ID  TEXT,
    STRIPE_OBJECT_ID   TEXT,                        -- refund id / dispute id 等
    STRIPE_EVENT_ID    TEXT,                        -- Webhook event.id（冪等キー）
    STRIPE_REQUEST_ID  TEXT,                        -- B2 調査用（可能なら保存）
    STATUS             TEXT,                        -- refund/dispute の status 文字列
    AMOUNT             INTEGER,
    DETAIL             TEXT,                        -- reason 等（機微情報・カード情報は入れない）
    NOTIFIED_DATE      TEXT,                        -- 管理者通知済み時刻
    DEL_FLG            INTEGER NOT NULL DEFAULT 0,
    CREATE_DATE        TEXT NOT NULL,
    UPDATE_DATE        TEXT NOT NULL,
    CHECK (EVENT_TYPE IN (1, 2, 3, 4, 5, 6)),
    CHECK (DEL_FLG IN (0, 1))
);

-- refund/dispute の Webhook 再送で同じ event を二重記録しない（NULL は対象外）。
CREATE UNIQUE INDEX IF NOT EXISTS UX_PAYEVENT_STRIPE_EVENT
ON T_PAYMENT_EVENT (STRIPE_EVENT_ID)
WHERE STRIPE_EVENT_ID IS NOT NULL;

-- 注文・種別での追跡。
CREATE INDEX IF NOT EXISTS IX_PAYEVENT_ORDER
ON T_PAYMENT_EVENT (ORDER_ID);
CREATE INDEX IF NOT EXISTS IX_PAYEVENT_TYPE_DATE
ON T_PAYMENT_EVENT (EVENT_TYPE, CREATE_DATE DESC);

-- ============================================================
-- T_ORDER に PAYMENT_INTENT_ID を追加（refund/dispute イベントから注文を逆引き）
--   Refund/Charge の payment_intent → T_ORDER.PAYMENT_INTENT_ID で注文特定。
-- ============================================================
ALTER TABLE T_ORDER ADD COLUMN PAYMENT_INTENT_ID TEXT;

CREATE INDEX IF NOT EXISTS IX_T_ORDER_PI
ON T_ORDER (PAYMENT_INTENT_ID);
