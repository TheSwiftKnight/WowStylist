import os
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv


load_dotenv()


# ============================================================
# Database connection
# ============================================================

def get_connection():
    """
    Create and return a PostgreSQL connection using environment variables.
    """

    required_vars = [
        "DB_HOST",
        "DB_PORT",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD",
    ]

    missing = [key for key in required_vars if not os.getenv(key)]

    if missing:
        raise RuntimeError(
            f"Missing database environment variables: {', '.join(missing)}"
        )

    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        sslmode=os.getenv("DB_SSLMODE", "require"),
        connect_timeout=int(os.getenv("DB_CONNECT_TIMEOUT", "10")),
    )


# ============================================================
# Database inspection
# ============================================================

def list_tables() -> list[str]:
    """
    Return all table names in the public schema.
    """

    query = """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name;
    """

    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(query)
            rows = cursor.fetchall()

    return [row[0] for row in rows]


def get_columns(table_name: str) -> list[dict[str, Any]]:
    """
    Return column information for a table.
    """

    query = """
        SELECT
            column_name,
            data_type,
            is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = %s
        ORDER BY ordinal_position;
    """

    with get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(query, (table_name,))
            rows = cursor.fetchall()

    return [dict(row) for row in rows]


# ============================================================
# Read raw data
# ============================================================

def fetch_rows(
    table_name: str,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """
    Read raw rows from a table.

    This function is mainly for inspecting the database schema.
    """

    # Prevent arbitrary table names from being inserted into SQL.
    available_tables = list_tables()

    if table_name not in available_tables:
        raise ValueError(
            f"Unknown table: {table_name}. "
            f"Available tables: {available_tables}"
        )

    if limit <= 0:
        raise ValueError("limit must be greater than 0.")

    query = f'SELECT * FROM "{table_name}" LIMIT %s;'

    with get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(query, (limit,))
            rows = cursor.fetchall()

    return [dict(row) for row in rows]


# ============================================================
# Debug / inspection
# ============================================================

def inspect_database(sample_size: int = 3):
    """
    Print tables, columns, and several sample rows.

    Use this only for development/debugging.
    """

    tables = list_tables()

    print("\n==============================")
    print("Database Tables")
    print("==============================")

    if not tables:
        print("No tables found.")
        return

    for table in tables:

        print(f"\n\nTABLE: {table}")
        print("-" * 60)

        columns = get_columns(table)

        print("\nColumns:")

        for column in columns:
            print(
                f"  {column['column_name']:<30}"
                f"{column['data_type']:<25}"
                f"nullable={column['is_nullable']}"
            )

        print(f"\nSample rows (max {sample_size}):")

        rows = fetch_rows(
            table_name=table,
            limit=sample_size,
        )

        for i, row in enumerate(rows, start=1):
            print(f"\n[{i}]")
            for key, value in row.items():
                print(f"{key}: {value}")


def fetch_products(limit=None):
    """
    Fetch products for fashion analysis.

    Current MVP only reads:
        - top
        - bottom

    Database categories are normalized to:
        top    -> top
        bottom -> pants
    """

    if limit is not None and limit <= 0:
        raise ValueError(
            "limit must be greater than 0."
        )

    query = """
        SELECT
            product_id,
            title,
            price_twd,
            product_url,
            image_data,
            image_mime,
            category
        FROM products
        WHERE category IN ('top', 'bottom')
          AND image_data IS NOT NULL
    """

    params = []

    if limit is not None:
        query += " LIMIT %s"
        params.append(limit)

    with get_connection() as conn:
        with conn.cursor(
            cursor_factory=RealDictCursor
        ) as cursor:

            cursor.execute(query, params)
            rows = cursor.fetchall()

    category_map = {
        "top": "top",
        "bottom": "pants",
    }

    products = []

    for row in rows:
        product = dict(row)

        product["category"] = category_map[
            product["category"]
        ]

        products.append(product)

    return products

# ============================================================
# Run directly
# ============================================================

if __name__ == "__main__":
    products = fetch_products(limit=3)

    print(f"\nFetched {len(products)} products.")

    for product in products:
        print("\n" + "=" * 60)
        print("product_id:", product["product_id"])
        print("title:", product["title"])
        print("price_twd:", product["price_twd"])
        print("category:", product["category"])
        print("product_url:", product["product_url"])
        print("image_mime:", product["image_mime"])
        print(
            "image_data:",
            f"{len(product['image_data'])} bytes"
            if product["image_data"]
            else None
        )
