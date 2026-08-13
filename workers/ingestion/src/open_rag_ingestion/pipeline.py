from __future__ import annotations

import math
from typing import Iterable

import httpx
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.schema import Document

from .models import ChunkRecord, ParsedDocument
from .parser import sha256_text
from .settings import Settings


class IngestionPipeline:
    """LlamaIndex is deliberately limited to transformations, never Agent orchestration."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._splitter = SentenceSplitter(
            chunk_size=settings.chunk_size,
            chunk_overlap=settings.chunk_overlap,
        )

    def build_chunks(self, parsed: ParsedDocument) -> list[ChunkRecord]:
        pending: list[tuple[int | None, str, dict[str, object]]] = []
        for page in parsed.pages:
            nodes = self._splitter.get_nodes_from_documents(
                [Document(text=page.content, metadata={"page_number": page.page_number})]
            )
            for node in nodes:
                text = node.get_content().strip()
                if text:
                    pending.append((page.page_number, text, dict(node.metadata)))

        embeddings = self._embed([item[1] for item in pending])
        return [
            ChunkRecord(
                ordinal=index,
                page_number=page_number,
                content=text,
                content_hash=sha256_text(text),
                token_count=math.ceil(len(text) / 3),
                metadata=metadata,
                embedding=embeddings[index],
            )
            for index, (page_number, text, metadata) in enumerate(pending)
        ]

    def _embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for batch in batched(texts, self._settings.embedding_batch_size):
            response = httpx.post(
                f"{self._settings.tei_embedding_url.rstrip('/')}/embed",
                json={"inputs": batch, "normalize": True},
                timeout=60.0,
            )
            response.raise_for_status()
            vectors.extend(response.json())
        return vectors


def batched(values: list[str], size: int) -> Iterable[list[str]]:
    for offset in range(0, len(values), size):
        yield values[offset : offset + size]
