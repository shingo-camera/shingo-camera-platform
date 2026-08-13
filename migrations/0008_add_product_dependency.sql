-- shingo_camera LABO
-- migration 0008: 商品購入依存関係の DB 化（M_PRODUCT_DEPENDENCY）
-- Status: Approved
--
-- 背景:
--   これまで商品購入の依存関係（追加機能商品は前提商品の所有が必要）は、コード内の固定定義
--   PRODUCT_DEPENDENCIES（Record<string,string>）にハードコードされていた（HANABI_GOOGLE_EARTH ← HANABI）。
--   これを M_PRODUCT_DEPENDENCY テーブルへ移し、商品追加時にコード改修なしで依存を定義できるようにする。
--
-- 方針:
--   - 追加型のみ（CREATE TABLE / CREATE INDEX / seed）。既存データ非破壊。DROP / destructive なし。
--   - CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / INSERT OR IGNORE を用いる（0003/0004 と同方針）。
--     → migration の再適用に対して安全（重複 INSERT で失敗しない・UNIQUE と整合）。
--   - FK が確実に有効になるよう本 migration 単体でも PRAGMA foreign_keys = ON を明示（0001/0005/0006 と同方針）。
--     同一 connection で 0001 から流したときにたまたま ON、に依存しない。
--   - 依存判定の正本は本テーブル（0008 適用後）。旧 PRODUCT_DEPENDENCIES のコード固定定義は廃止し二重管理を残さない。
--
-- 依存の意味:
--   - 1 商品（PRODUCT_CODE）は 0 個以上の依存行を持つ。DB に依存行が無い商品は「依存なし」。
--   - 各依存行は「前提として必要な商品（REQUIRES_CODE）」「依存グループ（DEPENDENCY_GROUP）」
--     「充足方法（SATISFY_MODE）」を持つ。
--   - 同一グループ内は ANY_OF（グループ内のいずれかの REQUIRES_CODE を満たせばそのグループは充足）。
--   - グループが複数ある場合はグループ間 ALL_OF（すべてのグループを充足する必要がある）。
--   - SATISFY_MODE:
--       'ENTITLEMENT_OR_CART' … 有効な entitlement を持つ、または同一注文（同時購入）に前提商品を含めば充足。
--       'ENTITLEMENT_ONLY'    … Checkout 開始前から有効な entitlement を持っている場合のみ充足
--                               （同一注文に前提商品を入れても充足にしない）。
--   - 「所有」= 有効な T_USER_PRODUCT entitlement（購入履歴・注文履歴・Stripe 履歴・GRANT_TYPE を問わない）。
--     判定ロジックは src/shared/purchase.ts（isProductAvailable を再利用）。
--   - 同一 PRODUCT_CODE + DEPENDENCY_GROUP 内では SATISFY_MODE は同一であることを前提とする
--     （ANY_OF の評価単位のため）。DB 列 CHECK では単一行の値のみ強制し、複数行にまたがる一貫性は
--     判定ロジック側で検証して混在を内部設定エラーとして安全側に拒否する（複雑な Trigger は作らない）。
--
-- 現行仕様のデータ化:
--   - HANABI_GOOGLE_EARTH は単一グループ(0)に HANABI のみ・SATISFY_MODE='ENTITLEMENT_OR_CART'
--     → 「HANABI を既に所有」または「HANABI と EARTH を同一カートで購入」の両方を許す（現行挙動を維持）。
--   - 将来 3D_PREVIEW は単一グループに HANABI と SUN_AND_MOON を SATISFY_MODE='ENTITLEMENT_ONLY' で登録
--     → 「HANABI OR SUN_AND_MOON のどちらかを既に所有」している場合のみ購入可（同一カートでは充足しない）。
--     3D_PREVIEW はまだ M_PRODUCT に存在しないため本 migration では登録しない（商品追加 migration で投入）。
--
-- 制約:
--   - PRODUCT_CODE / REQUIRES_CODE は M_PRODUCT.PRODUCT_CODE を参照（FK）。存在しない商品コードは登録不可。
--   - 自己依存（PRODUCT_CODE = REQUIRES_CODE）は CHECK で禁止（自明な循環を DB で防ぐ）。
--     多段の循環（A→B→A 等）は判定ロジック側で検出し内部設定エラーとして安全側に拒否する。
--   - SATISFY_MODE は 'ENTITLEMENT_ONLY' / 'ENTITLEMENT_OR_CART' のみ（CHECK）。
--   - STATUS / DEL_FLG で有効・論理削除を表現（他マスタと同規約）。
--   - (PRODUCT_CODE, DEPENDENCY_GROUP, REQUIRES_CODE) は一意（同一グループへ同じ前提を重複登録しない）。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS M_PRODUCT_DEPENDENCY (
    DEPENDENCY_ID     INTEGER PRIMARY KEY AUTOINCREMENT,
    PRODUCT_CODE      TEXT NOT NULL,               -- 依存を持つ商品（この商品を買うのに前提が要る）
    REQUIRES_CODE     TEXT NOT NULL,               -- 前提として必要な商品
    DEPENDENCY_GROUP  INTEGER NOT NULL DEFAULT 0,  -- 同一グループ内は ANY_OF / グループ間は ALL_OF
    SATISFY_MODE      TEXT NOT NULL DEFAULT 'ENTITLEMENT_OR_CART',  -- 充足方法（下記 CHECK 参照）
    STATUS            INTEGER NOT NULL DEFAULT 1,  -- 1=有効 / 0=無効
    DEL_FLG           INTEGER NOT NULL DEFAULT 0,  -- 0=有効 / 1=論理削除
    CREATE_DATE       TEXT NOT NULL,
    UPDATE_DATE       TEXT NOT NULL,
    CHECK (STATUS IN (0, 1)),
    CHECK (DEL_FLG IN (0, 1)),
    CHECK (PRODUCT_CODE <> REQUIRES_CODE),
    CHECK (SATISFY_MODE IN ('ENTITLEMENT_ONLY', 'ENTITLEMENT_OR_CART')),
    FOREIGN KEY (PRODUCT_CODE) REFERENCES M_PRODUCT (PRODUCT_CODE),
    FOREIGN KEY (REQUIRES_CODE) REFERENCES M_PRODUCT (PRODUCT_CODE)
);

-- 同一グループへ同じ前提商品を重複登録しない（再適用時の INSERT OR IGNORE と整合）
CREATE UNIQUE INDEX IF NOT EXISTS UX_PRODUCT_DEPENDENCY
    ON M_PRODUCT_DEPENDENCY (PRODUCT_CODE, DEPENDENCY_GROUP, REQUIRES_CODE);

-- 依存を持つ商品での引き当て用
CREATE INDEX IF NOT EXISTS IX_PRODUCT_DEPENDENCY_PRODUCT
    ON M_PRODUCT_DEPENDENCY (PRODUCT_CODE);

-- 現行仕様のデータ化: HANABI_GOOGLE_EARTH は HANABI を必須（単一グループ 0・ENTITLEMENT_OR_CART）。
-- INSERT OR IGNORE により再適用しても UNIQUE 重複で失敗しない（seed 再適用安全）。
-- 日時は JST ISO 8601（+09:00。0002 と同じ書き方）。
INSERT OR IGNORE INTO M_PRODUCT_DEPENDENCY
    (PRODUCT_CODE, REQUIRES_CODE, DEPENDENCY_GROUP, SATISFY_MODE, STATUS, DEL_FLG, CREATE_DATE, UPDATE_DATE)
VALUES
    ('HANABI_GOOGLE_EARTH', 'HANABI', 0, 'ENTITLEMENT_OR_CART', 1, 0,
     strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '+09:00',
     strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '+09:00');
