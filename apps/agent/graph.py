from __future__ import annotations

import asyncio
import json
import re
from typing import Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langgraph.graph import END, StateGraph
from langgraph.types import StreamWriter

from apps.agent.a2a import chat, chat_stream_sse_lines
from apps.agent.models import OutputEnvelope, Session


class GraphState(TypedDict, total=False):
    skill: str
    message: Any
    args: Any
    session: dict[str, Any]

    input: dict[str, Any]

    output: dict[str, Any]
    messages: list[BaseMessage]
    memory: dict[str, Any]
    kb: list[dict[str, Any]]


def _tokenize(s: str) -> set[str]:
    return {t for t in re.split(r"[^a-zA-Z0-9]+", s.lower()) if t}


def _kb_search(kb: list[dict[str, Any]], query: str, *, k: int = 5) -> list[dict[str, Any]]:
    q = _tokenize(query)
    scored: list[tuple[int, dict[str, Any]]] = []
    for item in kb:
        text = str(item.get("text") or "")
        tokens = _tokenize(text)
        score = len(q.intersection(tokens))
        if score:
            scored.append((score, item))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [it for _, it in scored[:k]]

def json_dumps(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, indent=2, sort_keys=True)


async def assistant_node(state: GraphState, writer: StreamWriter) -> GraphState:
    input_dict = state.get("input")
    if isinstance(input_dict, dict):
        payload = input_dict
    else:
        payload = {
            "skill": state.get("skill"),
            "message": state.get("message"),
            "args": state.get("args"),
            "session": state.get("session"),
        }

    session_dict = payload.get("session") or {}
    if not isinstance(session_dict, dict):
        out = OutputEnvelope(thread_id="unknown", message="Missing session.").model_dump(
            by_alias=True
        )
        return {"output": out, "messages": [AIMessage(content=out["message"])]}

    try:
        session = Session(**session_dict)
    except Exception as e:
        out = OutputEnvelope(thread_id="unknown", message=f"Invalid input: {e}").model_dump(
            by_alias=True
        )
        return {"output": out, "messages": [AIMessage(content=out["message"])]}

    prior_messages = list(state.get("messages") or [])
    user_text = str(payload.get("message") or "")
    prior_messages.append(HumanMessage(content=user_text))

    memory = dict(state.get("memory") or {})
    kb = list(state.get("kb") or [])

    # Seed memory from session, if present.
    if session.church_id:
        memory["churchId"] = session.church_id
    if session.user_id:
        memory["userId"] = session.user_id
    if session.person_id:
        memory["personId"] = session.person_id
    if session.household_id:
        memory["householdId"] = session.household_id

    # Simple local commands for memory + KB.
    if user_text.startswith("/mem "):
        # /mem set key=value
        # /mem show
        cmd = user_text.removeprefix("/mem ").strip()
        if cmd == "show":
            final_text = json_dumps(memory)
        elif cmd.startswith("set "):
            rest = cmd.removeprefix("set ").strip()
            if "=" in rest:
                k, v = rest.split("=", 1)
                memory[k.strip()] = v.strip()
                final_text = f"ok: set {k.strip()}"
            else:
                final_text = "usage: /mem set key=value"
        else:
            final_text = "usage: /mem show | /mem set key=value"
        writer({"delta": final_text})
    elif user_text.startswith("/kb "):
        # /kb add <text>
        # /kb search <query>
        cmd = user_text.removeprefix("/kb ").strip()
        if cmd.startswith("add "):
            text = cmd.removeprefix("add ").strip()
            if not text:
                final_text = "usage: /kb add <text>"
            else:
                kb.append({"text": text})
                final_text = "ok: added"
            writer({"delta": final_text})
        elif cmd.startswith("search "):
            q = cmd.removeprefix("search ").strip()
            hits = _kb_search(kb, q, k=5)
            if not hits:
                final_text = "no matches"
            else:
                final_text = "\n\n".join(f"- {h.get('text','')}" for h in hits)
            writer({"delta": final_text})
        else:
            final_text = "usage: /kb add <text> | /kb search <query>"
            writer({"delta": final_text})
    else:
        # Default: proxy to Churchcore A2A chat (stream if possible).
        a2a_payload = {
            "skill": "chat",
            "message": user_text,
            "args": None,
            "session": {
                "churchId": memory.get("churchId") or session.church_id,
                "userId": memory.get("userId") or session.user_id,
                "personId": memory.get("personId") or session.person_id,
                "householdId": memory.get("householdId") or session.household_id,
            },
        }

        # Try streaming first; if it errors, fall back to non-stream chat.
        acc: list[str] = []

        def run_stream_sync() -> None:
            for t in chat_stream_sse_lines(a2a_payload):
                acc.append(t)
                writer({"delta": t})

        try:
            await asyncio.to_thread(run_stream_sync)
            final_text = "".join(acc).strip()
            if not final_text:
                # If stream produced nothing, try non-stream.
                resp = await asyncio.to_thread(chat, a2a_payload)
                final_text = str(resp) if resp is not None else ""
                writer({"delta": final_text})
        except Exception:
            resp = await asyncio.to_thread(chat, a2a_payload)
            final_text = str(resp) if resp is not None else ""
            writer({"delta": final_text})

    assistant_msg = AIMessage(content=final_text)
    next_messages = prior_messages + [assistant_msg]

    out = OutputEnvelope(thread_id=session.thread_id or "unknown", message=final_text).model_dump(
        by_alias=True
    )
    return {"output": out, "messages": next_messages, "memory": memory, "kb": kb}


builder: StateGraph = StateGraph(GraphState)
builder.add_node("assistant", assistant_node)
builder.set_entry_point("assistant")
builder.add_edge("assistant", END)

graph = builder.compile()
