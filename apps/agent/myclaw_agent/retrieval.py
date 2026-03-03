from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings
from .embeddings import embed_text
from .models import KbChunk


async def retrieve_kb(
    *,
    settings: Settings,
    session: AsyncSession,
    query: str,
) -> list[dict]:
    qvec = await embed_text(settings, query)
    k = settings.kb_top_k

    chunks = (
        (
            await session.execute(
                select(KbChunk)
                .order_by(KbChunk.embedding.l2_distance(qvec))  # type: ignore[attr-defined]
                .limit(k)
            )
        )
        .scalars()
        .all()
    )

    return [{"id": str(c.id), "source": c.source, "content": c.content} for c in chunks]
