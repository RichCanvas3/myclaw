from __future__ import annotations

from collections.abc import Iterable

from .config import Settings


async def stream_assistant_reply(
    *,
    settings: Settings,
    prompt: str,
) -> Iterable[str]:
    """
    Yields text chunks.

    - If OPENAI_API_KEY is set, uses OpenAI chat completions streaming.
    - Otherwise, yields a deterministic local/dev reply.
    """
    if not settings.openai_api_key:
        # Minimal fallback for dev: deterministic + fast.
        yield "LLM not configured. Set OPENAI_API_KEY to enable real responses.\n\n"
        yield "You said:\n"
        yield prompt.strip()[:2000]
        return

    # Lazy import so dev can run without extra deps/config errors.
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(model=settings.openai_model, api_key=settings.openai_api_key, streaming=True)
    async for chunk in llm.astream(prompt):
        text = getattr(chunk, "content", None)
        if text:
            yield text
