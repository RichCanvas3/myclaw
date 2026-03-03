from __future__ import annotations

from collections.abc import Iterable

from .config import Settings


async def stream_assistant_reply(
    *,
    settings: Settings,
    prompt: str,
) -> Iterable[str]:
    if not settings.openai_api_key:
        yield "LLM not configured. Set OPENAI_API_KEY to enable real responses.\n\n"
        yield "You said:\n"
        yield prompt.strip()[:2000]
        return

    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(model=settings.openai_model, api_key=settings.openai_api_key, streaming=True)
    async for chunk in llm.astream(prompt):
        text = getattr(chunk, "content", None)
        if text:
            yield text
