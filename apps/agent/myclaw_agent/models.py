from __future__ import annotations

import datetime as dt
import uuid
from typing import Any, Literal

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Thread(Base):
    __tablename__ = "threads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)

    messages: Mapped[list[Message]] = relationship(
        back_populates="thread", cascade="all, delete-orphan"
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    thread_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("threads.id"), index=True
    )
    role: Mapped[Literal["user", "assistant", "system"]] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text())
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    thread: Mapped[Thread] = relationship(back_populates="messages")


class MemoryItem(Base):
    __tablename__ = "memory_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scope: Mapped[Literal["org", "user", "thread"]] = mapped_column(String(16), index=True)
    scope_id: Mapped[str] = mapped_column(String(128), index=True)
    key: Mapped[str] = mapped_column(String(128), index=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON())
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )


class KbChunk(Base):
    __tablename__ = "kb_chunks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(256), index=True)
    content: Mapped[str] = mapped_column(Text())
    embedding: Mapped[list[float]] = mapped_column(Vector(1536))  # OpenAI text-embedding-3-small
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
