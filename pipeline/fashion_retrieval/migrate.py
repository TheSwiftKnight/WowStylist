"""
migrate.py

跑 migrations/*.sql。用 .env 裡的連線設定，不用自己貼連線字串。

    cd pipeline && python -m fashion_retrieval.migrate
    # 或在專案根目錄： npm run db:migrate

    python -m fashion_retrieval.migrate --dry    # 只印出要跑什麼
"""

import argparse
import os
import sys

from fashion_retrieval.db_reader import get_connection
from fashion_retrieval import db_writer


MIGRATIONS_DIR = os.path.join(
    os.path.dirname(
        os.path.dirname(
            os.path.abspath(__file__)
        )
    ),
    "migrations",
)


def list_migrations() -> list[str]:
    if not os.path.isdir(MIGRATIONS_DIR):
        raise RuntimeError(
            f"找不到 migrations 目錄：{MIGRATIONS_DIR}"
        )

    return sorted(
        os.path.join(MIGRATIONS_DIR, name)
        for name in os.listdir(MIGRATIONS_DIR)
        if name.endswith(".sql")
    )


def strip_psql_commands(sql: str) -> str:
    """
    psql 的反斜線指令（\\set 之類）psycopg2 不認得，拿掉。
    SQL 本身不受影響。
    """

    return "\n".join(
        line
        for line in sql.splitlines()
        if not line.lstrip().startswith("\\")
    )


def run_migration(path: str, dry: bool) -> None:
    name = os.path.basename(path)

    with open(path, encoding="utf-8") as f:
        sql = strip_psql_commands(f.read())

    if dry:
        print(f"\n===== {name} =====")
        print(sql)
        return

    print(f"[migrate] {name} ...")

    conn = get_connection()

    try:
        # psycopg2 的 execute 可以一次跑多條敘述（沒有參數的情況下）
        with conn.cursor() as cursor:
            cursor.execute(sql)
        conn.commit()

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()

    print(f"[migrate] {name} OK")


def main() -> int:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--dry",
        action="store_true",
        help="只印出要跑的 SQL，不連資料庫",
    )

    args = parser.parse_args()

    paths = list_migrations()

    if not paths:
        print("migrations 目錄是空的")
        return 1

    try:
        for path in paths:
            run_migration(path, args.dry)

    except Exception as error:
        print(f"\n[migrate] 失敗：{type(error).__name__}: {error}")
        print("\n先跑 npm run db:doctor 看是哪一關卡住。")
        return 1

    if args.dry:
        return 0

    db_writer.reset_schema_cache()

    table = db_writer.FASHION_TABLE

    columns = db_writer.get_table_columns(table)

    print(
        f"\n[migrate] 完成。{table} 有 {len(columns)} 個欄位，"
        f"upsert index：{db_writer.has_source_unique_index(table)}"
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
