from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    openai_api_key: str | None
    openai_model: str
    kb_top_k: int


def get_settings() -> Settings:
    database_url = os.environ.get(
        "DATABASE_URL", "postgresql+psycopg://myclaw:myclaw@localhost:5432/myclaw"
    )
    openai_api_key = os.environ.get("OPENAI_API_KEY") or None
    openai_model = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")
    kb_top_k = int(os.environ.get("KB_TOP_K", "5"))

    return Settings(
        database_url=database_url,
        openai_api_key=openai_api_key,
        openai_model=openai_model,
        kb_top_k=kb_top_k,
    )
