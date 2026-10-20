"""Stable vision client shared by the image filter and fashion analyzer."""

from __future__ import annotations

import os
from typing import Any

import requests
from dotenv import load_dotenv

from .openrouter_client import chat_completion as openrouter_chat_completion


load_dotenv()

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEFAULT_OPENAI_VISION_MODEL = "gpt-5.4-mini"


def configured_provider() -> str:
    explicit = os.getenv("VISION_PROVIDER", "").strip().lower()
    if explicit:
        return explicit
    return "openai" if os.getenv("OPENAI_API_KEY") else "openrouter"


def configured_model() -> str:
    if configured_provider() == "openai":
        return (
            os.getenv("OPENAI_VISION_MODEL")
            or os.getenv("ADVICE_MODEL")
            or DEFAULT_OPENAI_VISION_MODEL
        )
    return (
        os.getenv("OPENROUTER_VISION_MODEL")
        or os.getenv("OPENROUTER_MODEL")
        or "openrouter/free"
    )


def image_content(mime_type: str, base64_data: str) -> dict[str, Any]:
    """Build the internal image block; converted per provider at request time."""
    return {
        "type": "image_url",
        "image_url": {
            "url": f"data:{mime_type};base64,{base64_data}",
        },
    }


def _openai_content(parts: Any) -> Any:
    if isinstance(parts, str):
        return [{"type": "input_text", "text": parts}]
    if not isinstance(parts, list):
        return parts

    converted: list[dict[str, Any]] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text":
            converted.append({"type": "input_text", "text": str(part.get("text") or "")})
        elif part.get("type") == "image_url":
            image = part.get("image_url") or {}
            converted.append(
                {
                    "type": "input_image",
                    "image_url": image.get("url"),
                    "detail": "high",
                }
            )
    return converted


def _openai_response_text(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    for item in payload.get("output") or []:
        if not isinstance(item, dict):
            continue
        for content in item.get("content") or []:
            if isinstance(content, dict) and content.get("type") == "output_text":
                parts.append(str(content.get("text") or ""))
    return "".join(parts).strip()


def _openai_completion(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int,
) -> tuple[str, str]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set for the vision pipeline")

    model = configured_model()
    response = requests.post(
        OPENAI_RESPONSES_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "input": [
                {
                    "role": message.get("role", "user"),
                    "content": _openai_content(message.get("content")),
                }
                for message in messages
            ],
            "max_output_tokens": max_tokens,
            "reasoning": {"effort": "none"},
            "text": {
                "format": {"type": "json_object"},
                "verbosity": "low",
            },
            "store": False,
        },
        timeout=float(os.getenv("OPENAI_VISION_TIMEOUT_SECONDS", "90")),
    )

    try:
        payload = response.json()
    except ValueError as error:
        raise RuntimeError(
            f"OpenAI vision returned non-JSON HTTP {response.status_code}: "
            f"{response.text[:300]}"
        ) from error

    if not response.ok or payload.get("error"):
        api_error = payload.get("error") or {}
        detail = api_error.get("message") if isinstance(api_error, dict) else str(api_error)
        raise RuntimeError(
            f"OpenAI vision HTTP {response.status_code}: {detail or response.text[:300]}"
        )

    content = _openai_response_text(payload)
    if not content:
        raise ValueError(f"OpenAI vision returned empty content. Model: {model}")

    return content, str(payload.get("model") or model)


def vision_completion(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 2048,
    temperature: float = 0,
) -> tuple[str, str]:
    """Use the configured vision provider; fallback must be explicitly enabled."""
    provider = configured_provider()
    if provider == "openai":
        try:
            return _openai_completion(messages, max_tokens=max_tokens)
        except Exception as error:
            fallback = os.getenv("VISION_FALLBACK_PROVIDER", "").strip().lower()
            if fallback != "openrouter" or not os.getenv("OPENROUTER_API_KEY"):
                raise
            print(f"[Vision] OpenAI failed ({error}); trying OpenRouter fallback.")

    return openrouter_chat_completion(
        messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
