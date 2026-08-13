from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterator, cast
from uuid import UUID

from psycopg import Connection
from psycopg.rows import dict_row

from .models import ChunkRecord, IngestionMessage, ParsedDocument
from .settings import Settings


class Repository:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    @contextmanager
    def connection(self) -> Iterator[Connection[dict[str, object]]]:
        with Connection.connect(self._settings.supabase_db_url, row_factory=dict_row) as conn:
            yield conn

    def read_message(self) -> IngestionMessage | None:
        with self.connection() as conn, conn.cursor() as cursor:
            cursor.execute(
                "select * from pgmq.read(%s, %s, 1)",
                (self._settings.queue_name, self._settings.queue_visibility_seconds),
            )
            row = cursor.fetchone()
            if row is None:
                return None
            payload = row["message"]
            if isinstance(payload, str):
                payload = json.loads(payload)
            payload = cast(dict[str, Any], payload)
            return IngestionMessage(
                message_id=int(cast(int, row["msg_id"])),
                read_count=int(cast(int, row["read_ct"])),
                job_id=UUID(payload["job_id"]),
                organization_id=UUID(payload["organization_id"]),
                knowledge_base_id=UUID(payload["knowledge_base_id"]),
                data_source_id=UUID(payload["data_source_id"]) if payload.get("data_source_id") else None,
                document_id=UUID(payload["document_id"]),
                source_uri=payload["source_uri"],
                title=payload["title"],
                mime_type=payload.get("mime_type"),
                content_hash=payload.get("content_hash"),
            )

    def mark_running(self, message: IngestionMessage) -> bool:
        """The state transition doubles as an idempotency lock across worker replicas."""
        with self.connection() as conn, conn.cursor() as cursor:
            cursor.execute(
                """
                update public.ingestion_jobs
                set status = 'running', stage = 'parsing', started_at = coalesce(started_at, now()),
                    attempt = attempt + 1, queue_message_id = %s
                where id = %s and status in ('queued', 'retrying') and attempt < max_attempts
                returning id
                """,
                (message.message_id, message.job_id),
            )
            acquired = cursor.fetchone() is not None
            conn.commit()
            return acquired

    def activate_version(
        self,
        message: IngestionMessage,
        parsed: ParsedDocument,
        chunks: list[ChunkRecord],
        content_hash: str,
    ) -> None:
        """Write a complete version and activate it atomically; partial indexes stay invisible."""
        with self.connection() as conn, conn.cursor() as cursor:
            cursor.execute(
                "select coalesce(max(version), 0) + 1 as next_version from public.document_versions where document_id = %s",
                (message.document_id,),
            )
            version_row = cursor.fetchone()
            if version_row is None:
                raise RuntimeError("Failed to allocate document version")
            version_number = int(cast(int, version_row["next_version"]))
            cursor.execute(
                """
                insert into public.document_versions
                  (document_id, version, content_hash, parser_name, parser_version, status)
                values (%s, %s, %s, %s, %s, 'processing') returning id
                """,
                (
                    message.document_id,
                    version_number,
                    content_hash,
                    parsed.parser_name,
                    parsed.parser_version,
                ),
            )
            version_row = cursor.fetchone()
            if version_row is None:
                raise RuntimeError("Failed to create document version")
            version_id = cast(UUID, version_row["id"])

            page_ids: dict[int, UUID] = {}
            for page in parsed.pages:
                cursor.execute(
                    """
                    insert into public.document_pages (document_version_id, page_number, content, layout)
                    values (%s, %s, %s, %s) returning id
                    """,
                    (version_id, page.page_number, page.content, json.dumps(page.layout)),
                )
                page_row = cursor.fetchone()
                if page_row is None:
                    raise RuntimeError(f"Failed to create page {page.page_number}")
                page_ids[page.page_number] = cast(UUID, page_row["id"])

            for chunk in chunks:
                cursor.execute(
                    """
                    insert into public.chunks
                      (knowledge_base_id, document_id, document_version_id, page_id, ordinal,
                       page_number, content, content_hash, token_count, metadata, embedding, is_active)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, false)
                    """,
                    (
                        message.knowledge_base_id,
                        message.document_id,
                        version_id,
                        page_ids.get(chunk.page_number) if chunk.page_number else None,
                        chunk.ordinal,
                        chunk.page_number,
                        chunk.content,
                        chunk.content_hash,
                        chunk.token_count,
                        json.dumps(chunk.metadata),
                        chunk.embedding,
                    ),
                )

            cursor.execute("update public.chunks set is_active = false where document_id = %s", (message.document_id,))
            cursor.execute("update public.chunks set is_active = true where document_version_id = %s", (version_id,))
            cursor.execute(
                "update public.document_versions set status = 'active', activated_at = now() where id = %s",
                (version_id,),
            )
            cursor.execute(
                "update public.documents set active_version_id = %s, status = 'active' where id = %s",
                (version_id, message.document_id),
            )
            cursor.execute(
                "update public.ingestion_jobs set status = 'succeeded', stage = 'complete', finished_at = now() where id = %s",
                (message.job_id,),
            )
            cursor.execute("select pgmq.archive(%s, %s)", (self._settings.queue_name, message.message_id))
            conn.commit()

    def mark_failed(self, message: IngestionMessage, error: Exception) -> None:
        with self.connection() as conn, conn.cursor() as cursor:
            terminal = message.read_count >= 5
            status = "dead_letter" if terminal else "retrying"
            cursor.execute(
                """
                update public.ingestion_jobs
                set status = %s, stage = 'failed', error = %s,
                    available_at = now() + make_interval(secs => least(300, power(2, attempt)::int * 5)),
                    finished_at = case when %s then now() else null end
                where id = %s
                """,
                (status, json.dumps({"type": type(error).__name__, "message": str(error)}), terminal, message.job_id),
            )
            if terminal:
                cursor.execute("select pgmq.archive(%s, %s)", (self._settings.queue_name, message.message_id))
            conn.commit()
