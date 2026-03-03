from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Session(BaseModel):
    # Match Churchcore A2A conventions (camelCase) while still accepting snake_case.
    church_id: str | None = Field(default=None, alias="churchId")
    user_id: str | None = Field(default=None, alias="userId")
    person_id: str | None = Field(default=None, alias="personId")
    household_id: str | None = Field(default=None, alias="householdId")

    # Optional: allow callers to pass through the LangSmith thread id.
    thread_id: str | None = None

    class Config:
        populate_by_name = True


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
