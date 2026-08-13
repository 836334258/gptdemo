from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID


@dataclass(frozen=True)
class IngestionMessage:
    message_id: int
    read_count: int
    job_id: UUID
    organization_id: UUID
    knowledge_base_id: UUID
    data_source_id: UUID | None
    document_id: UUID
    source_uri: str
    title: str
    mime_type: str | None = None
    content_hash: str | None = None


@dataclass(frozen=True)
class ParsedPage:
    page_number: int
    content: str
    layout: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ParsedDocument:
    title: str
    pages: list[ParsedPage]
    parser_name: str
    parser_version: str
    source_path: Path | None = None


@dataclass(frozen=True)
class ChunkRecord:
    ordinal: int
    page_number: int | None
    content: str
    content_hash: str
    token_count: int
    metadata: dict[str, Any]
    embedding: list[float]
