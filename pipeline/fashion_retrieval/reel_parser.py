"""
reel_parser.py

Purpose
-------
Convert an Instagram Reel URL into video frames + text.

Pipeline
--------
Instagram Reel URL
    ↓
apify_client.py
    ↓
Apify raw JSON
    ↓
Get videoUrl
    ↓
Download MP4
    ↓
Extract frames at fixed time intervals
    ↓
Return standardized frames + text structure

Input
-----
Instagram Reel URL (str)

Output
------
dict:
{
    "source": "instagram",
    "type": "reel",
    "url": "...",
    "shortcode": "...",
    "video_path": "...",
    "items": [
        {
            "image_path": "...",
            "timestamp": 0.0,
            "text": "..."
        }
    ]
}
"""

import os
import cv2
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

OUTPUT_ROOT = os.path.join(OUTPUT_BASE, "reels")

# 每隔幾秒取一張
FRAME_INTERVAL = 2


# ============================================================
# Download video
# ============================================================

def download_video(video_url: str, output_path: str) -> None:
    """
    Download Reel video from Instagram CDN.
    """

    response = requests.get(
        video_url,
        stream=True,
        timeout=60
    )

    response.raise_for_status()

    with open(output_path, "wb") as f:

        for chunk in response.iter_content(
            chunk_size=1024 * 1024
        ):
            if chunk:
                f.write(chunk)


# ============================================================
# Extract frames
# ============================================================

def extract_frames(
    video_path: str,
    output_dir: str,
    interval: float = FRAME_INTERVAL
) -> list[dict]:
    """
    Extract one frame every `interval` seconds.

    Returns
    -------
    list[dict]

    Example:
    [
        {
            "image_path": ".../frame_0000.jpg",
            "timestamp": 0.0
        },
        ...
    ]
    """

    os.makedirs(
        output_dir,
        exist_ok=True
    )

    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        raise RuntimeError(
            f"Cannot open video: {video_path}"
        )

    fps = cap.get(cv2.CAP_PROP_FPS)

    frame_count = cap.get(
        cv2.CAP_PROP_FRAME_COUNT
    )

    if fps <= 0:
        cap.release()

        raise RuntimeError(
            "Could not determine video FPS."
        )

    duration = frame_count / fps

    print(f"[Reel Parser] FPS: {fps:.2f}")
    print(
        f"[Reel Parser] Duration: "
        f"{duration:.2f} seconds"
    )

    frames = []

    timestamp = 0.0
    index = 0

    while timestamp < duration:

        # Jump to specified timestamp
        cap.set(
            cv2.CAP_PROP_POS_MSEC,
            timestamp * 1000
        )

        success, frame = cap.read()

        if not success:
            print(
                f"[Reel Parser] Could not read "
                f"frame at {timestamp:.1f}s"
            )

            timestamp += interval
            continue

        filename = (
            f"frame_{index:04d}_"
            f"{timestamp:06.1f}s.jpg"
        )

        image_path = os.path.join(
            output_dir,
            filename
        )

        cv2.imwrite(
            image_path,
            frame,
            [cv2.IMWRITE_JPEG_QUALITY, 95]
        )

        frames.append(
            {
                "image_path": image_path,
                "timestamp": round(timestamp, 3)
            }
        )

        index += 1
        timestamp += interval

    cap.release()

    return frames


# ============================================================
# Main parser
# ============================================================

def parse_reel(
    reel_url: str,
    raw_data: dict | None = None,
) -> dict:
    """
    Parse an Instagram Reel into local video frames.

    Parameters
    ----------
    reel_url : str
        Instagram Reel URL.

    raw_data : dict | None
        Apify 的原始 JSON。pipeline 已經抓過一次的話直接傳進來，
        可以省掉重複的 Apify run。

    Returns
    -------
    dict
        Reel information with extracted frames.
    """

    # --------------------------------------------------------
    # 1. Fetch Instagram data
    # --------------------------------------------------------

    if raw_data is None:

        print(
            "\n[Reel Parser] Fetching Instagram Reel..."
        )

        raw_data = fetch_instagram_post(
            reel_url
        )

    else:

        print(
            "\n[Reel Parser] Reusing Apify result."
        )

    # --------------------------------------------------------
    # 2. Metadata
    # --------------------------------------------------------

    post_type = raw_data.get("type")

    shortcode = raw_data.get(
        "shortCode",
        "unknown_reel"
    )

    caption = raw_data.get(
        "caption"
    ) or ""

    video_url = raw_data.get(
        "videoUrl"
    )

    print(
        f"[Reel Parser] Type: {post_type}"
    )

    print(
        f"[Reel Parser] ShortCode: {shortcode}"
    )

    # --------------------------------------------------------
    # 3. Validate video
    # --------------------------------------------------------

    if not video_url:

        raise RuntimeError(
            "No videoUrl found in Apify result."
        )

    # --------------------------------------------------------
    # 4. Create directories
    # --------------------------------------------------------

    reel_dir = os.path.join(
        OUTPUT_ROOT,
        shortcode
    )

    frames_dir = os.path.join(
        reel_dir,
        "frames"
    )

    os.makedirs(
        reel_dir,
        exist_ok=True
    )

    video_path = os.path.join(
        reel_dir,
        "reel.mp4"
    )

    # --------------------------------------------------------
    # 5. Download video
    # --------------------------------------------------------

    print(
        "[Reel Parser] Downloading video..."
    )

    download_video(
        video_url,
        video_path
    )

    print(
        f"[Reel Parser] Video saved: "
        f"{video_path}"
    )

    # --------------------------------------------------------
    # 6. Extract frames
    # --------------------------------------------------------

    print(
        f"[Reel Parser] Extracting frames "
        f"every {FRAME_INTERVAL}s..."
    )

    frames = extract_frames(
        video_path,
        frames_dir,
        FRAME_INTERVAL
    )

    # --------------------------------------------------------
    # 7. Standardize output
    # --------------------------------------------------------

    items = []

    for frame in frames:

        items.append(
            {
                "image_path":
                    frame["image_path"],

                "timestamp":
                    frame["timestamp"],

                "text":
                    caption
            }
        )

    result = {
        "source": "instagram",
        "type": "reel",
        "url": reel_url,
        "shortcode": shortcode,
        "video_path": video_path,
        "items": items
    }

    print(
        f"[Reel Parser] Done. "
        f"{len(items)} frames generated."
    )

    return result