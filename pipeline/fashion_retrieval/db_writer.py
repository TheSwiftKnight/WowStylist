"""
db_writer.py

Purpose
-------
把 fashion_formatter 產出的統一 fashion item 寫進 fashion_items 表。

目標 schema（pipeline/migrations/001_fashion_items.sql）
-------------------------------------------------------
    id              BIGSERIAL PK
    source          'instagram' | 'product'      NOT NULL
    source_item_id  TEXT                         NOT NULL
    category        'top' | 'pants'              NOT NULL
    text_description TEXT                        NOT NULL
    embedding       DOUBLE PRECISION[]           NOT NULL
    embedding_model TEXT                         NOT NULL
    image_data      BYTEA                        NOT NULL
    image_mime      TEXT                         NOT NULL
    display_tags    TEXT[]                       IG only
    outfit_tags     TEXT[]                       IG only
    title           TEXT                         product only
    price_twd       NUMERIC                      product only
    product_url     TEXT                         product only
    instagram_url   TEXT                         IG only
    instagram_type  'post' | 'reel'              IG only
    shortcode       TEXT                         IG only
    timestamp       DOUBLE PRECISION             Reel only
    created_at / updated_at

item 的 key 幾乎跟欄位一對一，只有兩件事要處理：
    - "timestamp" 在 Postgres 是保留字，查詢時一定要加雙引號
    - embedding 欄位可能是 DOUBLE PRECISION[] 或（之後換成）pgvector，
      送出去的格式不一樣

設計重點
--------
1. 欄位自動偵測
   寫入前先讀 information_schema，只寫「表上真的有」的欄位。
   schema 之後多加欄位也不會打架。

2. NOT NULL 先擋
   少了 embedding / image_data 這種必填欄位，在進 SQL 之前就講清楚哪一列有問題，
   不要讓 psycopg2 丟一句看不懂的 IntegrityError。

3. 去重
   靠 (source, source_item_id) 的 unique index 做 upsert。
   index 不在就退成單純 INSERT（會有重複列），並印出提醒。
"""

import os
import json

from psycopg2.extras import RealDictCursor

from fashion_retrieval.db_reader import get_connection


# ============================================================
# Configuration
# ============================================================

FASHION_TABLE = os.getenv("FASHION_TABLE", "fashion_items")

JOB_TABLE = "ingest_jobs"


# item 的 key -> 資料表欄位。相同名字的就不用列。
COLUMN_SOURCE = {
    "source": "source",
    "source_item_id": "source_item_id",
    "category": "category",
    "text_description": "text_description",
    "embedding": "embedding",
    "embedding_model": "embedding_model",
    "image_data": "image_data",
    "image_mime": "image_mime",
    "display_tags": "display_tags",
    "outfit_tags": "outfit_tags",
    "title": "title",
    "price_twd": "price_twd",
    "product_url": "product_url",
    "instagram_url": "instagram_url",
    "instagram_type": "instagram_type",
    "shortcode": "shortcode",
    "timestamp": "timestamp",
}

# 這些欄位是 NOT NULL，缺了就不要送進 SQL
REQUIRED_COLUMNS = (
    "source",
    "source_item_id",
    "category",
    "text_description",
    "embedding",
    "embedding_model",
    "image_data",
    "image_mime",
)


# ============================================================
# Schema introspection
# ============================================================

_column_cache: dict[str, dict[str, str]] = {}
_unique_index_cache: dict[str, bool] = {}


def get_table_columns(
    table_name: str,
    conn=None,
) -> dict[str, str]:
    """
    回傳 {column_name: udt_name}。

    udt_name 用來判斷 embedding 欄位是 '_float8'（DOUBLE PRECISION[]）
    還是 pgvector 的 'vector'。
    """

    if table_name in _column_cache:
        return _column_cache[table_name]

    query = """
        SELECT column_name, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = %s;
    """

    own_conn = conn is None

    if own_conn:
        conn = get_connection()

    try:
        with conn.cursor() as cursor:
            cursor.execute(query, (table_name,))
            rows = cursor.fetchall()
    finally:
        if own_conn:
            conn.close()

    if not rows:
        raise RuntimeError(
            f"Table '{table_name}' not found. "
            f"migration 跑過了嗎？"
            f"（psql -f pipeline/migrations/001_fashion_items.sql）"
        )

    columns = {row[0]: row[1] for row in rows}

    _column_cache[table_name] = columns

    return columns


def has_source_unique_index(
    table_name: str,
    conn=None,
) -> bool:
    """
    (source, source_item_id) 上有沒有 unique index。
    有才能用 ON CONFLICT 做 upsert。
    """

    if table_name in _unique_index_cache:
        return _unique_index_cache[table_name]

    query = """
        SELECT 1
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_attribute a
          ON a.attrelid = t.oid
         AND a.attnum = ANY (i.indkey)
        WHERE t.relname = %s
          AND i.indisunique
        GROUP BY i.indexrelid
        HAVING array_agg(a.attname::text ORDER BY a.attname::text)
               @> ARRAY['source', 'source_item_id']::text[]
           AND count(*) = 2
        LIMIT 1;
    """

    own_conn = conn is None

    if own_conn:
        conn = get_connection()

    try:
        with conn.cursor() as cursor:
            cursor.execute(query, (table_name,))
            found = cursor.fetchone() is not None
    finally:
        if own_conn:
            conn.close()

    _unique_index_cache[table_name] = found

    return found


def reset_schema_cache() -> None:
    """跑完 migration 之後叫一下，讓新欄位 / 新 index 被看見。"""
    _column_cache.clear()
    _unique_index_cache.clear()


# ============================================================
# Value adapters
# ============================================================

def format_embedding(embedding, udt_name: str):
    """
    把 embedding 轉成該欄位型別吃得下的格式。

    DOUBLE PRECISION[]  -> Python list（psycopg2 自己會轉成 ARRAY）
    pgvector 的 vector  -> '[0.1,0.2,...]' 字串
    """

    if embedding is None:
        return None

    values = [float(v) for v in embedding]

    if udt_name in ("_float8", "_float4", "_numeric"):
        return values

    if udt_name == "vector":
        return "[" + ",".join(repr(v) for v in values) + "]"

    if udt_name in ("jsonb", "json", "text"):
        return json.dumps(values)

    raise ValueError(
        f"Unsupported embedding column type: {udt_name}"
    )


def to_binary(image_data):
    """bytes / memoryview -> psycopg2 Binary（bytea）。"""

    if image_data is None:
        return None

    import psycopg2

    if isinstance(image_data, memoryview):
        image_data = image_data.tobytes()

    if isinstance(image_data, bytearray):
        image_data = bytes(image_data)

    if not isinstance(image_data, bytes):
        raise TypeError(
            f"Unsupported image_data type: {type(image_data)}"
        )

    return psycopg2.Binary(image_data)


def clean_tags(tags):
    """TEXT[] 欄位：空陣列當成沒有，比較好查。"""

    if tags is None:
        return None

    cleaned = [
        str(tag).strip()
        for tag in tags
        if str(tag).strip()
    ]

    return cleaned or None


# ============================================================
# Row building
# ============================================================

def build_row(
    item: dict,
    columns: dict[str, str],
) -> dict:
    """
    統一 fashion item -> {欄位: 值}，丟掉表上不存在的欄位。
    """

    candidate = {
        "source": item.get("source"),
        "source_item_id": item.get("source_item_id"),
        "category": item.get("category"),
        "text_description": item.get("text_description"),
        "embedding_model": item.get("embedding_model"),
        "image_data": to_binary(item.get("image_data")),
        "image_mime": item.get("image_mime"),
        "display_tags": clean_tags(item.get("display_tags")),
        "outfit_tags": clean_tags(item.get("outfit_tags")),
        "title": item.get("title"),
        "price_twd": item.get("price_twd"),
        "product_url": item.get("product_url"),
        "instagram_url": item.get("instagram_url"),
        "instagram_type": item.get("instagram_type"),
        "shortcode": item.get("shortcode"),
        "timestamp": item.get("timestamp"),
    }

    if "embedding" in columns:
        candidate["embedding"] = format_embedding(
            item.get("embedding"),
            columns["embedding"],
        )

    row = {}

    for column in COLUMN_SOURCE.values():

        if column not in columns:
            continue

        if column not in candidate:
            continue

        row[column] = candidate[column]

    return row


def validate_row(row: dict, columns: dict[str, str]) -> None:
    """NOT NULL 的欄位先擋下來，錯誤訊息講人話。"""

    missing = [
        column
        for column in REQUIRED_COLUMNS
        if column in columns and row.get(column) is None
    ]

    if missing:
        raise ValueError(
            f"這一列少了必填欄位 {missing}"
            f"（source_item_id={row.get('source_item_id')}）"
        )

    source = row.get("source")

    if source is not None and source not in ("instagram", "product"):
        raise ValueError(
            f"source 只能是 instagram / product，收到 {source!r}"
        )

    category = row.get("category")

    if category is not None and category not in ("top", "pants"):
        raise ValueError(
            f"category 只能是 top / pants，收到 {category!r}"
        )

    ig_type = row.get("instagram_type")

    if ig_type is not None and ig_type not in ("post", "reel"):
        raise ValueError(
            f"instagram_type 只能是 post / reel，收到 {ig_type!r}"
        )


# ============================================================
# Write
# ============================================================

def write_items(
    items: list[dict],
    table_name: str | None = None,
) -> list[int]:
    """
    把一批 fashion item 寫進 fashion_items。

    (source, source_item_id) 上有 unique index 就走 upsert，
    同一則貼文重跑只會更新、不會長出重複列。

    Returns
    -------
    list[int] : 寫進去的 row id
    """

    if not items:
        return []

    table = table_name or FASHION_TABLE

    conn = get_connection()

    try:

        columns = get_table_columns(table, conn=conn)

        can_upsert = has_source_unique_index(table, conn=conn)

        if not can_upsert:
            print(
                "[DB Writer] WARNING: "
                "(source, source_item_id) 上沒有 unique index，"
                "同一則貼文重跑會長出重複列。"
                "建議跑 migrations/001_fashion_items.sql。"
            )

        inserted_ids: list[int] = []

        with conn.cursor() as cursor:

            for index, item in enumerate(items):

                row = build_row(item, columns)

                validate_row(row, columns)

                column_names = list(row.keys())

                # "timestamp" 是保留字，全部欄位一律雙引號包起來最省事
                column_sql = ", ".join(
                    f'"{name}"'
                    for name in column_names
                )

                placeholders = ", ".join(
                    ["%s"] * len(column_names)
                )

                if can_upsert:

                    updates = ", ".join(
                        f'"{name}" = EXCLUDED."{name}"'
                        for name in column_names
                        if name not in ("source", "source_item_id")
                    )

                    conflict_sql = (
                        f"ON CONFLICT (source, source_item_id) "
                        f"DO UPDATE SET {updates}"
                    )

                else:
                    conflict_sql = ""

                sql = (
                    f'INSERT INTO "{table}" ({column_sql}) '
                    f"VALUES ({placeholders}) "
                    f"{conflict_sql} "
                    f"RETURNING id;"
                )

                cursor.execute(sql, list(row.values()))

                result = cursor.fetchone()

                if result:
                    inserted_ids.append(result[0])

                print(
                    f"[DB Writer] "
                    f"{index + 1}/{len(items)} "
                    f"-> id={result[0] if result else '?'} "
                    f"({row.get('category')} · "
                    f"{row.get('source_item_id')})"
                )

        conn.commit()

        return inserted_ids

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()


def DB_write(item: dict) -> int | None:
    """單列版本（fashion_formatter 的 docstring 提到的那個介面）。"""
    ids = write_items([item])
    return ids[0] if ids else None


# ============================================================
# Ingest jobs
# ============================================================

def create_job(
    url: str,
    source_text: str | None = None,
    sender_id: str | None = None,
    sender_name: str | None = None,
) -> int:
    """建立一個 job（status=queued），回傳 job id。"""

    conn = get_connection()

    try:
        with conn.cursor() as cursor:

            cursor.execute(
                f"""
                INSERT INTO {JOB_TABLE}
                    (url, status, source_text,
                     sender_id, sender_name)
                VALUES (%s, 'queued', %s, %s, %s)
                RETURNING id;
                """,
                (url, source_text, sender_id, sender_name),
            )

            job_id = cursor.fetchone()[0]

        conn.commit()

        return job_id

    finally:
        conn.close()


def update_job(job_id: int, **fields) -> None:
    """
    更新 job。可用欄位：
        status, stage, shortcode, instagram_type, item_count, error
    """

    allowed = {
        "status",
        "stage",
        "shortcode",
        "instagram_type",
        "item_count",
        "error",
    }

    patch = {
        key: value
        for key, value in fields.items()
        if key in allowed
    }

    if not patch:
        return

    assignments = ", ".join(
        f"{key} = %s"
        for key in patch
    )

    conn = get_connection()

    try:
        with conn.cursor() as cursor:

            cursor.execute(
                f"UPDATE {JOB_TABLE} "
                f"SET {assignments} "
                f"WHERE id = %s;",
                list(patch.values()) + [job_id],
            )

        conn.commit()

    finally:
        conn.close()


def get_job(job_id: int) -> dict | None:
    """讀一個 job 的狀態。"""

    conn = get_connection()

    try:
        with conn.cursor(
            cursor_factory=RealDictCursor
        ) as cursor:

            cursor.execute(
                f"SELECT * FROM {JOB_TABLE} WHERE id = %s;",
                (job_id,),
            )

            row = cursor.fetchone()

        return dict(row) if row else None

    finally:
        conn.close()


def fail_stale_jobs(older_than_minutes: int = 30) -> int:
    """
    把卡住的 job 標成 failed。

    服務重開（Railway 重新部署、容器被回收、本機 Ctrl-C）時，
    正在跑的 BackgroundTask 會直接消失，job 就永遠停在 running。
    前端的進度條會一直轉，看起來像當掉。

    所以每次服務啟動就把「還在 queued/running 但已經超過這個時間」
    的 job 收掉，並在 error 欄位說明原因。

    Returns
    -------
    int : 被收掉的筆數
    """

    conn = get_connection()

    try:
        with conn.cursor() as cursor:

            cursor.execute(
                f"""
                UPDATE {JOB_TABLE}
                   SET status = 'failed',
                       error  = COALESCE(error, '')
                                || '分析服務在處理途中重啟了，這筆沒跑完。'
                 WHERE status IN ('queued', 'running')
                   AND updated_at < now()
                       - (%s * interval '1 minute')
                RETURNING id;
                """,
                (older_than_minutes,),
            )

            stale = cursor.fetchall()

        conn.commit()

        return len(stale)

    except Exception as error:
        conn.rollback()
        print(f"[DB Writer] 清理卡住的 job 失敗：{error}")
        return 0

    finally:
        conn.close()
