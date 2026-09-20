"""
fashion_formatter.py

Convert Product DB / Instagram analysis results into
the unified fashion item format expected by DB_write.
"""

import mimetypes

from fashion_retrieval.fashion_encoder import encode_item


# ============================================================
# Image helpers
# ============================================================

def load_image_binary(image_path: str) -> tuple[bytes, str]:
    """
    Load local image file as binary.
    Used for Instagram images / Reel frames.
    """

    with open(image_path, "rb") as f:
        image_data = f.read()

    image_mime, _ = mimetypes.guess_type(image_path)

    if image_mime is None:
        image_mime = "image/jpeg"

    return image_data, image_mime


def ensure_bytes(image_data) -> bytes:
    """
    Convert DB BYTEA result into Python bytes.
    """

    if isinstance(image_data, bytes):
        return image_data

    if isinstance(image_data, memoryview):
        return image_data.tobytes()

    if isinstance(image_data, bytearray):
        return bytes(image_data)

    raise TypeError(
        f"Unsupported image_data type: {type(image_data)}"
    )


# ============================================================
# Product
# ============================================================

def build_product_item(
    product: dict,
    analysis: dict,
) -> dict:
    """
    Build final fashion item from Product DB data
    and Claude analysis result.
    """

    category = analysis.get("category")

    # Safety mapping
    if category == "bottom":
        category = "pants"

    if category not in ("top", "pants"):
        raise ValueError(
            f"Invalid product category: {category}"
        )

    if not analysis.get("text_description"):
        raise ValueError(
            "Product analysis has no text_description."
        )

    item = {
        # ----------------------------------------------------
        # Source
        # ----------------------------------------------------
        "source": "product",

        "source_item_id": str(
            product["product_id"]
        ),

        # ----------------------------------------------------
        # Garment
        # ----------------------------------------------------
        "category": category,

        "text_description":
            analysis["text_description"],

        # ----------------------------------------------------
        # Image
        # ----------------------------------------------------
        "image_data": ensure_bytes(
            product["image_data"]
        ),

        "image_mime":
            product.get("image_mime")
            or "image/jpeg",

        # ----------------------------------------------------
        # UI
        # ----------------------------------------------------
        "display_tags": None,
        "outfit_tags": None,

        # ----------------------------------------------------
        # Product metadata
        # ----------------------------------------------------
        "title":
            product.get("title"),

        "price_twd":
            product.get("price_twd"),

        "product_url":
            product.get("product_url"),

        # ----------------------------------------------------
        # Instagram metadata
        # ----------------------------------------------------
        "instagram_url": None,
        "instagram_type": None,
        "shortcode": None,
        "timestamp": None,
    }

    # Add:
    # embedding
    # embedding_model
    item = encode_item(item)

    return item


# ============================================================
# Instagram
# ============================================================

def build_instagram_item(
    garment: dict,
    *,
    instagram_url: str,
    instagram_type: str,
    shortcode: str,
    source_item_id: str,
) -> dict:
    """
    Build final fashion item from analyzed
    Instagram Post / Reel garment.
    """

    if instagram_type not in (
        "post",
        "reel",
    ):
        raise ValueError(
            "instagram_type must be 'post' or 'reel'."
        )

    category = garment.get("category")

    if category == "bottom":
        category = "pants"

    if category not in (
        "top",
        "pants",
    ):
        raise ValueError(
            f"Invalid Instagram category: {category}"
        )

    if not garment.get(
        "text_description"
    ):
        raise ValueError(
            "Instagram garment has no text_description."
        )

    image_path = garment.get(
        "image_path"
    )

    if not image_path:
        raise ValueError(
            "Instagram garment has no image_path."
        )

    image_data, image_mime = (
        load_image_binary(
            image_path
        )
    )

    item = {
        # ----------------------------------------------------
        # Source
        # ----------------------------------------------------
        "source": "instagram",

        "source_item_id":
            str(source_item_id),

        # ----------------------------------------------------
        # Garment
        # ----------------------------------------------------
        "category":
            category,

        "text_description":
            garment[
                "text_description"
            ],

        # ----------------------------------------------------
        # Image
        # ----------------------------------------------------
        "image_data":
            image_data,

        "image_mime":
            image_mime,

        # ----------------------------------------------------
        # UI
        # ----------------------------------------------------
        "display_tags":
            garment.get(
                "display_tags"
            ),

        "outfit_tags":
            garment.get(
                "outfit_tags"
            ),

        # ----------------------------------------------------
        # Product metadata
        # ----------------------------------------------------
        "title": None,
        "price_twd": None,
        "product_url": None,

        # ----------------------------------------------------
        # Instagram metadata
        # ----------------------------------------------------
        "instagram_url":
            instagram_url,

        "instagram_type":
            instagram_type,

        "shortcode":
            shortcode,

        "timestamp":
            garment.get(
                "timestamp"
            ),
    }

    # Add:
    # embedding
    # embedding_model
    item = encode_item(item)

    return item