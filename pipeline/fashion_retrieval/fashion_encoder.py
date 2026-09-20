"""
fashion_encoder.py

Purpose
-------
Encode standardized garment descriptions into the
shared BGE-M3 semantic embedding space using the
Hugging Face online inference API.

No embedding model is loaded locally.

Input:
    Garment dictionaries containing:
        - text_description

Output:
    Same garment dictionaries with:
        - embedding
        - embedding_model

Only text_description is encoded.
All other fields are preserved as metadata.
"""

import os
import math

from dotenv import load_dotenv
from huggingface_hub import InferenceClient


# ============================================================
# Configuration
# ============================================================

load_dotenv()

HF_TOKEN = os.getenv(
    "HF_TOKEN"
)

if not HF_TOKEN:
    raise RuntimeError(
        "HF_TOKEN is not set in .env"
    )


MODEL_NAME = "BAAI/bge-m3"


client = InferenceClient(
    provider="hf-inference",
    api_key=HF_TOKEN,
)


# ============================================================
# Utility
# ============================================================

def normalize_vector(
    vector: list[float],
) -> list[float]:
    """
    L2-normalize an embedding vector.

    This keeps cosine similarity behavior consistent
    regardless of the inference backend.
    """

    norm = math.sqrt(
        sum(
            value * value
            for value in vector
        )
    )

    if norm == 0:
        raise ValueError(
            "Embedding vector has zero norm."
        )

    return [
        value / norm
        for value in vector
    ]


# ============================================================
# Encode one text
# ============================================================

def encode_text(
    text: str,
) -> list[float]:
    """
    Encode one garment description using
    online BGE-M3 inference.
    """

    if not isinstance(text, str):
        raise TypeError(
            "Text must be a string."
        )

    text = text.strip()

    if not text:
        raise ValueError(
            "Text cannot be empty."
        )

    embedding = client.feature_extraction(
        text,
        model=MODEL_NAME,
    )

    # Convert numpy / API result into Python list
    if hasattr(
        embedding,
        "tolist",
    ):
        embedding = embedding.tolist()

    # Some feature-extraction backends may return
    # [[...]] instead of [...]
    if (
        isinstance(embedding, list)
        and len(embedding) == 1
        and isinstance(
            embedding[0],
            list,
        )
    ):
        embedding = embedding[0]

    if not isinstance(
        embedding,
        list,
    ):
        raise ValueError(
            "Unexpected embedding response format."
        )

    # Ensure all values are Python floats
    embedding = [
        float(value)
        for value in embedding
    ]

    # Explicit normalization keeps our DB embeddings
    # consistent.
    embedding = normalize_vector(
        embedding
    )

    return embedding


# ============================================================
# Encode one garment
# ============================================================

def encode_item(
    item: dict,
) -> dict:
    """
    Encode one garment.

    Required:
        text_description

    Added:
        embedding
        embedding_model
    """

    if not isinstance(
        item,
        dict,
    ):
        raise TypeError(
            "Item must be a dictionary."
        )

    description = item.get(
        "text_description"
    )

    if not isinstance(
        description,
        str,
    ) or not description.strip():

        raise ValueError(
            "Item must contain a non-empty "
            "'text_description'."
        )

    return {
        **item,

        "embedding":
            encode_text(
                description
            ),

        "embedding_model":
            MODEL_NAME,
    }


# ============================================================
# Encode multiple garments
# ============================================================

def encode_items(
    items: list[dict],
) -> list[dict]:
    """
    Encode multiple garments.

    Each garment is sent to the online embedding API.

    This function preserves the same interface used
    by the rest of the fashion pipeline.
    """

    if not items:
        return []

    encoded_items = []

    for index, item in enumerate(
        items
    ):

        print(
            f"[Fashion Encoder] "
            f"Encoding item "
            f"{index + 1}/{len(items)}"
        )

        encoded_item = encode_item(
            item
        )

        encoded_items.append(
            encoded_item
        )

    return encoded_items