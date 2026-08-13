from __future__ import annotations

import json
import time
from typing import Any, cast

import httpx
import structlog
from psycopg.rows import dict_row

from .repository import Repository
from .settings import Settings

log = structlog.get_logger()


class OperationsWorker:
    """Consumes deletion and evaluation queues independently from heavy parser jobs."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.repository = Repository(settings)

    def run_deletion_once(self) -> bool:
        with self.repository.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            cursor.execute("select * from pgmq.read('rag_deletion', 300, 1)")
            row = cursor.fetchone()
            if row is None:
                return False
            payload = _payload(row["message"])
            document_id = payload["document_id"]
            try:
                cursor.execute(
                    "select metadata->>'storage_path' as storage_path from public.documents where id = %s",
                    (document_id,),
                )
                document = cursor.fetchone()
                storage_path = document["storage_path"] if document else None
                if storage_path:
                    self._delete_storage_object(cast(str, storage_path))
                # 删除文档会级联版本、页、chunk、job；队列消息在同一 DB 事务归档。
                cursor.execute("delete from public.documents where id = %s", (document_id,))
                cursor.execute("select pgmq.archive('rag_deletion', %s)", (row["msg_id"],))
                conn.commit()
                log.info("document_deleted", document_id=document_id)
            except Exception:
                conn.rollback()
                log.exception("document_deletion_failed", document_id=document_id)
            return True

    def run_evaluation_once(self) -> bool:
        with self.repository.connection() as conn, conn.cursor(row_factory=dict_row) as cursor:
            cursor.execute("select * from pgmq.read('rag_evaluation', 900, 1)")
            row = cursor.fetchone()
            if row is None:
                return False
            payload = _payload(row["message"])
            run_id = payload["run_id"]
            try:
                cursor.execute(
                    "update public.eval_runs set status='running', started_at=now() where id=%s",
                    (run_id,),
                )
                cursor.execute(
                    """
                    select c.id, c.input, c.expected
                    from public.eval_cases c join public.eval_runs r on r.dataset_id = c.dataset_id
                    where r.id = %s order by c.created_at
                    """,
                    (run_id,),
                )
                cases = cursor.fetchall()
                passed = 0
                latencies: list[int] = []
                for case in cases:
                    result = self._evaluate_case(cast(dict[str, Any], case["input"]))
                    expected = cast(dict[str, Any] | None, case["expected"])
                    score = _score_answer(result["answer"], expected)
                    passed += int(score >= 1.0)
                    latencies.append(result["latency_ms"])
                    cursor.execute(
                        """
                        insert into public.eval_case_results
                          (run_id, case_id, output, scores, latency_ms, passed)
                        values (%s, %s, %s, %s, %s, %s)
                        on conflict (run_id, case_id) do update set
                          output=excluded.output, scores=excluded.scores,
                          latency_ms=excluded.latency_ms, passed=excluded.passed
                        """,
                        (
                            run_id,
                            case["id"],
                            json.dumps({"answer": result["answer"]}),
                            json.dumps({"answer_match": score}),
                            result["latency_ms"],
                            score >= 1.0,
                        ),
                    )
                total = len(cases)
                metrics = {
                    "caseCount": total,
                    "passRate": passed / total if total else 0,
                    "averageLatencyMs": sum(latencies) / total if total else 0,
                }
                cursor.execute(
                    "update public.eval_runs set status='succeeded', metrics=%s, finished_at=now() where id=%s",
                    (json.dumps(metrics), run_id),
                )
                cursor.execute("select pgmq.archive('rag_evaluation', %s)", (row["msg_id"],))
                conn.commit()
                log.info("evaluation_succeeded", run_id=run_id, case_count=total)
            except Exception as error:
                conn.rollback()
                with self.repository.connection() as failure_conn, failure_conn.cursor() as failure_cursor:
                    failure_cursor.execute(
                        "update public.eval_runs set status='failed', metrics=%s, finished_at=now() where id=%s",
                        (json.dumps({"error": str(error)}), run_id),
                    )
                    failure_conn.commit()
                log.exception("evaluation_failed", run_id=run_id)
            return True

    def _delete_storage_object(self, path: str) -> None:
        if not self.settings.supabase_url or not self.settings.supabase_service_role_key:
            raise RuntimeError("Deletion requires Supabase service configuration")
        response = httpx.delete(
            f"{self.settings.supabase_url.rstrip('/')}/storage/v1/object/rag-private/{path}",
            headers={
                "apikey": self.settings.supabase_service_role_key,
                "Authorization": f"Bearer {self.settings.supabase_service_role_key}",
            },
            timeout=30.0,
        )
        if response.status_code not in {200, 204, 404}:
            response.raise_for_status()

    def _evaluate_case(self, case_input: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.evaluation_worker_token:
            raise RuntimeError("EVALUATION_WORKER_TOKEN is required")
        started = time.perf_counter()
        response = httpx.post(
            self.settings.evaluation_api_url,
            headers={"Authorization": f"Bearer {self.settings.evaluation_worker_token}"},
            json=case_input,
            timeout=180.0,
        )
        response.raise_for_status()
        return {
            "answer": str(response.json()["answer"]),
            "latency_ms": round((time.perf_counter() - started) * 1000),
        }


def _payload(value: object) -> dict[str, Any]:
    if isinstance(value, str):
        return cast(dict[str, Any], json.loads(value))
    return cast(dict[str, Any], value)


def _score_answer(answer: str, expected: dict[str, Any] | None) -> float:
    if not expected:
        return 1.0
    required = [str(item).lower() for item in expected.get("contains", [])]
    normalized = answer.lower()
    return 1.0 if all(item in normalized for item in required) else 0.0


def run_operations() -> None:
    settings = Settings()  # type: ignore[call-arg]
    worker = OperationsWorker(settings)
    while True:
        worked = worker.run_deletion_once() or worker.run_evaluation_once()
        if not worked:
            time.sleep(settings.poll_seconds)


if __name__ == "__main__":
    run_operations()
