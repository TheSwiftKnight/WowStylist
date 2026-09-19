"""
pipeline.py

Purpose
-------
把 Instagram URL 一路跑到 RDS 的 orchestrator。

    Instagram URL
          │
          ▼
        Apify              apify_client.fetch_instagram_post()
          │
          ├── Post ──► post_parser.parse_post()
          └── Reel ──► reel_parser.parse_reel()
          │
          ▼
      Image Filter         image_filter.filter_post / filter_reel
     (Claude + dHash)
          │
          ▼
    Fashion Analyzer       fashion_analyzer.analyze_post / analyze_reel
        (Claude)
          │
          ▼
   Garment Description
          │
          ▼
      BGE-M3 Encoder       fashion_formatter.build_instagram_item()
          │
          ▼
     Semantic Embedding
          │
          ▼
        IG RDS             db_writer.write_items()

這支是 WowStylist 的 Next.js 會透過 api/main.py 呼叫的進入點。

CLI:
    python -m fashion_retrieval.pipeline "https://www.instagram.com/p/XXXX/"
"""

import os
import re
import sys
import traceback


def _missing(error: "ModuleNotFoundError") -> "ModuleNotFoundError":
    """套件沒裝的時候，把訊息換成看得懂的。"""

    return ModuleNotFoundError(
        f"缺少套件 '{error.name}'。\n"
        f"在專案根目錄跑：  npm run pipeline:install\n"
        f"（或在 pipeline/ 裡：python3 -m pip install -r requirements.txt）\n"
        f"目前用的 python：{sys.executable}\n"
        f"裝完還是一樣的話跑 npm run db:doctor，"
        f"它會告訴你套件裝到哪個環境去了。"
    )


try:
    from fashion_retrieval.apify_client import fetch_instagram_post
    from fashion_retrieval.post_parser import parse_post
    from fashion_retrieval.reel_parser import parse_reel
    from fashion_retrieval.image_filter import filter_post, filter_reel
    from fashion_retrieval.fashion_analyzer import (
        analyze_post,
        analyze_reel,
    )
    from fashion_retrieval.fashion_formatter import build_instagram_item
    from fashion_retrieval import db_writer

except ModuleNotFoundError as error:
    raise _missing(error) from error


# ============================================================
# Configuration
# ============================================================

# Reel 常常好幾個 frame 拍到同一套衣服。描述文字太像就只留一件。
# 0 = 關掉這個去重。
DEDUP_THRESHOLD = float(
    os.getenv("GARMENT_DEDUP_THRESHOLD", "0.82")
)


IG_URL_RE = re.compile(
    r"https?://(?:www\.)?instagram\.com/"
    r"(?:[A-Za-z0-9_.]+/)?"
    r"(p|reel|reels|tv)/([A-Za-z0-9_-]+)"
)


# ============================================================
# URL helpers
# ============================================================

def normalize_instagram_url(url: str) -> tuple[str, str]:
    """
    'https://www.instagram.com/someone/reel/ABC123/?igsh=xxx'
        -> ('https://www.instagram.com/reel/ABC123/', 'ABC123')

    Apify 對乾淨的網址比較穩，query string 也會讓去重失效。
    """

    if not url or not url.strip():
        raise ValueError("Instagram URL cannot be empty.")

    match = IG_URL_RE.search(url.strip())

    if not match:
        raise ValueError(
            f"Not an Instagram post/reel URL: {url}"
        )

    kind_token = match.group(1)
    shortcode = match.group(2)

    path = (
        "reel"
        if kind_token in ("reel", "reels")
        else "tv"
        if kind_token == "tv"
        else "p"
    )

    clean = (
        f"https://www.instagram.com/"
        f"{path}/{shortcode}/"
    )

    return clean, shortcode


def detect_media_type(raw_data: dict) -> str:
    """
    從 Apify 的原始結果判斷這是 Post 還是 Reel。

    Apify 的 type 會是 'Image' / 'Sidecar' / 'Video'。
    Reel 一定有 videoUrl。
    """

    post_type = (raw_data.get("type") or "").lower()

    if post_type == "video":
        return "reel"

    if raw_data.get("videoUrl"):
        return "reel"

    return "post"


# ============================================================
# Garment dedup
# ============================================================

def _tokens(text: str) -> set[str]:
    return set(
        re.findall(r"[a-z]+", (text or "").lower())
    )


def deduplicate_garments(
    samples: list[dict],
    threshold: float = DEDUP_THRESHOLD,
) -> list[dict]:
    """
    同一個 category 底下，描述文字重疊度超過 threshold 的就當成同一件。

    純字串比對，不花 API 錢。Reel 的 dHash 去重是「畫面」層級，
    這一層是「衣服」層級 —— 換了機位但衣服沒換的 frame 會在這裡被收掉。
    """

    if threshold <= 0 or not samples:
        return samples

    kept: list[dict] = []
    seen: list[tuple[str, set[str]]] = []

    for sample in samples:

        category = sample.get("category")

        tokens = _tokens(
            sample.get("text_description")
        )

        if not tokens:
            continue

        duplicate = False

        for prev_category, prev_tokens in seen:

            if prev_category != category:
                continue

            union = tokens | prev_tokens

            if not union:
                continue

            similarity = (
                len(tokens & prev_tokens) / len(union)
            )

            if similarity >= threshold:
                duplicate = True
                break

        if duplicate:
            print(
                f"[Pipeline] Skipping duplicate "
                f"{category} garment."
            )
            continue

        seen.append((category, tokens))
        kept.append(sample)

    print(
        f"[Pipeline] Garment dedup: "
        f"{len(samples)} → {len(kept)}"
    )

    return kept


# ============================================================
# source_item_id
# ============================================================

def build_source_item_id(
    shortcode: str,
    media_type: str,
    sample: dict,
) -> str:
    """
    同一則貼文重跑時用來 upsert 的鍵。

    post: <shortcode>_p<image_index>_<garment_index>_<category>
    reel: <shortcode>_t<timestamp>_<garment_index>_<category>
    """

    category = sample.get("category", "item")

    garment_index = sample.get("garment_index", 0)

    if media_type == "reel":
        marker = f"t{sample.get('timestamp', 0)}"
    else:
        marker = f"p{sample.get('image_index', 0)}"

    return (
        f"{shortcode}_{marker}_"
        f"{garment_index}_{category}"
    )


# ============================================================
# Row preview
# ============================================================

def preview_item(item: dict) -> dict:
    """
    把要寫進 fashion_items 的一列變成看得懂的樣子。

    key 就是資料表的欄位名，只有兩個欄位換掉：
    image_data 是幾百 KB 的 bytes、embedding 是 1024 個浮點數，
    直接印出來沒有意義，所以換成 image_bytes / embedding_dim。
    """

    embedding = item.get("embedding") or []

    image_data = item.get("image_data") or b""

    return {
        # NOT NULL
        "source": item.get("source"),
        "source_item_id": item.get("source_item_id"),
        "category": item.get("category"),
        "text_description": item.get("text_description"),
        "embedding_dim": len(embedding),          # 實際欄位：embedding
        "embedding_model": item.get("embedding_model"),
        "image_bytes": len(image_data),           # 實際欄位：image_data
        "image_mime": item.get("image_mime"),

        # Instagram only
        "display_tags": item.get("display_tags"),
        "outfit_tags": item.get("outfit_tags"),
        "instagram_url": item.get("instagram_url"),
        "instagram_type": item.get("instagram_type"),
        "shortcode": item.get("shortcode"),
        "timestamp": item.get("timestamp"),

        # Product only（IG 一律 None）
        "title": item.get("title"),
        "price_twd": item.get("price_twd"),
        "product_url": item.get("product_url"),
    }


# ============================================================
# Main entry point
# ============================================================

def run_instagram_url(
    url: str,
    job_id: int | None = None,
    sender_id: str | None = None,
    sender_name: str | None = None,
    write_to_db: bool = True,
) -> dict:
    """
    跑完整條 Instagram pipeline 並寫進 RDS。

    Parameters
    ----------
    url : str
        Instagram Post / Reel 連結（可以帶 query string）。

    job_id : int | None
        ingest_jobs 的 id。有給的話每個階段都會回寫進度，
        Next.js 前端就能顯示「分析中…」。

    sender_id / sender_name : str | None
        LINE 分享人。只記在 ingest_jobs 上 —— fashion_items 的 schema
        沒有這兩個欄位（那張表只描述衣服本身）。

    write_to_db : bool
        False 的話只跑分析不寫 DB（除錯用）。

    Returns
    -------
    {
        "url": ...,
        "shortcode": ...,
        "instagram_type": "post" | "reel",
        "outfit_tags": [...],
        "item_count": 3,
        "item_ids": [11, 12, 13],
        "rows": [ ...每一列的預覽，見 preview_item()... ],
    }
    """

    def stage(name: str) -> None:
        print(f"\n[Pipeline] === {name} ===")
        if job_id is not None:
            db_writer.update_job(
                job_id,
                status="running",
                stage=name,
            )

    clean_url, shortcode = normalize_instagram_url(url)

    if job_id is not None:
        db_writer.update_job(
            job_id,
            shortcode=shortcode,
        )

    # --------------------------------------------------------
    # 1. Apify（只打一次，raw 再傳給 parser 重用）
    # --------------------------------------------------------

    stage("apify")

    raw_data = fetch_instagram_post(clean_url)

    media_type = detect_media_type(raw_data)

    print(
        f"[Pipeline] Detected media type: {media_type}"
    )

    if job_id is not None:
        db_writer.update_job(
            job_id,
            instagram_type=media_type,
        )

    # --------------------------------------------------------
    # 2. Parse
    # --------------------------------------------------------

    stage("parse")

    if media_type == "reel":
        parsed = parse_reel(clean_url, raw_data=raw_data)
    else:
        parsed = parse_post(clean_url, raw_data=raw_data)

    # --------------------------------------------------------
    # 3. Filter
    # --------------------------------------------------------

    stage("filter")

    if media_type == "reel":
        filtered = filter_reel(parsed)
    else:
        filtered = filter_post(parsed)

    if not filtered.get("items"):

        print(
            "[Pipeline] No usable image after filtering."
        )

        if job_id is not None:
            db_writer.update_job(
                job_id,
                status="done",
                stage="filter",
                item_count=0,
                error="沒有可用的服裝畫面",
            )

        return {
            "url": clean_url,
            "shortcode": shortcode,
            "instagram_type": media_type,
            "outfit_tags": [],
            "item_count": 0,
            "item_ids": [],
            "rows": [],
        }

    # --------------------------------------------------------
    # 4. Analyze（Claude Vision）
    # --------------------------------------------------------

    stage("analyze")

    if media_type == "reel":
        analysis = analyze_reel(filtered)
    else:
        analysis = analyze_post(filtered)

    outfit_tags = analysis.get("outfit_tags", [])

    samples = deduplicate_garments(
        analysis.get("samples", [])
    )

    if not samples:

        print("[Pipeline] No garment detected.")

        if job_id is not None:
            db_writer.update_job(
                job_id,
                status="done",
                stage="analyze",
                item_count=0,
                error="沒有辨識到上衣或褲子",
            )

        return {
            "url": clean_url,
            "shortcode": shortcode,
            "instagram_type": media_type,
            "outfit_tags": outfit_tags,
            "item_count": 0,
            "item_ids": [],
            "rows": [],
        }

    # --------------------------------------------------------
    # 5. Encode（BGE-M3）+ 組成統一格式
    # --------------------------------------------------------

    stage("encode")

    items: list[dict] = []

    for sample in samples:

        # formatter 會從 garment 上讀 outfit_tags，
        # analyze_* 把它放在貼文層級，這裡補回去。
        sample["outfit_tags"] = outfit_tags

        source_item_id = build_source_item_id(
            shortcode,
            media_type,
            sample,
        )

        try:
            item = build_instagram_item(
                sample,
                instagram_url=clean_url,
                instagram_type=media_type,
                shortcode=shortcode,
                source_item_id=source_item_id,
            )

        except Exception as error:

            print(
                f"[Pipeline] WARNING: skipping garment "
                f"{source_item_id}: {error}"
            )

            continue

        items.append(item)

    if not items:

        if job_id is not None:
            db_writer.update_job(
                job_id,
                status="failed",
                stage="encode",
                item_count=0,
                error="所有單品編碼都失敗",
            )

        raise RuntimeError(
            "All garments failed to encode."
        )

    # --------------------------------------------------------
    # 6. Write
    # --------------------------------------------------------

    item_ids: list[int] = []

    if write_to_db:

        stage("write")

        item_ids = db_writer.write_items(items)

    print(
        f"\n[Pipeline] Done. "
        f"{len(items)} garment(s) written."
    )

    if job_id is not None:
        db_writer.update_job(
            job_id,
            status="done",
            stage="write",
            item_count=len(item_ids or items),
            error=None,
        )

    return {
        "url": clean_url,
        "shortcode": shortcode,
        "instagram_type": media_type,
        "outfit_tags": outfit_tags,
        "item_count": len(item_ids or items),
        "item_ids": item_ids,
        "rows": [preview_item(item) for item in items],
    }


def run_instagram_url_safe(
    url: str,
    job_id: int | None = None,
    **kwargs,
) -> dict:
    """
    背景執行用的包裝：不往外丟例外，改成把錯誤寫進 job。
    """

    try:
        return run_instagram_url(
            url,
            job_id=job_id,
            **kwargs,
        )

    except Exception as error:

        traceback.print_exc()

        if job_id is not None:
            try:
                db_writer.update_job(
                    job_id,
                    status="failed",
                    error=f"{type(error).__name__}: {error}"[:2000],
                )
            except Exception:
                traceback.print_exc()

        return {
            "url": url,
            "error": f"{type(error).__name__}: {error}",
            "item_count": 0,
            "item_ids": [],
            "rows": [],
        }


# ============================================================
# CLI
# ============================================================

def main() -> None:

    import argparse
    import json

    parser = argparse.ArgumentParser(
        description=(
            "Run the Instagram → garment → RDS pipeline."
        )
    )

    parser.add_argument("url")

    parser.add_argument(
        "--no-db",
        action="store_true",
        help="只跑分析，不寫進資料庫",
    )

    args = parser.parse_args()

    result = run_instagram_url(
        args.url,
        write_to_db=not args.no_db,
    )

    print("\n" + json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
