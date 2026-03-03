from __future__ import annotations

import json
import uuid

from langgraph.types import StreamWriter
from sqlalchemy import select

from apps.agent.models import Input, OutputEnvelope
from apps.agent.myclaw_agent.db import session_scope
from apps.agent.myclaw_agent.llm import stream_assistant_reply
from apps.agent.myclaw_agent.models import MemoryItem, Message, Thread
from apps.agent.myclaw_agent.retrieval import retrieve_kb
from apps.agent.myclaw_agent.runtime import SessionLocal, init_db_once, settings


async def run_myclaw_agent(inp: Input, *, writer: StreamWriter | None = None) -> OutputEnvelope:
    await init_db_once()

    org_id = inp.session.org_id
    user_id = inp.session.user_id

    # Thread
    if inp.session.thread_id:
        try:
            tid = uuid.UUID(inp.session.thread_id)
        except ValueError:
            tid = uuid.uuid4()
    else:
        tid = uuid.uuid4()

    async with session_scope(SessionLocal) as session:
        thread = await session.get(Thread, tid)
        if not thread:
            thread = Thread(id=tid, title=None)
            session.add(thread)
            await session.flush()

        user_text = str(inp.message) if inp.message is not None else ""
        session.add(Message(thread_id=tid, role="user", content=user_text))

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
            f"{m.role}: {m.content}" for m in reversed(history) if m.role in {"user", "assistant"}
        )

        org_mem = (
            (
                await session.execute(
                    select(MemoryItem).where(
                        MemoryItem.scope == "org",
                        MemoryItem.scope_id == org_id,
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
                        MemoryItem.scope_id == user_id,
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

        chunks = await retrieve_kb(settings=settings, session=session, query=user_text)

    context = ""
    if chunks:
        context = "\n\n".join(
            f"[{c['source']}] {c['content']}" for c in chunks[: settings.kb_top_k]
        )

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
            f"User message:\n{user_text}",
        ]
        if p
    )

    acc: list[str] = []
    async for t in stream_assistant_reply(settings=settings, prompt=prompt):
        if writer:
            writer({"delta": t})
        acc.append(t)
    final_text = "".join(acc).strip()

    async with session_scope(SessionLocal) as session:
        session.add(Message(thread_id=tid, role="assistant", content=final_text or ""))

    return OutputEnvelope(
        thread_id=str(tid),
        message=final_text,
        entities=[],
        suggestedActions=[],
    )
