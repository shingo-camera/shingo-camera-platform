-- shingo-camera Platform
-- migration 0003: アクセスログ抑制間隔の設定キーを追加
-- Status: Approved
--
-- 背景:
--   GET /api/entitlements/{code} の権限確認アクセスログ（ACCESS_TYPE=1）は、
--   同一条件（AUTH_USER_ID / PRODUCT_ID / ACCESS_TYPE / DEVICE_ID）の短時間
--   連続アクセスを毎回保存しない（PRODUCT_API.md 5）。
--   その最小記録間隔（分）を M_SYSTEM_SETTING で変更可能にする。
--
-- 追加キー:
--   ACCESS_LOG_INTERVAL_MIN = 60
--   意味: 同一条件の権限確認アクセスログを再記録するまでの最小間隔（分）
--
-- 冪等性:
--   INSERT OR IGNORE により、既に存在する場合は追加しない（再適用安全）。
--
-- 日時:
--   ADR-012 の JST ISO 8601 +09:00 形式で生成する。
--   （new Date().toISOString() / datetime('now') / CURRENT_TIMESTAMP は使わない）
--
-- 0001 / 0002 は変更しない。

INSERT OR IGNORE INTO M_SYSTEM_SETTING
    (SETTING_KEY, SETTING_VALUE, DESCRIPTION, UPDATE_DATE)
VALUES
    (
        'ACCESS_LOG_INTERVAL_MIN',
        '60',
        '権限確認アクセスログの最小記録間隔（分）',
        strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '+09:00'
    );
