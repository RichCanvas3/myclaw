from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Session(BaseModel):
    org_id: str = "default"
    user_id: str = "default"
    thread_id: str | None = None


class Input(BaseModel):
    skill: str = "chat"
    message: Any
    args: Any | None = None
    session: Session


class OutputEnvelope(BaseModel):
    thread_id: str
    message: str
    entities: list[Any] = Field(default_factory=list)
    suggested_actions: list[Any] = Field(default_factory=list, alias="suggestedActions")

    class Config:
        populate_by_name = True
