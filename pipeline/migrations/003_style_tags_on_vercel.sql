-- ============================================================
-- WowStylist — 風向標的「可編輯」那一層，搬到 Vercel 這台
--
-- 目標資料庫：跟 002 同一台（Prisma Postgres，STYLE_DATABASE_URL）
--
-- 為什麼搬：
--   style_tags 原本在 IG 那台 RDS（001 建的），但那張表一直是空的，
--   而且 RDS 從外面連不太穩（見 57ce71e「fix RDS 連不上」）。
--   標籤是使用者會即時增刪改的東西，卡在連不上的資料庫上體驗很差。
--   單品標籤（002）已經在這台了，整個風向標放同一台才不用跨庫同步。
--
--   RDS 上那張 style_tags 留著不動，反正是空的，之後要回收再說。
--
-- 跑法：
--   psql "$STYLE_DATABASE_URL" -f pipeline/migrations/003_style_tags_on_vercel.sql
--
-- idempotent，重跑不會壞。
-- ============================================================

\set ON_ERROR_STOP on


-- ------------------------------------------------------------
-- 1) updated_at 自動戳章（001 在 RDS 上有一份，這台要自己建）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ------------------------------------------------------------
-- 2) style_tags — 欄位跟 RDS 那張一模一樣，方便哪天要搬回去
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS style_tags (
    id         TEXT PRIMARY KEY,
    label      TEXT             NOT NULL,
    kind       TEXT             NOT NULL DEFAULT 'style',  -- style | color | mood
    weight     DOUBLE PRECISION NOT NULL DEFAULT 0.5,      -- 0~1，排序用
    owner_id   TEXT,                                       -- LINE userId
    created_at TIMESTAMPTZ      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ      NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_style_tags_weight ON style_tags (weight DESC);

-- 同名標籤只留一個 —— syncTagsFromGarments() 是拿 label 當 key 在找的，
-- 有重複的話會每次同步都長出新的一顆。
CREATE UNIQUE INDEX IF NOT EXISTS ux_style_tags_label ON style_tags (label);

DROP TRIGGER IF EXISTS trg_style_tags_touch ON style_tags;
CREATE TRIGGER trg_style_tags_touch BEFORE UPDATE ON style_tags
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ------------------------------------------------------------
-- 3) 起手式：把 002 的單品標籤收攏成風向標上的標籤
--
--    權重在「同一個圖例裡」正規化 —— 色系天生比風格分散
--    （32 件衣服 22 種顏色、只有 10 種風格），
--    全表一起比的話色系會整排墊底。
--
--    ON CONFLICT DO NOTHING：使用者改過的標籤不會被蓋掉。
--    重跑只會補上新出現的。
-- ------------------------------------------------------------
INSERT INTO style_tags (id, label, kind, weight)
SELECT
    gen_random_uuid()::text,
    label,
    kind,
    ROUND((n::numeric / MAX(n) OVER (PARTITION BY kind)), 3)
FROM (
    SELECT label, kind, COUNT(*) AS n
      FROM (
        SELECT style     AS label, 'style' AS kind FROM garment_style_tags
        UNION ALL
        SELECT palette   AS label, 'color' AS kind FROM garment_style_tags
        UNION ALL
        SELECT adjective AS label, 'mood'  AS kind FROM garment_style_tags
      ) u
     WHERE label <> ''
     GROUP BY label, kind
) c
ON CONFLICT (label) DO NOTHING;
