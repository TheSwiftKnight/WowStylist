"""Small OpenRouter client shared by the image filter and fashion analyzer."""

from __future__ import annotations

import os
from typing import Any

import requests
from dotenv import load_dotenv


load_dotenv()

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_OPENROUTER_MODEL = "qwen/qwen3.8-27b:free"
FREE_FALLBACK_MODEL = "openrouter/free"


def configured_model() -> str:
    return (
        os.getenv("OPENROUTER_VISION_MODEL")
        or os.getenv("OPENROUTER_MODEL")
        or DEFAULT_OPENROUTER_MODEL
    )


def image_content(mime_type: str, base64_data: str) -> dict[str, Any]:
    """Build an OpenAI-compatible data-URL image content block."""
    return {
        "type": "image_url",
        "image_url": {
            "url": f"data:{mime_type};base64,{base64_data}",
        },
    }


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict) and part.get("type") == "text":
            parts.append(str(part.get("text") or ""))
    return "".join(parts)


def chat_completion(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 2048,
    temperature: float = 0,
    model: str | None = None,
) -> tuple[str, str]:
    """
    Call OpenRouter and return ``(text, actual_model)``.

    Qwen3.8 27B's free multimodal endpoint is preferred. Because free endpoints can
    become rate-limited, ``openrouter/free`` is included as an automatic fallback.
    The free router also selects an image-capable model when ``messages`` contains
    image blocks.
    """
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set in .env")

    primary = model or configured_model()
    models = list(dict.fromkeys([primary, FREE_FALLBACK_MODEL]))
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "WowStylist",
    }
    if os.getenv("SITE_URL"):
        headers["HTTP-Referer"] = os.environ["SITE_URL"]

    timeout = float(os.getenv("OPENROUTER_TIMEOUT_SECONDS", "60"))
    response = requests.post(
        OPENROUTER_URL,
        headers=headers,
        json={
            "models": models,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            # Qwen3.8 enables reasoning by default. These calls only need short
            # structured/vision output, so reasoning would waste output tokens
            # and can leave no final answer before max_tokens is reached.
            "reasoning": {"effort": "none"},
        },
        timeout=timeout,
    )

    try:
        payload = response.json()
    except ValueError as error:
        raise RuntimeError(
            f"OpenRouter returned non-JSON HTTP {response.status_code}: "
            f"{response.text[:300]}"
        ) from error

    api_error = payload.get("error") if isinstance(payload, dict) else None
    if not response.ok or api_error:
        detail = api_error.get("message") if isinstance(api_error, dict) else str(api_error)
        raise RuntimeError(
            f"OpenRouter HTTP {response.status_code}: {detail or response.text[:300]}"
        )

    choices = payload.get("choices") or []
    content = _content_text(
        choices[0].get("message", {}).get("content") if choices else None
    ).strip()
    if not content:
        raise ValueError(
            f"OpenRouter returned empty content. Model: {payload.get('model') or primary}"
        )

    return content, str(payload.get("model") or primary)
