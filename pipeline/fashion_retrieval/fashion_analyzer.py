"""
fashion_analyzer.py

Purpose
-------
Convert fashion images into standardized garment descriptions
for downstream BGE-M3 encoding.

Current MVP supports ONLY:
    - top
    - pants

Input sources can include:
    1. Instagram images from post_parser / reel_parser
    2. Product images from an e-commerce database

The analyzer itself does NOT:
    - access the database
    - generate embeddings
    - calculate compatibility scores
    - store data

Core pipeline
-------------
Image
    ↓
Vision LLM
    ↓
Detect top / pants
    ↓
Generate one detailed semantic description per garment
    ↓
fashion_encoder.py


Core output
-----------
{
    "garments": [
        {
            "category": "top",
            "text_description": "..."
        },
        {
            "category": "pants",
            "text_description": "..."
        }
    ]
}
"""

import os
import json
import base64
import mimetypes
import re
from typing import Optional

import mimetypes

from dotenv import load_dotenv
load_dotenv()

from anthropic import Anthropic

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

if not ANTHROPIC_API_KEY:
    raise RuntimeError(
        "ANTHROPIC_API_KEY is not set."
    )

client = Anthropic(
    api_key=ANTHROPIC_API_KEY
)

MODEL = "claude-sonnet-4-6"



SUPPORTED_CATEGORIES = {
    "top",
    "pants",
}


# ============================================================
# Image utilities
# ============================================================


def prepare_claude_image(
    image,
    mime_type: str = "image/jpeg",
) -> tuple[str, str]:

    # PostgreSQL bytea
    if isinstance(image, memoryview):
        image = image.tobytes()

    # Raw bytes
    if isinstance(image, bytes):
        encoded = base64.b64encode(
            image
        ).decode("utf-8")

        return mime_type, encoded

    # Local file
    if isinstance(image, str):

        detected_mime, _ = mimetypes.guess_type(
            image
        )

        detected_mime = (
            detected_mime
            or mime_type
        )

        with open(image, "rb") as f:
            encoded = base64.b64encode(
                f.read()
            ).decode("utf-8")

        return detected_mime, encoded

    raise TypeError(
        f"Unsupported image type: {type(image)}"
    )

# ============================================================
# JSON parser
# ============================================================

def parse_json_response(text: str) -> dict:
    """
    Parse JSON returned by the model.

    Handles:
        ```json
        {...}
        ```
    """

    if not text:
        raise ValueError(
            "Vision model returned an empty response."
        )

    text = text.strip()

    text = re.sub(
        r"^```(?:json)?\s*",
        "",
        text,
        flags=re.IGNORECASE
    )

    text = re.sub(
        r"\s*```$",
        "",
        text
    )

    return json.loads(text)


# ============================================================
# Vision prompt
# ============================================================

def build_analysis_prompt(
    known_category: Optional[str] = None,
    context: Optional[str] = None,
    generate_tags: bool = False,
) -> str:
    """
    Build prompt for garment-level fashion analysis.

    known_category:
        Optional authoritative category supplied by
        the product database.

    context:
        Optional caption, product title, etc.

    generate_tags:
        If True, generate display tags for garments
        and outfit-level style tags.
        Used for Instagram images.
    """

    # ========================================================
    # Category instruction
    # ========================================================

    category_instruction = ""

    if known_category:

        if known_category not in SUPPORTED_CATEGORIES:
            raise ValueError(
                f"Unsupported category: {known_category}. "
                f"Supported categories: "
                f"{sorted(SUPPORTED_CATEGORIES)}"
            )

        category_instruction = f"""
The source database identifies the product category as
"{known_category}".

Treat this category as authoritative.
Do NOT change or re-classify it.

Analyze the visible garment belonging to this category.
"""

    # ========================================================
    # Context instruction
    # ========================================================

    context_instruction = ""

    if context:
        context_instruction = f"""
Additional source context:

{context}

Use the image as the PRIMARY source of garment information.

Use the context only when it provides relevant fashion
information such as garment type, material, collection,
style, or product details.

Ignore unrelated text, promotional language, emojis,
hashtags, engagement bait, and personal comments.

Do not claim that a contextual detail belongs to a
garment unless the connection is reasonably clear.
"""

    # ========================================================
    # Tag instruction
    # ========================================================

    if generate_tags:

        tag_instruction = """
TAG GENERATION:

For each garment, also generate 2-5 concise
human-readable "display_tags".

These tags are intended for website UI display and
should summarize the most distinctive visible
characteristics of the garment.

Useful garment tags may describe:

- color
- garment type
- fit
- silhouette
- length
- texture
- pattern
- distinctive design details

Examples:

"White"
"Oversized"
"Wide-leg"
"Ribbed"
"Long-sleeve"
"Cargo"

Also generate 2-5 "outfit_tags" describing the overall
fashion aesthetic of the visible outfit when it can be
reasonably inferred.

Examples:

"Minimal"
"Casual"
"Streetwear"
"Sporty"
"Monochrome"
"Relaxed"

Do not force a tag when the corresponding attribute
cannot be reasonably determined from the image or
supporting context.

The tags are for UI display only.
They are NOT part of the semantic embedding text.
"""

        output_format = """
Required JSON format:

{
    "outfit_tags": [
        "Minimal",
        "Casual"
    ],
    "garments": [
        {
            "category": "top",
            "text_description":
                "A cream long-sleeve top with ...",
            "display_tags": [
                "Cream",
                "Long-sleeve",
                "Relaxed-fit"
            ]
        },
        {
            "category": "pants",
            "text_description":
                "Black wide-leg trousers with ...",
            "display_tags": [
                "Black",
                "Wide-leg",
                "Full-length"
            ]
        }
    ]
}

If only one supported garment is visible, return only
that garment.

If no supported garment is clearly visible:

{
    "outfit_tags": [],
    "garments": []
}
"""

    else:

        tag_instruction = """
Do NOT generate display_tags or outfit_tags.
"""

        output_format = """
Required JSON format:

{
    "garments": [
        {
            "category": "top",
            "text_description":
                "A cream long-sleeve top with ..."
        },
        {
            "category": "pants",
            "text_description":
                "Black wide-leg trousers with ..."
        }
    ]
}

If only one supported garment is visible, return only
that garment.

If no supported garment is clearly visible:

{
    "garments": []
}
"""

    # ========================================================
    # Main prompt
    # ========================================================

    return f"""
You are the visual analysis component of a fashion
recommendation and retrieval system.

Your task is to analyze clothing visible in the image
and produce detailed semantic descriptions that will
later be encoded by a text embedding model.

CURRENT MVP SCOPE:

Only analyze these garment categories:

- top
- pants

Ignore all other categories, including:

- shoes
- bags
- accessories
- skirts
- dresses
- outerwear
- hats
- jewelry

{category_instruction}

{context_instruction}

IMPORTANT:

Each garment must be represented independently.

If both a top and pants are visible, return TWO
garment objects.

Do NOT describe the entire outfit as one garment.

For each supported garment, describe as much visually
supported fashion information as possible.

Useful information includes:

- garment type
- main color
- secondary colors
- silhouette
- fit
- length
- sleeve length
- waist / rise when visible
- leg shape for pants
- fabric or material appearance
- texture
- pattern
- construction
- collar / neckline
- visible details
- layering characteristics
- overall aesthetic or style

The description should be useful for semantic fashion
retrieval and outfit compatibility matching.

DESCRIPTION RULES:

1. Write a natural, information-dense English paragraph.

2. Describe ONLY the individual garment.

3. Do not describe the person's face, body, pose,
   background, location, or photography style.

4. Do not guess brands.

5. Do not claim an exact material unless it is visually
   obvious or provided by the source context.

   Prefer phrases such as:
   "denim-like fabric",
   "lightweight cotton-like texture",
   "smooth structured fabric",
   "soft knit appearance".

6. Do not invent hidden garment details.

7. Do not explain why the garment matches another
   garment.

8. Do not write recommendations.

9. Do not include price.

10. If no supported garment can be identified clearly,
    return an empty garments list.

CATEGORY DEFINITIONS:

"top":
Shirts, T-shirts, blouses, sweaters, hoodies,
sweatshirts, tank tops, crop tops and similar
upper-body garments.

"pants":
All lower-body two-leg garments, including trousers,
jeans, cargo pants, sweatpants, shorts, athletic shorts,
and similar garments.

{tag_instruction}

Return ONLY valid JSON.

Do not include Markdown code fences.
Do not include explanations before or after the JSON.

{output_format}
"""

# ============================================================
# Core image analyzer
# ============================================================

def analyze_image(
    image,
    known_category: Optional[str] = None,
    context: Optional[str] = None,
    mime_type: str = "image/jpeg",
    generate_tags: bool = False,
) -> dict:
    """
    Analyze one fashion image with the Vision model.

    The function:
    1. Builds the fashion-analysis prompt.
    2. Converts the image into a format accepted by the Vision model.
    3. Calls the Vision model once.
    4. Parses and validates the JSON response.
    5. Returns only supported garments: top and pants.

    If the Vision request or JSON parsing fails, an exception is raised.
    The caller (e.g. analyze_reel / analyze_post) can decide whether
    to skip the image.
    """

    # ========================================================
    # Build prompt
    # ========================================================

    prompt = build_analysis_prompt(
        known_category=known_category,
        context=context,
        generate_tags=generate_tags,
    )

    # ========================================================
    # Prepare image
    # ========================================================

    image_media_type, image_base64 = prepare_claude_image(
        image,
        mime_type=mime_type,
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
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image_media_type,
                            "data": image_base64,
                        },
                    },
                    {
                        "type": "text",
                        "text": prompt,
                    },
                ],
            }
        ],
    )

    # ========================================================
    # Get response text
    # ========================================================

    raw_response = ""

    for block in response.content:
        if block.type == "text":
            raw_response += block.text

    raw_response = raw_response.strip()

    if not raw_response:
        raise ValueError(
            f"Claude returned empty content. "
            f"Model: {MODEL}"
        )

    # ========================================================
    # Parse JSON
    # ========================================================

    try:
        result = parse_json_response(
            raw_response
        )

    except Exception:
        print(
            f"[Fashion Analyzer] Invalid response "
            f"from Claude: {MODEL}"
        )

        print(
            f"[Fashion Analyzer] Raw response: "
            f"{repr(raw_response)}"
        )

        raise

    if not isinstance(result, dict):
        raise ValueError(
            "Claude response must be a JSON object."
        )
    




    # ========================================================
    # Validate garments
    # ========================================================

    garments = result.get(
        "garments",
        []
    )

    if not isinstance(garments, list):
        raise ValueError(
            "Vision response 'garments' must be a list."
        )

    valid_garments = []

    for garment in garments:

        if not isinstance(garment, dict):
            continue

        category = garment.get(
            "category"
        )

        description = garment.get(
            "text_description",
            ""
        )

        # ----------------------------------------------------
        # Only support top / pants
        # ----------------------------------------------------

        if category not in SUPPORTED_CATEGORIES:
            continue

        # ----------------------------------------------------
        # DB category is authoritative
        # ----------------------------------------------------

        if (
            known_category is not None
            and category != known_category
        ):
            continue

        # ----------------------------------------------------
        # Validate description
        # ----------------------------------------------------

        if not isinstance(description, str):
            continue

        description = description.strip()

        if not description:
            continue

        clean_garment = {
            "category": category,
            "text_description": description,
        }

        # ----------------------------------------------------
        # Display tags
        # Instagram only
        # ----------------------------------------------------

        if generate_tags:

            tags = garment.get(
                "display_tags",
                []
            )

            if not isinstance(tags, list):
                tags = []

            clean_garment["display_tags"] = [
                str(tag).strip()
                for tag in tags
                if str(tag).strip()
            ][:5]

        valid_garments.append(
            clean_garment
        )

    # ========================================================
    # Build output
    # ========================================================

    output = {
        "garments": valid_garments
    }

    # ========================================================
    # Outfit tags
    # Instagram only
    # ========================================================

    if generate_tags:

        outfit_tags = result.get(
            "outfit_tags",
            []
        )

        if not isinstance(outfit_tags, list):
            outfit_tags = []

        output["outfit_tags"] = [
            str(tag).strip()
            for tag in outfit_tags
            if str(tag).strip()
        ][:5]

    return output

# ============================================================
# Instagram Post
# ============================================================

def analyze_post(
    filtered_post: dict
) -> dict:

    samples = []

    outfit_tags = []

    for image_index, item in enumerate(
        filtered_post.get("items", [])
    ):

        try:
            analysis = analyze_image(
                item["image_path"],
                context=item.get("text"),
                generate_tags=True,
            )

        except Exception as e:
            print(
                f"[Fashion Analyzer] WARNING: "
                f"Skipping Post image "
                f"{image_index + 1}: {e}"
            )

            continue

        outfit_tags.extend(
            analysis.get(
                "outfit_tags",
                []
            )
        )

        for garment_index, garment in enumerate(
            analysis.get("garments", [])
        ):

            samples.append(
                {
                    "image_index":
                        image_index,

                    "garment_index":
                        garment_index,

                    "image_path":
                        item["image_path"],

                    "category":
                        garment["category"],

                    "text_description":
                        garment[
                            "text_description"
                        ],

                    "display_tags":
                        garment.get(
                            "display_tags",
                            []
                        ),
                }
            )

    return {
        "source": "instagram",
        "type": "post",
        "url": filtered_post.get("url"),
        "shortcode":
            filtered_post.get("shortcode"),

        "outfit_tags":
            list(dict.fromkeys(outfit_tags)),

        "samples": samples,
    }

# ============================================================
# Instagram Reel
# ============================================================

def analyze_reel(
    filtered_reel: dict
) -> dict:

    samples = []
    outfit_tags = []

    items = filtered_reel.get(
        "items",
        []
    )

    for frame_index, item in enumerate(items):

        print(
            f"[Fashion Analyzer] Analyzing Reel frame "
            f"{frame_index + 1}/{len(items)}: {item['image_path']}"
        )

        try:
            analysis = analyze_image(
                item["image_path"],
                context=item.get("text"),
                generate_tags=True,
            )

        except Exception as e:

            print(
                f"[Fashion Analyzer] WARNING: "
                f"Skipping Reel frame "
                f"{frame_index + 1}: {e}"
            )

            continue

        outfit_tags.extend(
            analysis.get(
                "outfit_tags",
                []
            )
        )

        for garment_index, garment in enumerate(
            analysis.get("garments", [])
        ):

            samples.append(
                {
                    "frame_index":
                        frame_index,

                    "garment_index":
                        garment_index,

                    "image_path":
                        item["image_path"],

                    "timestamp":
                        item.get("timestamp"),

                    "category":
                        garment["category"],

                    "text_description":
                        garment[
                            "text_description"
                        ],

                    "display_tags":
                        garment.get(
                            "display_tags",
                            []
                        ),
                }
            )

    return {
        "source": "instagram",
        "type": "reel",
        "url": filtered_reel.get("url"),
        "shortcode":
            filtered_reel.get("shortcode"),

        "outfit_tags":
            list(dict.fromkeys(outfit_tags)),

        "samples": samples,
    }

# ============================================================
# Product image
# ============================================================
def analyze_product(
    product: dict
) -> dict:

    category = product["category"]

    if category not in SUPPORTED_CATEGORIES:
        raise ValueError(
            f"Unsupported category: {category}"
        )

    analysis = analyze_image(
        image=product["image_data"],
        known_category=category,
        context=(
            f"Product title: "
            f"{product['title']}"
        ),
        mime_type=(
            product.get("image_mime")
            or "image/jpeg"
        ),
        generate_tags=False,
    )

    garments = analysis.get(
        "garments",
        []
    )

    if not garments:
        return {
            "item_id":
                str(product["product_id"]),
            "category":
                category,
            "text_description":
                None,
            "price":
                float(product["price_twd"])
                if product["price_twd"] is not None
                else None,
            "product_url":
                product["product_url"],
        }

    garment = garments[0]

    return {
        "item_id":
            str(product["product_id"]),

        "category":
            category,

        "text_description":
            garment["text_description"],

        "price":
            float(product["price_twd"])
            if product["price_twd"] is not None
            else None,

        "product_url":
            product["product_url"],
    }