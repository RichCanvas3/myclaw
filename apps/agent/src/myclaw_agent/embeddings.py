from __future__ import annotations

from .config import Settings

EMBEDDING_DIM = 1536


async def embed_text(settings: Settings, text: str) -> list[float]:
    if not settings.openai_api_key:
        return [0.0] * EMBEDDING_DIM

    from langchain_openai import OpenAIEmbeddings

    embedder = OpenAIEmbeddings(
        model="text-embedding-3-small",
        api_key=settings.openai_api_key,
    )
    vec = await embedder.aembed_query(text)
    # Defensive: normalize size.
    if len(vec) != EMBEDDING_DIM:
        if len(vec) > EMBEDDING_DIM:
            return vec[:EMBEDDING_DIM]
        return vec + [0.0] * (EMBEDDING_DIM - len(vec))
    return vec
