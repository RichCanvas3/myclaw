from __future__ import annotations

import os
from collections.abc import AsyncIterator

from langchain_core.messages import BaseMessage
from langgraph.types import StreamWriter

def openai_model() -> str:
    return os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")


def openai_api_key() -> str | None:
    return os.environ.get("OPENAI_API_KEY") or None


async def stream_chat_reply(
    *,
    messages: list[BaseMessage],
    writer: StreamWriter | None = None,
) -> AsyncIterator[str]:
    api_key = openai_api_key()
    if not api_key:
        yield "LLM not configured. Set OPENAI_API_KEY."
        return

    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(model=openai_model(), api_key=api_key, streaming=True)
    async for chunk in llm.astream(messages):
        text = getattr(chunk, "content", None)
        if not text:
            continue
        if writer:
            writer({"delta": text})
        yield text
