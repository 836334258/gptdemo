from __future__ import annotations

import signal
from threading import Event

import structlog

from .parser import DocumentParser, sha256_text
from .pipeline import IngestionPipeline
from .repository import Repository
from .settings import Settings

log = structlog.get_logger()


def run() -> None:
    settings = Settings()  # type: ignore[call-arg]
    repository = Repository(settings)
    parser = DocumentParser(settings)
    pipeline = IngestionPipeline(settings)
    stopping = Event()

    def stop(_signum: int, _frame: object) -> None:
        stopping.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    log.info("worker_started", worker_id=settings.worker_id, queue=settings.queue_name)

    while not stopping.is_set():
        message = repository.read_message()
        if message is None:
            stopping.wait(settings.poll_seconds)
            continue
        if not repository.mark_running(message):
            # Another worker owns it or it has already succeeded. The queue visibility timeout
            # prevents a busy loop and the winning worker will archive the message.
            continue

        try:
            log.info("ingestion_started", job_id=str(message.job_id), uri=message.source_uri)
            parsed = parser.parse(message.source_uri, message.title)
            chunks = pipeline.build_chunks(parsed)
            full_text = "\n\n".join(page.content for page in parsed.pages)
            repository.activate_version(
                message,
                parsed,
                chunks,
                message.content_hash or sha256_text(full_text),
            )
            log.info("ingestion_succeeded", job_id=str(message.job_id), chunks=len(chunks))
        except Exception as error:  # noqa: BLE001 - the queue must record every parser failure
            repository.mark_failed(message, error)
            log.exception("ingestion_failed", job_id=str(message.job_id))

    log.info("worker_stopped", worker_id=settings.worker_id)


def main() -> None:
    run()


if __name__ == "__main__":
    main()
