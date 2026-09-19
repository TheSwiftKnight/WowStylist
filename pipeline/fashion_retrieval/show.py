"""
show.py

看 RDS 裡到底有沒有東西。唯讀，不會改任何資料。

    npm run db:show            # 最近的 job + 統計 + 最新 10 列
    npm run db:show -- --limit 30
    npm run db:show -- --full  # 印出完整描述，不截斷
    npm run db:show -- --id 42 # 看某一列的全部欄位
"""

import argparse
import sys

from psycopg2.extras import RealDictCursor

from fashion_retrieval.db_reader import get_connection
from fashion_retrieval import db_writer


RULE = "─" * 78


def fetch(conn, sql, params=None):
    with conn.cursor(cursor_factory=RealDictCursor) as cursor:
        # 沒有參數時不要傳空 list —— psycopg2 會去做字串內插
        if params:
            cursor.execute(sql, params)
        else:
            cursor.execute(sql)
        return [dict(row) for row in cursor.fetchall()]


def truncate(text, width):
    if text is None:
        return "—"
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[: width - 1] + "…"


# ============================================================
# ingest_jobs
# ============================================================

def show_jobs(conn, limit: int) -> None:
    print(f"\n{RULE}\n分析進度（ingest_jobs，新到舊）\n{RULE}")

    rows = fetch(
        conn,
        """
        SELECT id, shortcode, instagram_type, status, stage,
               item_count, error, created_at
          FROM ingest_jobs
         ORDER BY id DESC
         LIMIT %s
        """,
        [limit],
    )

    if not rows:
        print("一筆都沒有 —— 連結還沒送進來，或 FastAPI 沒跑起來。")
        return

    print(
        f"{'id':>5}  {'shortcode':<14} {'型態':<5} "
        f"{'狀態':<8} {'階段':<9} {'件數':>4}  時間"
    )

    for row in rows:
        print(
            f"{row['id']:>5}  "
            f"{truncate(row['shortcode'], 14):<14} "
            f"{(row['instagram_type'] or '—'):<5} "
            f"{row['status']:<8} "
            f"{(row['stage'] or '—'):<9} "
            f"{row['item_count']:>4}  "
            f"{row['created_at']:%m-%d %H:%M:%S}"
        )

        if row["error"]:
            print(f"        ↳ {truncate(row['error'], 66)}")


# ============================================================
# 統計
# ============================================================

def show_counts(conn, table: str) -> None:
    print(f"\n{RULE}\n{table} 統計\n{RULE}")

    rows = fetch(
        conn,
        f'''
        SELECT source, category, count(*) AS n,
               count(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
               count(*) FILTER (WHERE image_data IS NOT NULL) AS with_image
          FROM "{table}"
         GROUP BY source, category
         ORDER BY source, category
        ''',
    )

    if not rows:
        print("一筆都沒有。")
        return

    print(
        f"{'source':<12} {'category':<10} {'列數':>6} "
        f"{'有向量':>8} {'有圖':>6}"
    )

    for row in rows:
        print(
            f"{row['source']:<12} {row['category']:<10} "
            f"{row['n']:>6} {row['with_embedding']:>8} "
            f"{row['with_image']:>6}"
        )


# ============================================================
# 最新的列
# ============================================================

def show_rows(conn, table: str, limit: int, full: bool) -> None:
    print(f"\n{RULE}\n最新 {limit} 列\n{RULE}")

    rows = fetch(
        conn,
        f'''
        SELECT id, source, source_item_id, category,
               text_description,
               array_length(embedding, 1) AS dim,
               embedding_model,
               octet_length(image_data)   AS image_bytes,
               image_mime,
               display_tags, outfit_tags,
               instagram_url, instagram_type, shortcode,
               "timestamp", created_at
          FROM "{table}"
         ORDER BY id DESC
         LIMIT %s
        ''',
        [limit],
    )

    if not rows:
        print("一筆都沒有。")
        print(
            "\n如果上面的 job 是 done 但這裡是空的，"
            "看 job 的 error 欄位；\n"
            "如果 job 也沒有，就是連結根本沒送進 FastAPI。"
        )
        return

    for row in rows:
        kb = (row["image_bytes"] or 0) / 1024

        print(
            f"\n#{row['id']}  {row['category']}  ·  "
            f"{row['source_item_id']}"
        )
        print(
            f"   描述  {row['text_description'] if full else truncate(row['text_description'], 66)}"
        )
        print(
            f"   向量  {row['dim']} 維 ({row['embedding_model']})"
            f"   圖片  {kb:.0f} KB ({row['image_mime']})"
        )
        print(
            f"   標籤  {row['display_tags']}"
            f"  /  {row['outfit_tags']}"
        )
        print(
            f"   出處  {row['instagram_url']}"
            f"{'  @' + str(row['timestamp']) + 's' if row['timestamp'] is not None else ''}"
            f"   {row['created_at']:%m-%d %H:%M:%S}"
        )


def show_one(conn, table: str, row_id: int) -> None:
    rows = fetch(
        conn,
        f'''
        SELECT id, source, source_item_id, category, text_description,
               array_length(embedding, 1) AS embedding_dim,
               embedding[1:5]             AS embedding_head,
               embedding_model,
               octet_length(image_data)   AS image_bytes,
               image_mime, display_tags, outfit_tags,
               title, price_twd, product_url,
               instagram_url, instagram_type, shortcode,
               "timestamp", created_at, updated_at
          FROM "{table}"
         WHERE id = %s
        ''',
        [row_id],
    )

    if not rows:
        print(f"找不到 id={row_id}")
        return

    print(f"\n{RULE}\n{table} #{row_id}\n{RULE}")

    for key, value in rows[0].items():
        print(f"{key:<18} {value}")


# ============================================================
# Main
# ============================================================

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--id", type=int)
    args = parser.parse_args()

    table = db_writer.FASHION_TABLE

    try:
        conn = get_connection()
    except Exception as error:
        print(f"連不上資料庫：{error}")
        print("先跑 npm run db:doctor")
        return 1

    try:
        if args.id is not None:
            show_one(conn, table, args.id)
        else:
            show_jobs(conn, args.limit)
            show_counts(conn, table)
            show_rows(conn, table, args.limit, args.full)
        print()
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
