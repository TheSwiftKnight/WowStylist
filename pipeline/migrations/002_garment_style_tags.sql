-- ============================================================
-- WowStylist — 單品風格標籤（Vercel 上的小資料庫）
--
-- 目標資料庫：Vercel Marketplace 的 Prisma Postgres
--   resource  prisma-postgres-aqua-branch (store_P4gAeB0xNzvz7DAw)
--   連線字串  DATABASE_URL
--
-- 為什麼不放在 IG 那台 RDS 的 fashion_items：
--   那張表是 pipeline 寫的，重跑會被 ON CONFLICT 蓋掉。
--   這份標籤是「人挑過的」，獨立一張表才不會被洗掉。
--
-- 對應關係用 source_item_id（不是 fashion_items.id）——
--   id 是 BIGSERIAL，RDS 重建就會跑掉；source_item_id 是
--   pipeline 從 shortcode 算出來的，重跑也一樣。
--
-- 跑法：
--   psql "$DATABASE_URL" -f pipeline/migrations/002_garment_style_tags.sql
--
-- idempotent，重跑不會壞。
-- ============================================================

\set ON_ERROR_STOP on


-- ------------------------------------------------------------
-- 1) garment_style_tags — 一件單品一列，三個欄位對應畫面上的三種圖例
--
--    style / palette / adjective 就是 src/lib/tags.ts 的
--    TAG_KINDS = style | color | mood（風格 / 色系 / 形容詞）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS garment_style_tags (
    -- pipeline 的 build_source_item_id 產出，跨 RDS 重建也穩定
    source_item_id  TEXT PRIMARY KEY,

    -- 方便對照用，不當 key（RDS 重建會跑掉）
    fashion_item_id BIGINT,

    category        TEXT NOT NULL
        CHECK (category IN ('top', 'pants')),

    -- 圖例三欄，一格一個標籤
    style           TEXT NOT NULL,   -- 風格
    palette         TEXT NOT NULL,   -- 色系
    adjective       TEXT NOT NULL,   -- 形容詞

    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_gst_style     ON garment_style_tags (style);
CREATE INDEX IF NOT EXISTS ix_gst_palette   ON garment_style_tags (palette);
CREATE INDEX IF NOT EXISTS ix_gst_adjective ON garment_style_tags (adjective);


-- ------------------------------------------------------------
-- 2) 種子資料 —— 從 fashion_items.text_description 讀出來的三個標籤
--
--    32 件單品（2 則貼文）。每列的三個標籤各對一個圖例：
--    風格取整體美學、色系取主色、形容詞取描述裡的氛圍字。
--
--    重跑會覆蓋（ON CONFLICT DO UPDATE），手動改過的會被蓋掉，
--    要保留手改就先把這段註解掉。
-- ------------------------------------------------------------
INSERT INTO garment_style_tags
    (source_item_id, fashion_item_id, category, style, palette, adjective)
VALUES
    ('DAJb4umuG3A_p0_0_top',    1,  'top',   '極簡',     '霧灰',     '低調'),
    ('DAJb4umuG3A_p0_1_top',    2,  'top',   '法式優雅', '粉霧藍',   '溫柔'),
    ('DAJb4umuG3A_p0_2_top',    3,  'top',   '極簡',     '純黑',     '俐落'),
    ('DAJb4umuG3A_p0_3_pants',  4,  'pants', '美式復古', '墨黑',     '復古'),
    ('DAJb4umuG3A_p1_0_top',    5,  'top',   'Y2K',      '鼠尾草綠', '慵懶'),
    ('DAJb4umuG3A_p1_1_pants',  6,  'pants', 'Y2K',      '中藍丹寧', '復古'),
    ('DAJb4umuG3A_p2_0_top',    7,  'top',   '學院風',   '純白',     '乾淨俐落'),
    ('DAJb4umuG3A_p2_1_top',    8,  'top',   '學院風',   '酒紅',     '濃郁'),
    ('DAJb4umuG3A_p3_0_top',    9,  'top',   '甜美芭蕾', '奶茶棕',   '細緻'),
    ('DAJb4umuG3A_p3_1_pants',  10, 'pants', '居家鬆弛', '炭灰',     '鬆弛感'),
    ('DdBblS6Dhei_p0_0_top',    11, 'top',   '學院風',   '正紅',     '搶眼'),
    ('DdBblS6Dhei_p1_0_top',    12, 'top',   '街頭休閒', '迷彩綠',   '中性帥氣'),
    ('DdBblS6Dhei_p1_1_pants',  13, 'pants', '極簡',     '中藍丹寧', '乾淨俐落'),
    ('DdBblS6Dhei_p2_0_top',    14, 'top',   '法式優雅', '霧霾藍',   '溫柔'),
    ('DdBblS6Dhei_p3_0_top',    15, 'top',   '極簡',     '純黑',     '低調'),
    ('DdBblS6Dhei_p3_1_top',    16, 'top',   '學院風',   '鼠尾草綠', '暖調'),
    ('DdBblS6Dhei_p4_0_top',    17, 'top',   '極簡',     '純白',     '乾淨俐落'),
    ('DdBblS6Dhei_p4_1_pants',  18, 'pants', '極簡',     '墨黑',     '沉穩'),
    ('DdBblS6Dhei_p5_0_top',    19, 'top',   '街頭休閒', '正紅',     '搶眼'),
    ('DdBblS6Dhei_p5_1_pants',  20, 'pants', '美式復古', '深藍丹寧', '隨性'),
    ('DdBblS6Dhei_p6_0_top',    21, 'top',   '波希米亞', '灰綠',     '有故事感'),
    ('DdBblS6Dhei_p7_0_top',    22, 'top',   'Y2K',      '淺藍',     '俐落'),
    ('DdBblS6Dhei_p7_1_pants',  23, 'pants', 'Y2K',      '靛藍丹寧', '端正'),
    ('DdBblS6Dhei_p8_0_top',    24, 'top',   '街頭休閒', '純白',     '隨性'),
    ('DdBblS6Dhei_p8_1_pants',  25, 'pants', '極簡',     '深棕',     '俐落'),
    ('DdBblS6Dhei_p9_0_top',    26, 'top',   '學院風',   '紫李',     '端正'),
    ('DdBblS6Dhei_p9_1_pants',  27, 'pants', '老錢風',   '淺灰',     '沉穩'),
    ('DdBblS6Dhei_p10_0_top',   28, 'top',   '學院風',   '深棕',     '暖調'),
    ('DdBblS6Dhei_p10_1_pants', 29, 'pants', '老錢風',   '霧灰',     '沉穩'),
    ('DdBblS6Dhei_p11_0_top',   30, 'top',   '甜美芭蕾', '淺藍',     '秀氣'),
    ('DdBblS6Dhei_p11_1_pants', 31, 'pants', '極簡',     '深灰',     '低調'),
    ('DdBblS6Dhei_p12_0_top',   32, 'top',   '美式復古', '鏽橘',     '暖調')
ON CONFLICT (source_item_id) DO UPDATE SET
    fashion_item_id = EXCLUDED.fashion_item_id,
    category        = EXCLUDED.category,
    style           = EXCLUDED.style,
    palette         = EXCLUDED.palette,
    adjective       = EXCLUDED.adjective,
    updated_at      = CURRENT_TIMESTAMP;
