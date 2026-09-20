-- ============================================================
-- WowStylist — Instagram RDS schema
--
-- 目標資料庫：IG 那台 RDS（instagram-post-db...，DB_NAME=postgres）
-- idempotent，重跑不會壞。
--
-- 跑法：
--   psql "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:5432/$DB_NAME?sslmode=require" \
--        -f pipeline/migrations/001_fashion_items.sql
-- ============================================================

\set ON_ERROR_STOP on


-- ------------------------------------------------------------
-- 1) fashion_items — Instagram 單品與商品共用的統一表
--    一條 IG 連結 → pipeline → 多列（一件衣服一列）
--
--    這段是規格書上的 DDL，原封不動。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fashion_items (
    id BIGSERIAL PRIMARY KEY,

    -- Data source
    source TEXT NOT NULL
        CHECK (source IN ('instagram', 'product')),

    -- Original source ID
    -- Product: product_id
    -- Instagram: generated garment ID
    source_item_id TEXT NOT NULL,

    -- Garment category
    category TEXT NOT NULL
        CHECK (category IN ('top', 'pants')),

    -- Claude-generated semantic description
    text_description TEXT NOT NULL,

    -- BGE-M3 semantic embedding
    embedding DOUBLE PRECISION[] NOT NULL,

    embedding_model TEXT NOT NULL
        DEFAULT 'BAAI/bge-m3',

    -- Original image stored as binary
    image_data BYTEA NOT NULL,

    image_mime TEXT NOT NULL,

    -- UI tags
    -- Instagram only; NULL for products
    display_tags TEXT[],

    outfit_tags TEXT[],

    -- Product metadata
    -- NULL for Instagram
    title TEXT,
    price_twd NUMERIC,
    product_url TEXT,

    -- Instagram metadata
    -- NULL for products
    instagram_url TEXT,
    instagram_type TEXT
        CHECK (
            instagram_type IS NULL
            OR instagram_type IN ('post', 'reel')
        ),

    shortcode TEXT,

    -- Reel timestamp; NULL for Post/Product
    timestamp DOUBLE PRECISION,

    -- System metadata
    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
);


-- ------------------------------------------------------------
-- 2) 索引（不動欄位，只是加索引）
--
--    ux_fashion_items_source：同一件衣服重跑不要長出第二列。
--    db_writer.py 會先確認這個 unique index 在不在，
--    在就走 ON CONFLICT upsert，不在就單純 INSERT（會有重複列）。
--    所以這行建議留著。
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_fashion_items_source
    ON fashion_items (source, source_item_id);

CREATE INDEX IF NOT EXISTS ix_fashion_items_created_at
    ON fashion_items (created_at DESC);

CREATE INDEX IF NOT EXISTS ix_fashion_items_category
    ON fashion_items (category);

CREATE INDEX IF NOT EXISTS ix_fashion_items_shortcode
    ON fashion_items (shortcode);


-- ------------------------------------------------------------
-- 3) ingest_jobs — 一條 IG 連結 = 一個 job
--
--    Next.js 直接讀這張表來顯示「分析中 / 完成 / 失敗」，
--    不用去 poll Python service（那支重開也不會掉狀態）。
--    LINE 分享人的資訊放這裡（fashion_items 沒有這兩個欄位）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_jobs (
    id             BIGSERIAL PRIMARY KEY,
    url            TEXT        NOT NULL,
    shortcode      TEXT,
    instagram_type TEXT,                                  -- 'post' | 'reel'
    status         TEXT        NOT NULL DEFAULT 'queued', -- queued | running | done | failed
    stage          TEXT,                                  -- apify / parse / filter / analyze / encode / write
    item_count     INTEGER     NOT NULL DEFAULT 0,
    error          TEXT,
    source_text    TEXT,
    sender_id      TEXT,
    sender_name    TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_jobs_status     ON ingest_jobs (status);
CREATE INDEX IF NOT EXISTS ix_jobs_created_at ON ingest_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_jobs_shortcode  ON ingest_jobs (shortcode);


-- ------------------------------------------------------------
-- 4) style_tags — style 風向標（原本在 Prisma 的 StyleTag）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS style_tags (
    id         TEXT PRIMARY KEY,
    label      TEXT             NOT NULL,
    kind       TEXT             NOT NULL DEFAULT 'style',  -- style | color | mood
    weight     DOUBLE PRECISION NOT NULL DEFAULT 0.5,      -- 0~1，決定字級
    owner_id   TEXT,                                       -- LINE userId
    created_at TIMESTAMPTZ      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ      NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_style_tags_weight ON style_tags (weight DESC);


-- ------------------------------------------------------------
-- 5) updated_at 自動更新
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fashion_items_touch ON fashion_items;
CREATE TRIGGER trg_fashion_items_touch BEFORE UPDATE ON fashion_items
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_jobs_touch ON ingest_jobs;
CREATE TRIGGER trg_jobs_touch BEFORE UPDATE ON ingest_jobs
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_style_tags_touch ON style_tags;
CREATE TRIGGER trg_style_tags_touch BEFORE UPDATE ON style_tags
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ============================================================
-- 之後要做語意檢索的話
-- ============================================================
-- embedding 目前是 DOUBLE PRECISION[]，cosine 要在應用層算。
-- 資料量大到需要向量索引時再加一個 pgvector 欄位：
--
--   CREATE EXTENSION IF NOT EXISTS vector;
--   ALTER TABLE fashion_items ADD COLUMN embedding_v vector(1024);
--   UPDATE fashion_items SET embedding_v = embedding::real[]::vector;
--   CREATE INDEX ON fashion_items USING ivfflat (embedding_v vector_cosine_ops);
--
-- db_writer.py 會自動偵測欄位型別，兩種都寫得進去，程式不用改。
