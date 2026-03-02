from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langserve import add_routes
from pydantic import BaseModel, Field
from sqlalchemy import select

from .config import get_settings
from .db import create_engine, create_sessionmaker, ensure_pgvector, session_scope
from .embeddings import embed_text
from .llm import stream_assistant_reply
from .models import Base, KbChunk, MemoryItem, Message, Thread
from .retrieval import retrieve_kb
from .runnables import act_runnable

load_dotenv()
settings = get_settings()

engine = create_engine(settings.database_url)
SessionLocal = create_sessionmaker(engine)


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with session_scope(SessionLocal) as session:
        await ensure_pgvector(session)


app = FastAPI(title="myclaw-agent", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

add_routes(app, act_runnable, path="/langserve/act")


@app.on_event("startup")
async def startup() -> None:
    await _init_db()


class CreateThreadResponse(BaseModel):
    thread_id: str


@app.post("/threads", response_model=CreateThreadResponse)
async def create_thread(title: str | None = Body(default=None)) -> CreateThreadResponse:
    async with session_scope(SessionLocal) as session:
        t = Thread(title=title)
        session.add(t)
        await session.flush()
        return CreateThreadResponse(thread_id=str(t.id))


class ThreadMessage(BaseModel):
    id: str
    role: Literal["user", "assistant", "system"]
    content: str
    created_at: str


class GetThreadResponse(BaseModel):
    thread_id: str
    title: str | None
    messages: list[ThreadMessage]


@app.get("/threads/{thread_id}", response_model=GetThreadResponse)
async def get_thread(thread_id: str) -> GetThreadResponse:
    try:
        tid = uuid.UUID(thread_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail="invalid thread_id") from e

    async with session_scope(SessionLocal) as session:
        thread = await session.get(Thread, tid)
        if not thread:
            raise HTTPException(status_code=404, detail="thread not found")

        msgs = (
            (
                await session.execute(
                    select(Message)
                    .where(Message.thread_id == tid)
                    .order_by(Message.created_at.asc())
                )
            )
            .scalars()
            .all()
        )

        return GetThreadResponse(
            thread_id=str(thread.id),
            title=thread.title,
            messages=[
                ThreadMessage(
                    id=str(m.id),
                    role=m.role,
                    content=m.content,
                    created_at=m.created_at.isoformat(),
                )
                for m in msgs
            ],
        )


class KbIngestRequest(BaseModel):
    source: str
    content: str


class KbIngestResponse(BaseModel):
    chunk_id: str


@app.post("/kb/ingest", response_model=KbIngestResponse)
async def kb_ingest(payload: KbIngestRequest) -> KbIngestResponse:
    async with session_scope(SessionLocal) as session:
        vec = await embed_text(settings, payload.content)
        chunk = KbChunk(source=payload.source, content=payload.content, embedding=vec)
        session.add(chunk)
        await session.flush()
        return KbIngestResponse(chunk_id=str(chunk.id))


MemoryScope = Literal["org", "user", "thread"]


class MemoryUpsertRequest(BaseModel):
    value: dict[str, Any]


class MemoryItemResponse(BaseModel):
    scope: MemoryScope
    scope_id: str
    key: str
    value: dict[str, Any]


@app.get("/memory/{scope}/{scope_id}/{key}", response_model=MemoryItemResponse)
async def get_memory_item(scope: MemoryScope, scope_id: str, key: str) -> MemoryItemResponse:
    async with session_scope(SessionLocal) as session:
        row = (
            (
                await session.execute(
                    select(MemoryItem).where(
                        MemoryItem.scope == scope,
                        MemoryItem.scope_id == scope_id,
                        MemoryItem.key == key,
                    )
                )
            )
            .scalars()
            .first()
        )
        if not row:
            raise HTTPException(status_code=404, detail="memory item not found")
        return MemoryItemResponse(
            scope=row.scope, scope_id=row.scope_id, key=row.key, value=row.value
        )


@app.put("/memory/{scope}/{scope_id}/{key}", response_model=MemoryItemResponse)
async def put_memory_item(
    scope: MemoryScope, scope_id: str, key: str, payload: MemoryUpsertRequest
) -> MemoryItemResponse:
    async with session_scope(SessionLocal) as session:
        row = (
            (
                await session.execute(
                    select(MemoryItem).where(
                        MemoryItem.scope == scope,
                        MemoryItem.scope_id == scope_id,
                        MemoryItem.key == key,
                    )
                )
            )
            .scalars()
            .first()
        )
        if row:
            row.value = payload.value
        else:
            row = MemoryItem(scope=scope, scope_id=scope_id, key=key, value=payload.value)
            session.add(row)
        await session.flush()
        return MemoryItemResponse(
            scope=row.scope, scope_id=row.scope_id, key=row.key, value=row.value
        )


@app.get("/memory/{scope}/{scope_id}", response_model=list[MemoryItemResponse])
async def list_memory(scope: MemoryScope, scope_id: str) -> list[MemoryItemResponse]:
    async with session_scope(SessionLocal) as session:
        rows = (
            (
                await session.execute(
                    select(MemoryItem)
                    .where(MemoryItem.scope == scope, MemoryItem.scope_id == scope_id)
                    .order_by(MemoryItem.key.asc())
                )
            )
            .scalars()
            .all()
        )
        return [
            MemoryItemResponse(scope=r.scope, scope_id=r.scope_id, key=r.key, value=r.value)
            for r in rows
        ]


class ActRequest(BaseModel):
    thread_id: str | None = None
    user_id: str = "default"
    org_id: str = "default"
    message: str = Field(min_length=1)


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/agent/act")
async def agent_act(payload: ActRequest) -> StreamingResponse:
    # Validate + create/update thread before streaming starts (so errors return normally).
    if payload.thread_id:
        try:
            tid = uuid.UUID(payload.thread_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail="invalid thread_id") from e
        async with session_scope(SessionLocal) as session:
            thread = await session.get(Thread, tid)
            if not thread:
                raise HTTPException(status_code=404, detail="thread not found")
            session.add(Message(thread_id=tid, role="user", content=payload.message))
    else:
        async with session_scope(SessionLocal) as session:
            thread = Thread(title=None)
            session.add(thread)
            await session.flush()
            tid = thread.id
            session.add(Message(thread_id=tid, role="user", content=payload.message))

    async def gen() -> AsyncIterator[str]:
        yield _sse("thread", {"thread_id": str(tid)})

        # Load thread history + memory + KB context.
        async with session_scope(SessionLocal) as session:
            history = (
                (
                    await session.execute(
                        select(Message)
                        .where(Message.thread_id == tid)
                        .order_by(Message.created_at.desc())
                        .limit(20)
                    )
                )
                .scalars()
                .all()
            )
            history_text = "\n".join(
                f"{m.role}: {m.content}"
                for m in reversed(history)
                if m.role in {"user", "assistant"}
            )

            org_mem = (
                (
                    await session.execute(
                        select(MemoryItem).where(
                            MemoryItem.scope == "org",
                            MemoryItem.scope_id == payload.org_id,
                        )
                    )
                )
                .scalars()
                .all()
            )
            user_mem = (
                (
                    await session.execute(
                        select(MemoryItem).where(
                            MemoryItem.scope == "user",
                            MemoryItem.scope_id == payload.user_id,
                        )
                    )
                )
                .scalars()
                .all()
            )
            thread_mem = (
                (
                    await session.execute(
                        select(MemoryItem).where(
                            MemoryItem.scope == "thread",
                            MemoryItem.scope_id == str(tid),
                        )
                    )
                )
                .scalars()
                .all()
            )

            chunks = await retrieve_kb(settings=settings, session=session, query=payload.message)

        context = ""
        if chunks:
            context = "\n\n".join(
                f"[{c['source']}] {c['content']}" for c in chunks[: settings.kb_top_k]
            )

        prompt = payload.message
        mem_blob = {
            "org": {m.key: m.value for m in org_mem},
            "user": {m.key: m.value for m in user_mem},
            "thread": {m.key: m.value for m in thread_mem},
        }
        prompt = "\n\n".join(
            p
            for p in [
                "You are myclaw-agent. Be concise and action-oriented.",
                f"Memory (JSON):\n{json.dumps(mem_blob, ensure_ascii=False)}",
                f"Thread so far:\n{history_text}" if history_text else "",
                f"Knowledge base context:\n{context}" if context else "",
                f"User message:\n{payload.message}",
            ]
            if p
        )

        # Stream LLM reply.
        acc = []
        async for text in stream_assistant_reply(settings=settings, prompt=prompt):
            acc.append(text)
            yield _sse("delta", {"text": text})

        final_text = "".join(acc).strip()

        # Persist assistant message.
        async with session_scope(SessionLocal) as session:
            session.add(Message(thread_id=tid, role="assistant", content=final_text or ""))

        yield _sse(
            "final",
            {
                "thread_id": str(tid),
                "message": final_text,
                "entities": [],
                "suggestedActions": [],
            },
        )

    return StreamingResponse(gen(), media_type="text/event-stream")
