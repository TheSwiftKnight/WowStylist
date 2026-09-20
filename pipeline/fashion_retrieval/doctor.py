"""
doctor.py

跑之前先檢查環境：環境變數、套件、DNS、TCP、資料表。

    cd pipeline && python -m fashion_retrieval.doctor
    # 或在專案根目錄： npm run db:doctor

不會寫入任何東西，純檢查。
"""

import importlib.util
import os
import socket
import ssl
import sys

from dotenv import load_dotenv, find_dotenv


OK = "  ok  "
BAD = " FAIL "
WARN = " warn "


def line(status: str, text: str) -> None:
    print(f"[{status}] {text}")


# ============================================================
# 1. .env
# ============================================================

def check_env_file() -> None:
    print("\n── .env ─────────────────────────────────────────")

    path = find_dotenv()

    if path:
        line(OK, f"讀到 {path}")
    else:
        line(BAD, "找不到 .env（應該在 WowStylist 專案根目錄）")

    load_dotenv()


def check_env_vars() -> bool:
    print("\n── 環境變數 ─────────────────────────────────────")

    required = {
        "APIFY_TOKEN": "Instagram 抓取",
        "ANTHROPIC_API_KEY": "Claude（篩圖 + 辨識服裝）",
        "HF_TOKEN": "BGE-M3 語意向量",
        "DB_HOST": "RDS",
        "DB_NAME": "RDS",
        "DB_USER": "RDS",
        "DB_PASSWORD": "RDS",
    }

    all_ok = True

    for key, why in required.items():
        if os.getenv(key):
            line(OK, f"{key:20} {why}")
        else:
            line(BAD, f"{key:20} {why} ← 沒設")
            all_ok = False

    table = os.getenv("FASHION_TABLE", "fashion_items")
    line(OK, f"{'FASHION_TABLE':20} {table}")

    # 商品是另一台 RDS，沒設的話就是沿用 IG 那條
    if os.getenv("PRODUCTS_DB_HOST"):
        line(OK, f"{'PRODUCTS_DB_HOST':20} 商品 RDS（獨立一台）")
        for key in (
            "PRODUCTS_DB_NAME",
            "PRODUCTS_DB_USER",
            "PRODUCTS_DB_PASSWORD",
        ):
            if os.getenv(key):
                line(OK, f"{key:20} 商品 RDS")
            else:
                line(BAD, f"{key:20} 商品 RDS ← 沒設")
                all_ok = False
        line(
            OK,
            f"{'PRODUCTS_TABLE':20} "
            f"{os.getenv('PRODUCTS_TABLE', 'products')}",
        )
    else:
        line(
            WARN,
            f"{'PRODUCTS_DB_HOST':20} 沒設 —— 商品會沿用 IG 那條連線。"
            f"商品在另一台 RDS 的話要補這組。",
        )

    return all_ok


# ============================================================
# 2. Python 套件
# ============================================================

def check_packages() -> bool:
    print("\n── Python 套件 ──────────────────────────────────")

    packages = {
        "anthropic": "anthropic",
        "apify_client": "apify-client",
        "huggingface_hub": "huggingface-hub",
        "psycopg2": "psycopg2-binary",
        "cv2": "opencv-python-headless",
        "PIL": "pillow",
        "numpy": "numpy",
        "requests": "requests",
        "dotenv": "python-dotenv",
        "fastapi": "fastapi",
        "uvicorn": "uvicorn",
    }

    missing = []

    for module, package in packages.items():
        if importlib.util.find_spec(module):
            line(OK, package)
        else:
            line(BAD, f"{package} ← 沒裝")
            missing.append(package)

    if missing:
        print("\n      修法（在專案根目錄）：npm run pipeline:install")
        print(f"      目前的 python：{sys.executable}")

        if ".venv" not in sys.executable:
            print(
                "      ↑ 這不是 pipeline/.venv 裡的 python。"
                "用 npm run 的指令會自動走 venv；\n"
                "        手動跑的話先 source pipeline/.venv/bin/activate。"
            )

    return not missing


# ============================================================
# 3. 網路
# ============================================================

def is_private_ip(ip: str) -> bool:
    parts = ip.split(".")

    if len(parts) != 4:
        return False

    try:
        a, b = int(parts[0]), int(parts[1])
    except ValueError:
        return False

    return (
        a == 10
        or (a == 172 and 16 <= b <= 31)
        or (a == 192 and b == 168)
    )


def check_network() -> bool:
    print("\n── RDS 連線 ─────────────────────────────────────")

    host = os.getenv("DB_HOST")
    port = int(os.getenv("DB_PORT", "5432"))

    if not host:
        line(BAD, "DB_HOST 沒設，跳過")
        return False

    line(OK, f"host = {host}:{port}")

    # ---- DNS ----
    try:
        ip = socket.gethostbyname(host)
    except Exception as error:
        line(BAD, f"DNS 解不出來：{error}")
        return False

    fallback_ip = None

    if is_private_ip(ip):
        line(
            WARN,
            f"DNS -> {ip}（VPC 內網位址）",
        )

        from fashion_retrieval.db_reader import resolve_public_host

        fallback_ip = resolve_public_host(host)

        if fallback_ip:
            line(
                WARN,
                f"公共 DNS -> {fallback_ip}（連線失敗時會自動改走這個位址）",
            )
    else:
        line(OK, f"DNS -> {ip}（公開位址）")

    # ---- TCP ----
    try:
        tcp_host = fallback_ip or host
        sock = socket.create_connection((tcp_host, port), timeout=8)
    except Exception as error:
        line(
            BAD,
            f"TCP 連不上 {port} 埠：{type(error).__name__} {error}",
        )

        if is_private_ip(ip) and not fallback_ip:
            print(
                "\n      系統與公共 DNS 都沒有可用的公開位址。"
                "請確認 RDS 的 Publicly accessible 已開啟，\n"
                "      或從 VPC／SSH 跳板連線。\n"
            )
        elif not is_private_ip(ip):
            print(
                "\n      DNS 是公開位址但連不上，"
                "通常是 security group 沒開你的 IP。\n"
                "      AWS Console → RDS → 這個 instance → "
                "Connectivity & security → VPC security groups →\n"
                "      Inbound rules → Add rule：PostgreSQL / 5432 / My IP\n"
            )

        return False

    sock.close()
    line(OK, "TCP 通")

    return True


# ============================================================
# 4. 資料表
# ============================================================

def check_database() -> bool:
    print("\n── 資料表 ───────────────────────────────────────")

    try:
        from fashion_retrieval import db_writer
    except Exception as error:
        line(BAD, f"載入 db_writer 失敗：{error}")
        return False

    table = db_writer.FASHION_TABLE

    try:
        columns = db_writer.get_table_columns(table)
    except Exception as error:
        line(BAD, f"{error}")
        print(
            "\n      修法（在專案根目錄）：npm run db:migrate\n"
        )
        return False

    line(OK, f"{table} 有 {len(columns)} 個欄位")

    expected = {
        "source": None,
        "source_item_id": None,
        "category": None,
        "text_description": None,
        "embedding": ("_float8", "vector"),
        "embedding_model": None,
        "image_data": None,
        "image_mime": None,
        "display_tags": None,
        "outfit_tags": None,
        "instagram_url": None,
        "instagram_type": None,
        "shortcode": None,
        "timestamp": None,
    }

    all_ok = True

    for column, allowed_types in expected.items():

        udt = columns.get(column)

        if udt is None:
            line(BAD, f"{table}.{column} ← 沒有這個欄位")
            all_ok = False
            continue

        if allowed_types and udt not in allowed_types:
            line(
                WARN,
                f"{table}.{column} 型別是 {udt}"
                f"（預期 {' / '.join(allowed_types)}）",
            )
            continue

        line(OK, f"{table}.{column} ({udt})")

    if db_writer.has_source_unique_index(table):
        line(OK, "(source, source_item_id) unique index")
    else:
        line(
            WARN,
            "(source, source_item_id) 沒有 unique index "
            "→ 同一則貼文重跑會長出重複列",
        )

    for other in ("ingest_jobs", "style_tags"):
        try:
            db_writer.get_table_columns(other)
            line(OK, other)
        except Exception:
            line(BAD, f"{other} ← 沒有這張表")
            all_ok = False

    # ── 商品那台 ──
    from fashion_retrieval import db_reader

    products_table = db_reader.PRODUCTS_TABLE

    if db_reader.has_separate_products_db():
        where = f"商品 RDS 的 {products_table}"
    else:
        where = f"IG RDS 的 {products_table}（共用連線）"

    try:
        with db_reader.get_products_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"SELECT count(*) FROM {products_table} "
                    f"WHERE embedding IS NOT NULL"
                )
                count = cursor.fetchone()[0]

        if count > 0:
            line(OK, f"{where}：{count} 筆帶 embedding")
        else:
            line(
                WARN,
                f"{where}：有表但沒有任何 embedding → 推薦排不出東西",
            )

    except Exception as error:
        line(BAD, f"{where} 讀不到：{error}")
        print(
            "\n      商品在另一台 RDS 的話，.env 要設 PRODUCTS_DB_HOST / "
            "_PORT / _NAME / _USER / _PASSWORD。\n"
        )
        all_ok = False

    if not all_ok:
        print("\n      修法（在專案根目錄）：npm run db:migrate\n")

    return all_ok


# ============================================================
# Main
# ============================================================

def main() -> int:
    print("=" * 52)
    print("WowStylist pipeline · 環境檢查")
    print("=" * 52)

    check_env_file()

    env_ok = check_env_vars()
    packages_ok = check_packages()
    network_ok = check_network()

    database_ok = False

    if network_ok and packages_ok:
        database_ok = check_database()
    else:
        print("\n── 資料表 ───────────────────────────────────────")
        line(WARN, "前面沒過，跳過")

    print("\n" + "=" * 52)

    if env_ok and packages_ok and network_ok and database_ok:
        print("全部通過 → npm run pipeline")
        return 0

    print("上面標 FAIL 的修掉再跑一次：npm run db:doctor")
    return 1


if __name__ == "__main__":
    sys.exit(main())
