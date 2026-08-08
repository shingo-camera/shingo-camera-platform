-- shingo-camera Platform
-- migration 0004: Warning 判定閾値の設定キーを追加（WORK-009）
-- Status: Approved
--
-- 背景:
--   WORK-009 Warning Notification 初版の判定閾値のうち、既存キーで
--   賄えないものを M_SYSTEM_SETTING へ追加し、再デプロイなしで調整可能にする。
--   （operation/WARNING.md 4、implementation/WORK-009_WARNING.md、database/TABLES.md）
--
-- 追加キー:
--   MANY_DEVICES_LIMIT = 4
--     意味: 直近24時間で同一ユーザーの異なる DEVICE_ID がこの台数以上で MANY_DEVICES 検知
--   MANY_REGIONS_LIMIT = 3
--     意味: 直近24時間で同一ユーザーの異なる地域（COUNTRY_CODE+REGION）がこの数以上で MANY_REGIONS 検知
--
-- 既存キーの再利用（本 migration では追加しない）:
--   LOGIN_FAIL_LIMIT=5 … LOGIN_FAILURE 閾値
--   WARNING_MAIL_INTERVAL_MIN=60 … 同一対象・同一種別の通知抑止間隔（分）
--   DEVICE_CHANGE_SCORE / REGION_CHANGE_SCORE / COUNTRY_CHANGE_SCORE / WARNING_SCORE … 既存スコア方式
--   COUNTRY_CHANGE は「24時間以内に有効な2か国以上」の固定条件のため国数用キーは追加しない。
--
-- 冪等性:
--   INSERT OR IGNORE により、既に存在する場合は追加しない（再適用安全）。
--
-- 日時:
--   ADR-012 の JST ISO 8601 +09:00 形式で生成する。
--   （new Date().toISOString() / datetime('now') / CURRENT_TIMESTAMP は使わない）
--
-- 0001 / 0002 / 0003 は変更しない。

INSERT OR IGNORE INTO M_SYSTEM_SETTING
    (SETTING_KEY, SETTING_VALUE, DESCRIPTION, UPDATE_DATE)
VALUES
    (
        'MANY_DEVICES_LIMIT',
        '4',
        '直近24時間で MANY_DEVICES を検知する異なる DEVICE_ID の台数閾値',
        strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '+09:00'
    ),
    (
        'MANY_REGIONS_LIMIT',
        '3',
        '直近24時間で MANY_REGIONS を検知する異なる地域（COUNTRY_CODE+REGION）の数の閾値',
        strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '+09:00'
    );
