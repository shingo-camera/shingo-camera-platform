-- shingo-camera Platform
-- migration 0002: 初期データの日時を JST ISO 8601 へ修正
-- Status: Approved
--
-- 背景:
--   0001 では初期データ（M_PRODUCT / M_SYSTEM_SETTING）の日時を
--   datetime('now') で投入した。SQLite の datetime('now') は UTC を返し、
--   かつ "YYYY-MM-DD HH:MM:SS"（T 無し・オフセット無し）形式で、正本の
--   日時仕様（ISO 8601・+09:00）と不整合であった。
--
-- 正本仕様:
--   DATABASE.md 4.6 「D1 には ISO 8601 形式の TEXT で保存」
--   例: 2026-08-05T17:30:00+09:00
--
-- 方針（(B)）:
--   0001 は Local/Production 適用済みのため変更しない（履歴として固定）。
--   本 0002 で既存の初期データ日時を UTC 値から JST ISO 8601 へ変換する。
--   変換: strftime で +9 時間し、T 区切りにして末尾へ +09:00 を付す。
--
-- 冪等性:
--   既に +09:00 を含む（=変換済み）行は対象外とする。
--   万一 0002 が再適用されても二重加算しない。
--
-- 対象:
--   M_PRODUCT.CREATE_DATE / UPDATE_DATE
--   M_SYSTEM_SETTING.UPDATE_DATE （このテーブルに CREATE_DATE は無い）
--   （M_USER のテストデータは移行対象外）

-- M_PRODUCT: CREATE_DATE
UPDATE M_PRODUCT
SET CREATE_DATE = strftime('%Y-%m-%dT%H:%M:%S', CREATE_DATE, '+9 hours') || '+09:00'
WHERE CREATE_DATE NOT LIKE '%+09:00';

-- M_PRODUCT: UPDATE_DATE
UPDATE M_PRODUCT
SET UPDATE_DATE = strftime('%Y-%m-%dT%H:%M:%S', UPDATE_DATE, '+9 hours') || '+09:00'
WHERE UPDATE_DATE NOT LIKE '%+09:00';

-- M_SYSTEM_SETTING: UPDATE_DATE
UPDATE M_SYSTEM_SETTING
SET UPDATE_DATE = strftime('%Y-%m-%dT%H:%M:%S', UPDATE_DATE, '+9 hours') || '+09:00'
WHERE UPDATE_DATE NOT LIKE '%+09:00';
