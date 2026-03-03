from __future__ import annotations

import json
import re
from typing import Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langgraph.graph import END, StateGraph
from langgraph.types import StreamWriter

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

def _default_session(session: Session, memory: dict[str, Any]) -> dict[str, Any]:
    return {
        "churchId": memory.get("churchId") or session.church_id or "calvarybible",
        "userId": memory.get("userId") or session.user_id or "demo_user_noah",
        "personId": memory.get("personId") or session.person_id or "p_seeker_2",
        "householdId": memory.get("householdId") or session.household_id,
    }


def _make_action_pack(user_text: str, *, session: Session, memory: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Return a list of suggested actions for the web orchestrator to execute.

    For now we keep it simple and delegate natural-language execution to the
    Churchcore agent via A2A chat. This avoids outbound calls from LangSmith.
    """
    if user_text.startswith("/a2a "):
        # /a2a <endpoint> [<json_payload>]
        # Example:
        #   /a2a thread.list {"limit":20}
        # If no payload is provided, we'll send only the session.
        rest = user_text.removeprefix("/a2a ").strip()
        if not rest:
            return [
                {
                    "type": "a2a.call",
                    "input": {
                        "endpoint": "chat.stream",
                        "stream": True,
                        "payload": {
                            "skill": "chat",
                            "message": "usage: /a2a <endpoint> [<json_payload>]",
                            "args": None,
                            "session": _default_session(session, memory),
                        },
                    },
                }
            ]
        parts = rest.split(" ", 1)
        endpoint = parts[0].strip()
        payload_text = parts[1].strip() if len(parts) > 1 else ""
        payload: dict[str, Any] = {}
        if payload_text:
            try:
                v = json.loads(payload_text)
                if isinstance(v, dict):
                    payload = v
            except Exception:
                payload = {"message": payload_text}
        payload.setdefault("session", _default_session(session, memory))
        return [{"type": "a2a.call", "input": {"endpoint": endpoint, "stream": endpoint.endswith(".stream"), "payload": payload}}]

    return [
        {
            "type": "a2a.call",
            "input": {
                "endpoint": "chat.stream",
                "stream": True,
                "payload": {
                    "skill": "chat",
                    "message": user_text,
                    "args": None,
                    "session": _default_session(session, memory),
                },
            },
        }
    ]


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
        actions = _make_action_pack(user_text, session=session, memory=memory)
        final_text = ""

    assistant_msg = AIMessage(content=final_text)
    next_messages = prior_messages + [assistant_msg]

    out = OutputEnvelope(
        thread_id=session.thread_id or "unknown",
        message=final_text,
        suggested_actions=actions if not user_text.startswith(("/mem ", "/kb ")) else [],
    ).model_dump(by_alias=True)
    return {"output": out, "messages": next_messages, "memory": memory, "kb": kb}


builder: StateGraph = StateGraph(GraphState)
builder.add_node("assistant", assistant_node)
builder.set_entry_point("assistant")
builder.add_edge("assistant", END)

graph = builder.compile()
