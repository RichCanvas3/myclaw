from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Generator
from typing import Any


def a2a_base_url() -> str:
    return os.environ.get(
        "CHURCHCORE_A2A_BASE_URL",
        "https://a2a-gateway-worker.richardpedersen3.workers.dev/a2a/",
    ).rstrip("/") + "/"


def a2a_api_key() -> str | None:
    return os.environ.get("CHURCHCORE_A2A_API_KEY") or None


def _post_json(url: str, payload: dict[str, Any], *, api_key: str | None) -> Any:
    data = json.dumps(payload).encode("utf-8")
    headers = {"content-type": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"A2A HTTP {e.code}: {err}") from e


def chat(payload: dict[str, Any]) -> Any:
    return _post_json(a2a_base_url() + "chat", payload, api_key=a2a_api_key())


def chat_stream_sse_lines(payload: dict[str, Any]) -> Generator[str, None, None]:
    """
    Reads Churchcore A2A chat.stream as SSE and yields text deltas when detected.

    We intentionally parse loosely because the gateway may evolve.
    """
    url = a2a_base_url() + "chat.stream"
    data = json.dumps(payload).encode("utf-8")
    headers = {"content-type": "application/json"}
    key = a2a_api_key()
    if key:
        headers["x-api-key"] = key
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            for raw in resp:
                line = raw.decode("utf-8", errors="ignore").strip()
                if not line.startswith("data:"):
                    continue
                blob = line.removeprefix("data:").strip()
                if not blob:
                    continue
                try:
                    obj = json.loads(blob)
                except Exception:
                    continue

                # Common shapes:
                # - {"delta":"..."}
                # - {"text":"..."}
                # - {"message":"..."}
                if isinstance(obj, dict):
                    for k in ("delta", "text"):
                        v = obj.get(k)
                        if isinstance(v, str) and v:
                            yield v
                            break
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"A2A HTTP {e.code}: {err}") from e

