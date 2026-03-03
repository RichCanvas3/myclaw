from __future__ import annotations

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

    # Minimal, deployment-safe behavior: no external deps, no DB.
    final_text = f"echo: {user_text}".strip()
    writer({"delta": final_text})

    assistant_msg = AIMessage(content=final_text)
    next_messages = prior_messages + [assistant_msg]

    out = OutputEnvelope(thread_id=session.thread_id or "unknown", message=final_text).model_dump(
        by_alias=True
    )
    return {"output": out, "messages": next_messages}


builder: StateGraph = StateGraph(GraphState)
builder.add_node("assistant", assistant_node)
builder.set_entry_point("assistant")
builder.add_edge("assistant", END)

graph = builder.compile()
