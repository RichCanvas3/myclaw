from __future__ import annotations

import uuid

from langchain_core.runnables import RunnableLambda

from .server import ActRequest


def _act_input(payload: dict) -> ActRequest:
    # Minimal adapter for LangServe (non-streaming).
    return ActRequest(**payload)


def _act_output(req: ActRequest) -> dict:
    # This is intentionally thin: primary API is the SSE `/agent/act`.
    # LangServe is mounted so you can evolve this into a full graph later.
    tid = req.thread_id or str(uuid.uuid4())
    return {
        "thread_id": tid,
        "message": req.message,
    }


act_runnable = RunnableLambda(_act_input) | RunnableLambda(_act_output)
