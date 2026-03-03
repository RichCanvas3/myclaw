from __future__ import annotations

import asyncio

from .config import get_settings
from .db import create_engine, create_sessionmaker, ensure_pgvector, session_scope
from .models import Base

settings = get_settings()

engine = create_engine(settings.database_url)
SessionLocal = create_sessionmaker(engine)

_init_lock = asyncio.Lock()
_initialized = False


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with session_scope(SessionLocal) as session:
        await ensure_pgvector(session)


async def init_db_once() -> None:
    global _initialized
    if _initialized:
        return
    async with _init_lock:
        if _initialized:
            return
        await init_db()
        _initialized = True
