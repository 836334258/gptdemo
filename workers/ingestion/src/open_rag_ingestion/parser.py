from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path
from urllib.parse import quote, urlparse

import httpx
from docling import __version__ as docling_version
from docling.document_converter import DocumentConverter

from .models import ParsedDocument, ParsedPage
from .settings import Settings


class DocumentParser:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._converter = DocumentConverter()

    def parse(self, source_uri: str, title: str) -> ParsedDocument:
        """Parse locally so private documents never need to leave our infrastructure."""
        local_path, temporary = self._materialize(source_uri)
        try:
            result = self._converter.convert(local_path)
            markdown = result.document.export_to_markdown()
        finally:
            # 远程原件只在解析期间落到系统临时目录，完成或失败都立即清理。
            if temporary:
                local_path.unlink(missing_ok=True)

        # Docling keeps rich layout in its lossless document representation. The first
        # implementation stores Markdown as page 1; page-aware export is the next parser adapter.
        return ParsedDocument(
            title=title,
            pages=[ParsedPage(page_number=1, content=markdown)],
            parser_name="docling",
            parser_version=docling_version,
            source_path=None if temporary else local_path,
        )

    def _materialize(self, source_uri: str) -> tuple[Path, bool]:
        parsed = urlparse(source_uri)
        if parsed.scheme == "storage":
            return self._download_storage_object(parsed.netloc, parsed.path.lstrip("/")), True
        if parsed.scheme in {"http", "https"}:
            return self._download(source_uri, suffix=Path(parsed.path).suffix), True
        if parsed.scheme == "file":
            return Path(parsed.path), False
        return Path(source_uri), False

    def _download_storage_object(self, bucket: str, object_path: str) -> Path:
        if not self._settings.supabase_url or not self._settings.supabase_service_role_key:
            raise RuntimeError("Storage ingestion requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        encoded_path = quote(object_path, safe="/")
        return self._download(
            f"{self._settings.supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{encoded_path}",
            suffix=Path(object_path).suffix,
            headers={
                "apikey": self._settings.supabase_service_role_key,
                "Authorization": f"Bearer {self._settings.supabase_service_role_key}",
            },
        )

    def _download(
        self,
        url: str,
        *,
        suffix: str = "",
        headers: dict[str, str] | None = None,
    ) -> Path:
        # 流式下载并执行硬性大小限制，避免大文件把 Worker 内存或磁盘打满。
        total = 0
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix or ".bin") as handle:
                temp_path = Path(handle.name)
                with httpx.stream(
                    "GET", url, headers=headers, follow_redirects=True, timeout=60.0
                ) as response:
                    response.raise_for_status()
                    for block in response.iter_bytes():
                        total += len(block)
                        if total > self._settings.max_document_bytes:
                            raise ValueError("Document exceeds configured size limit")
                        handle.write(block)
            return temp_path
        except Exception:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            raise


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
