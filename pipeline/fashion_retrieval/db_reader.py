import ipaddress
import os
import sys
from typing import Any

import psycopg2
import requests
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv


load_dotenv()


# ============================================================
# Database connection
# ============================================================

PUBLIC_DNS_URL = "https://dns.google/resolve"


def _is_rds_hostname(host: str) -> bool:
    return (
        ".rds." in host
        and (
            host.endswith(".amazonaws.com")
            or host.endswith(".amazonaws.com.cn")
        )
    )


def _is_public_ipv4(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False

    return address.version == 4 and address.is_global


def resolve_public_host(host: str) -> str | None:
    """
    Resolve an RDS hostname through public DNS.

    Some local/VPN DNS setups intermittently return the RDS VPC address even
    though the instance also has a public endpoint. This resolver is only used
    after the normal database connection fails; VPC deployments therefore keep
    using their private route.
    """

    if not _is_rds_hostname(host):
        return None

    try:
        response = requests.get(
            PUBLIC_DNS_URL,
            params={"name": host, "type": "A"},
            headers={"accept": "application/dns-json"},
            timeout=4,
        )
        response.raise_for_status()
        answers = response.json().get("Answer", [])
    except Exception:
        return None

    for answer in answers:
        value = str(answer.get("data", "")).rstrip(".")
        if _is_public_ipv4(value):
            return value

    return None


def _is_network_error(error: psycopg2.OperationalError) -> bool:
    message = str(error).lower()
    return any(
        marker in message
        for marker in (
            "timeout",
            "timed out",
            "no route to host",
            "network is unreachable",
            "could not translate host name",
        )
    )


# 這個專案有兩台 PostgreSQL：
#
#   DB_*          IG RDS   —— pipeline 寫進來的 IG 單品、ingest_jobs、style_tags
#   PRODUCTS_DB_* 商品 RDS —— 電商商品和它們的向量（只讀）
#
# PRODUCTS_DB_HOST 沒設的話，商品會沿用 IG 那條連線。

PRODUCTS_TABLE = os.getenv("PRODUCTS_TABLE", "products")


def has_separate_products_db() -> bool:
    return bool(os.getenv("PRODUCTS_DB_HOST"))


def _connection_options(prefix: str = "DB_") -> dict[str, Any]:
    return {
        "host": os.getenv(f"{prefix}HOST"),
        "port": os.getenv(f"{prefix}PORT", "5432"),
        "dbname": os.getenv(f"{prefix}NAME"),
        "user": os.getenv(f"{prefix}USER"),
        "password": os.getenv(f"{prefix}PASSWORD"),
        "sslmode": os.getenv(f"{prefix}SSLMODE", "require"),
        "connect_timeout": int(
            os.getenv(f"{prefix}CONNECT_TIMEOUT", "10")
        ),
    }


def _connect(prefix: str = "DB_", label: str = "IG RDS"):
    """
    建立連線。一般 DNS 連不上時會用公共 DNS 再試一次
    （見 resolve_public_host 的說明）。
    """

    required_vars = [
        f"{prefix}HOST",
        f"{prefix}NAME",
        f"{prefix}USER",
        f"{prefix}PASSWORD",
    ]

    missing = [key for key in required_vars if not os.getenv(key)]

    if missing:
        raise RuntimeError(
            f"{label} 的環境變數沒設齊: {', '.join(missing)}"
        )

    options = _connection_options(prefix)

    try:
        return psycopg2.connect(**options)
    except psycopg2.OperationalError as original_error:
        host = str(options["host"])

        if not _is_network_error(original_error):
            raise

        public_ip = resolve_public_host(host)

        if not public_ip:
            raise

        print(
            f"[DB] {host} 的一般 DNS 連線失敗；"
            f"改用公共 DNS 位址 {public_ip} 重試。",
            file=sys.stderr,
        )

        # host keeps the original hostname for TLS/SNI; hostaddr tells libpq
        # which address to dial and prevents another private-DNS lookup.
        return psycopg2.connect(
            **options,
            hostaddr=public_ip,
        )


def get_connection():
    """
    IG RDS：pipeline 寫進來的 IG 單品、ingest_jobs、style_tags。
    """

    return _connect("DB_", "IG RDS")


def get_products_connection():
    """
    商品 RDS：電商商品和它們的向量。跟 IG 那台是不同機器。

    PRODUCTS_DB_HOST 沒設的話退回 IG 那條連線
    （兩批資料放同一台時才會這樣）。
    """

    if not has_separate_products_db():
        return get_connection()

    return _connect("PRODUCTS_DB_", "商品 RDS")


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

    query = f"""
        SELECT
            product_id,
            title,
            price_twd,
            product_url,
            image_data,
            image_mime,
            category
        FROM {PRODUCTS_TABLE}
        WHERE category IN ('top', 'bottom')
          AND image_data IS NOT NULL
    """

    params = []

    if limit is not None:
        query += " LIMIT %s"
        params.append(limit)

    # 商品在商品那台（見 get_products_connection）
    with get_products_connection() as conn:
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
