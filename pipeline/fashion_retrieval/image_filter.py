"""
image_filter.py

Purpose
-------
Filter Instagram images before sending them to
fashion_analyzer.py.

Input:
    Output from post_parser.py or reel_parser.py

Output:
    Same structure as the parser output,
    but useless images are removed.

Post:
    - Remove blurry / unusable images
    - Remove text-only / advertisement images
    - Remove unrelated images
    - Remove images without useful top / pants information

Reel:
    - Same filtering rules as Post
    - Also remove near-duplicate frames using local dHash

This module does NOT:
    - generate fashion descriptions
    - generate tags
    - generate embeddings
    - calculate compatibility
"""

import os
import json
import base64
import mimetypes
import re

import numpy as np

from PIL import Image
from dotenv import load_dotenv
from anthropic import Anthropic


# ============================================================
# Configuration
# ============================================================

load_dotenv()

ANTHROPIC_API_KEY = os.getenv(
    "ANTHROPIC_API_KEY"
)

if not ANTHROPIC_API_KEY:
    raise RuntimeError(
        "ANTHROPIC_API_KEY is not set in .env"
    )


client = Anthropic(
    api_key=ANTHROPIC_API_KEY
)

MODEL = "claude-sonnet-4-6"


# ============================================================
# Image utilities
# ============================================================

def prepare_claude_image(
    image_path: str,
) -> tuple[str, str]:
    """
    Convert a local image into the Base64 format
    required by the Anthropic API.

    Returns:
        (
            media_type,
            base64_data
        )
    """

    if not os.path.exists(image_path):
        raise FileNotFoundError(
            f"Image not found: {image_path}"
        )

    mime_type, _ = mimetypes.guess_type(
        image_path
    )

    if mime_type is None:
        mime_type = "image/jpeg"

    # Claude supports common image MIME types.
    supported_types = {
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
    }

    if mime_type not in supported_types:
        raise ValueError(
            f"Unsupported image MIME type: "
            f"{mime_type}"
        )

    with open(image_path, "rb") as file:
        encoded = base64.b64encode(
            file.read()
        ).decode("utf-8")

    return mime_type, encoded


# ============================================================
# JSON parser
# ============================================================

def parse_json_response(
    text: str,
) -> dict:
    """
    Parse JSON returned by Claude.

    Also handles responses wrapped in:

        ```json
        {...}
        ```
    """

    if not text:
        raise ValueError(
            "Claude returned an empty response."
        )

    text = text.strip()

    text = re.sub(
        r"^```(?:json)?\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(
        r"\s*```$",
        "",
        text,
    )

    result = json.loads(text)

    if not isinstance(result, dict):
        raise ValueError(
            "Claude response must be a JSON object."
        )

    return result


# ============================================================
# Filtering prompt
# ============================================================

FILTER_PROMPT = """
You are filtering images for a fashion recommendation
system.

The next stage will analyze garments and learn the
user's fashion preferences.

The current system only cares about:

TOP:
- shirts
- T-shirts
- blouses
- sweaters
- hoodies
- sweatshirts
- tank tops
- crop tops
- similar upper-body garments

PANTS:
- trousers
- jeans
- cargo pants
- sweatpants
- shorts
- athletic shorts
- similar two-leg lower-body garments

For EACH image, decide whether it contains useful
fashion information.

KEEP an image if:

- at least one supported garment (top or pants)
  is clearly visible

AND

- its visual characteristics can be reasonably
  understood

Useful visual characteristics include:

- garment type
- color
- silhouette
- fit
- length
- texture
- pattern
- construction
- visible design details

REJECT an image if:

- it is heavily blurred
- it is a transition frame
- it is mostly text
- it is mainly a logo
- it is an advertisement or promotional graphic
  without useful visible clothing
- it is unrelated to fashion
- supported clothing is too small to understand
- supported clothing is heavily obstructed
- the crop makes the garment impossible to understand
- no supported top or pants is visible

IMPORTANT:

A garment does NOT need to be a complete outfit.

Examples:

- clear image of only a shirt -> KEEP
- clear image of only shorts -> KEEP
- clear upper-body crop showing a sweater -> KEEP
- shoe-only image -> REJECT
- handbag-only image -> REJECT
- text-only sale slide -> REJECT

Do not keep an image just because it belongs to a
fashion post.

The image itself must provide useful visual information
about a supported top or pants garment.

Do NOT generate fashion descriptions.
Do NOT generate tags.
Do NOT make recommendations.

Return ONLY valid JSON.

Required format:

{
    "images": [
        {
            "image_index": 0,
            "keep": true,
            "reason": "Clear top and pants are visible."
        },
        {
            "image_index": 1,
            "keep": false,
            "reason": "Text-only promotional slide."
        }
    ]
}

IMPORTANT:

Return exactly one result for every supplied image_index.
Do not omit an image_index.
"""


# ============================================================
# Generic image filtering
# ============================================================

def filter_items(
    items: list[dict],
) -> list[dict]:
    """
    Apply common fashion relevance filtering.

    Used by both Instagram Posts and Reels.

    All images in the input are sent to Claude in
    a single multimodal request.
    """

    if not items:
        return []

    print(
        f"\n[Image Filter] "
        f"Checking {len(items)} image(s)..."
    )

    # ========================================================
    # Build Claude multimodal content
    # ========================================================

    content = [
        {
            "type": "text",
            "text": FILTER_PROMPT,
        }
    ]

    for index, item in enumerate(items):

        image_path = item["image_path"]

        media_type, image_base64 = (
            prepare_claude_image(
                image_path
            )
        )

        # Tell Claude which index belongs
        # to the following image.
        content.append(
            {
                "type": "text",
                "text": (
                    f"The following image has "
                    f"image_index={index}."
                ),
            }
        )

        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": image_base64,
                },
            }
        )

    # ========================================================
    # Call Claude
    # ========================================================

    response = client.messages.create(
        model=MODEL,
        max_tokens=2048,
        messages=[
            {
                "role": "user",
                "content": content,
            }
        ],
    )

    # ========================================================
    # Extract response text
    # ========================================================

    response_text = ""

    for block in response.content:

        if block.type == "text":
            response_text += block.text

    response_text = response_text.strip()

    if not response_text:
        raise ValueError(
            f"Claude returned empty content. "
            f"Model: {MODEL}"
        )

    # ========================================================
    # Parse response
    # ========================================================

    try:

        result = parse_json_response(
            response_text
        )

    except Exception as error:

        print(
            "\n[Image Filter] "
            "Could not parse Claude response."
        )

        print(
            "\n[Image Filter] Raw response:"
        )

        print(
            repr(response_text)
        )

        raise RuntimeError(
            "Invalid JSON returned by "
            "image filter."
        ) from error

    # ========================================================
    # Validate result structure
    # ========================================================

    result_images = result.get(
        "images",
        []
    )

    if not isinstance(
        result_images,
        list,
    ):
        raise ValueError(
            "Claude response 'images' "
            "must be a list."
        )

    # ========================================================
    # Build index -> result mapping
    # ========================================================

    decisions = {}

    for result_item in result_images:

        if not isinstance(
            result_item,
            dict,
        ):
            continue

        index = result_item.get(
            "image_index"
        )

        if not isinstance(index, int):
            continue

        if not (
            0 <= index < len(items)
        ):
            continue

        # Avoid duplicate decisions
        if index in decisions:
            continue

        decisions[index] = result_item

    # ========================================================
    # Keep selected images
    # ========================================================

    filtered_items = []

    for index, item in enumerate(items):

        decision = decisions.get(
            index
        )

        # Claude should return one decision
        # for every image.
        if decision is None:

            print(
                f"[Image Filter] "
                f"image_{index}: "
                f"REJECT - No decision returned "
                f"by Claude."
            )

            continue

        keep = decision.get(
            "keep",
            False,
        )

        # Be strict about the value.
        keep = keep is True

        reason = decision.get(
            "reason",
            "",
        )

        if not isinstance(reason, str):
            reason = str(reason)

        status = (
            "KEEP"
            if keep
            else "REJECT"
        )

        print(
            f"[Image Filter] "
            f"image_{index}: "
            f"{status} - {reason}"
        )

        if keep:
            filtered_items.append(
                item
            )

    print(
        f"\n[Image Filter] "
        f"{len(items)} → "
        f"{len(filtered_items)} image(s)"
    )

    return filtered_items


# ============================================================
# Instagram Post
# ============================================================

def filter_post(
    parsed_post: dict,
) -> dict:
    """
    Filter Instagram Post / Carousel images.

    The parser output structure is preserved.
    Only the items list is changed.
    """

    items = parsed_post.get(
        "items",
        []
    )

    filtered_items = filter_items(
        items
    )

    output = dict(
        parsed_post
    )

    output["items"] = (
        filtered_items
    )

    return output


# ============================================================
# Reel dHash
# ============================================================

def compute_dhash(
    image_path: str,
    hash_size: int = 16,
) -> np.ndarray:
    """
    Compute difference hash (dHash).

    Used to detect near-identical consecutive
    Reel frames locally without an API call.
    """

    with Image.open(
        image_path
    ) as image:

        image = image.convert(
            "L"
        )

        image = image.resize(
            (
                hash_size + 1,
                hash_size,
            )
        )

        pixels = np.asarray(
            image,
            dtype=np.float32,
        )

    diff = (
        pixels[:, 1:]
        >
        pixels[:, :-1]
    )

    return diff.flatten()


def hash_distance(
    hash_a: np.ndarray,
    hash_b: np.ndarray,
) -> int:
    """
    Hamming distance between two dHashes.

    Smaller distance means the images are
    more visually similar.
    """

    return int(
        np.count_nonzero(
            hash_a != hash_b
        )
    )


# ============================================================
# Reel duplicate filtering
# ============================================================

def deduplicate_reel_frames(
    items: list[dict],
    threshold: int = 35,
) -> list[dict]:
    """
    Remove near-identical consecutive Reel frames.

    This stage is completely local.
    No Claude/API request is used.

    Frames are compared against the previously
    selected representative frame.

    threshold:
        smaller -> fewer frames considered duplicates
        larger  -> more aggressive duplicate removal
    """

    if not items:
        return []

    print(
        f"\n[Image Filter] "
        f"Deduplicating "
        f"{len(items)} Reel frames..."
    )

    selected_items = []

    previous_hash = None

    for index, item in enumerate(
        items
    ):

        image_path = (
            item["image_path"]
        )

        current_hash = compute_dhash(
            image_path
        )

        # ----------------------------------------------------
        # Always keep first useful frame
        # ----------------------------------------------------

        if previous_hash is None:

            selected_items.append(
                item
            )

            previous_hash = (
                current_hash
            )

            print(
                f"[Image Filter] "
                f"frame_{index}: "
                f"KEEP - first "
                f"representative frame"
            )

            continue

        # ----------------------------------------------------
        # Compare with previous selected frame
        # ----------------------------------------------------

        distance = hash_distance(
            previous_hash,
            current_hash,
        )

        if distance <= threshold:

            print(
                f"[Image Filter] "
                f"frame_{index}: "
                f"REJECT duplicate "
                f"(distance={distance})"
            )

            continue

        # ----------------------------------------------------
        # New visual
        # ----------------------------------------------------

        selected_items.append(
            item
        )

        previous_hash = (
            current_hash
        )

        print(
            f"[Image Filter] "
            f"frame_{index}: "
            f"KEEP new visual "
            f"(distance={distance})"
        )

    print(
        f"\n[Image Filter] "
        f"Reel dedup: "
        f"{len(items)} → "
        f"{len(selected_items)} frame(s)"
    )

    return selected_items


# ============================================================
# Instagram Reel
# ============================================================

def filter_reel(
    parsed_reel: dict,
) -> dict:
    """
    Filter Instagram Reel frames.

    Stage 1:
        Claude determines whether each frame contains
        useful top / pants information.

    Stage 2:
        Local dHash removes near-identical consecutive
        frames.

    The parser output structure is preserved.
    """

    items = parsed_reel.get(
        "items",
        []
    )

    # ========================================================
    # Stage 1: Semantic filtering with Claude
    # ========================================================

    useful_items = filter_items(
        items
    )

    # ========================================================
    # Stage 2: Local near-duplicate filtering
    # ========================================================

    selected_items = (
        deduplicate_reel_frames(
            useful_items,
            threshold=35,
        )
    )

    output = dict(
        parsed_reel
    )

    output["items"] = (
        selected_items
    )

    return output