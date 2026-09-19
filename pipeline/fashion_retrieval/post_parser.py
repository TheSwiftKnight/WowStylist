"""
post_parser.py

Purpose
-------
Convert an Instagram Post / Carousel URL into local images + text.

Pipeline
--------
Instagram Post URL
    ↓
apify_client.py
    ↓
Apify raw JSON
    ↓
Extract image URLs
    ↓
Download images
    ↓
Return standardized image + text structure

Input
-----
Instagram Post URL (str)

Output
------
dict:
{
    "source": "instagram",
    "type": "post",
    "url": "...",
    "shortcode": "...",
    "items": [
        {
            "image_path": "...",
            "text": "..."
        }
    ]
}
"""

import os
import requests

from fashion_retrieval.apify_client import fetch_instagram_post


# ============================================================
# Configuration
# ============================================================


# 輸出目錄固定在 pipeline/outputs 底下，不跟著 cwd 走
# （uvicorn 從哪裡啟動都一樣，Next.js 那側也不用管）。
_PACKAGE_ROOT = os.path.dirname(
    os.path.dirname(
        os.path.abspath(__file__)
    )
)

OUTPUT_BASE = os.getenv(
    "PIPELINE_OUTPUT_DIR",
    os.path.join(_PACKAGE_ROOT, "outputs"),
)

OUTPUT_ROOT = os.path.join(OUTPUT_BASE, "posts")


# ============================================================
# Download image
# ============================================================

def download_image(image_url: str, output_path: str) -> None:
    """
    Download one image from URL.

    Parameters
    ----------
    image_url : str
        Remote image URL.

    output_path : str
        Local path where the image will be saved.
    """

    response = requests.get(
        image_url,
        timeout=30
    )

    response.raise_for_status()

    with open(output_path, "wb") as f:
        f.write(response.content)


# ============================================================
# Extract image URLs
# ============================================================

def extract_image_urls(raw_data: dict) -> list[str]:
    """
    Extract all image URLs from Apify result.

    Supports:
    - Single image post
    - Carousel / Sidecar post
    """

    image_urls = []

    # --------------------------------------------------------
    # Case 1:
    # Apify directly provides images[]
    # --------------------------------------------------------

    images = raw_data.get("images", [])

    if images:
        image_urls.extend(images)

    # --------------------------------------------------------
    # Case 2:
    # Carousel children
    # --------------------------------------------------------

    child_posts = raw_data.get("childPosts", [])

    if child_posts:

        # If childPosts exists, prefer it because it represents
        # individual carousel items more clearly.
        child_urls = []

        for child in child_posts:

            display_url = child.get("displayUrl")

            if display_url:
                child_urls.append(display_url)

        if child_urls:
            image_urls = child_urls

    # --------------------------------------------------------
    # Case 3:
    # Single image displayUrl
    # --------------------------------------------------------

    if not image_urls:

        display_url = raw_data.get("displayUrl")

        if display_url:
            image_urls.append(display_url)

    # Remove duplicates while keeping order
    image_urls = list(dict.fromkeys(image_urls))

    return image_urls


# ============================================================
# Main parser
# ============================================================

def parse_post(
    post_url: str,
    raw_data: dict | None = None,
) -> dict:
    """
    Parse an Instagram Post / Carousel.

    Parameters
    ----------
    post_url : str
        Instagram Post URL.

    raw_data : dict | None
        Apify 的原始 JSON。pipeline 已經抓過一次的話直接傳進來，
        可以省掉重複的 Apify run（Apify 是按次計費的）。

    Returns
    -------
    dict
        Standardized post data containing local image paths
        and post caption.
    """

    # --------------------------------------------------------
    # 1. Fetch Instagram data from Apify
    # --------------------------------------------------------

    if raw_data is None:

        print("\n[Post Parser] Fetching Instagram post...")

        raw_data = fetch_instagram_post(post_url)

    else:

        print("\n[Post Parser] Reusing Apify result.")

    # --------------------------------------------------------
    # 2. Basic information
    # --------------------------------------------------------

    post_type = raw_data.get("type")
    shortcode = raw_data.get(
        "shortCode",
        "unknown_post"
    )

    caption = raw_data.get("caption") or ""

    print(f"[Post Parser] Type: {post_type}")
    print(f"[Post Parser] ShortCode: {shortcode}")

    # --------------------------------------------------------
    # 3. Reject Reel / Video for now
    # --------------------------------------------------------

    if post_type == "Video":

        raise ValueError(
            "This is a Reel/Video. "
            "Please use reel_parser instead."
        )

    # --------------------------------------------------------
    # 4. Extract image URLs
    # --------------------------------------------------------

    image_urls = extract_image_urls(raw_data)

    if not image_urls:

        raise RuntimeError(
            "No images found in this Instagram post."
        )

    print(
        f"[Post Parser] Found "
        f"{len(image_urls)} image(s)."
    )

    # --------------------------------------------------------
    # 5. Create output directory
    # --------------------------------------------------------

    post_dir = os.path.join(
        OUTPUT_ROOT,
        shortcode
    )

    os.makedirs(
        post_dir,
        exist_ok=True
    )

    # --------------------------------------------------------
    # 6. Download images
    # --------------------------------------------------------

    items = []

    for index, image_url in enumerate(
        image_urls,
        start=1
    ):

        filename = f"image_{index:02d}.jpg"

        image_path = os.path.join(
            post_dir,
            filename
        )

        print(
            f"[Post Parser] Downloading "
            f"{filename}..."
        )

        download_image(
            image_url,
            image_path
        )

        items.append(
            {
                "image_path": image_path,
                "text": caption
            }
        )

    # --------------------------------------------------------
    # 7. Standardized output
    # --------------------------------------------------------

    result = {
        "source": "instagram",
        "type": "post",
        "url": post_url,
        "shortcode": shortcode,
        "items": items
    }

    print(
        f"[Post Parser] Done. "
        f"{len(items)} item(s) generated."
    )

    return result