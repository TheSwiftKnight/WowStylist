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

    if is_private_ip(ip):
        line(
            WARN,
            f"DNS -> {ip}（VPC 內網位址）",
        )
        print(
            "\n      這台 RDS 的 Publicly accessible 是 No，"
            "所以從 VPC 外面連不到。\n"
            "      三個選項：\n"
            "        a) AWS Console → RDS → 這個 instance → Modify →\n"
            "           Connectivity → Public access 改成 Publicly accessible，\n"
            "           再去 security group 的 Inbound rules 開 5432 給你的 IP\n"
            "        b) 用 VPC 裡的 EC2 當跳板：\n"
            "           ssh -N -L 5432:<rds-endpoint>:5432 ec2-user@<bastion>\n"
            "           然後把 .env 的 DB_HOST 改成 127.0.0.1\n"
            "        c) 請當初開這台 RDS 的隊友幫忙跑 migration，\n"
            "           或把它的連線方式問清楚\n"
        )
    else:
        line(OK, f"DNS -> {ip}（公開位址）")

    # ---- TCP ----
    try:
        sock = socket.create_connection((host, port), timeout=8)
    except Exception as error:
        line(
            BAD,
            f"TCP 連不上 {port} 埠：{type(error).__name__} {error}",
        )

        if not is_private_ip(ip):
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
