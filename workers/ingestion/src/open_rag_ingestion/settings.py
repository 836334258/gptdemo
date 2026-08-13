from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Only the worker receives the direct database and service-role credentials."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_db_url: str = Field(alias="SUPABASE_DB_URL")
    supabase_url: str | None = Field(default=None, alias="SUPABASE_URL")
    supabase_service_role_key: str | None = Field(
        default=None, alias="SUPABASE_SERVICE_ROLE_KEY"
    )
    evaluation_api_url: str = Field(
        default="http://127.0.0.1:3000/api/internal/evaluate", alias="EVALUATION_API_URL"
    )
    evaluation_worker_token: str | None = Field(default=None, alias="EVALUATION_WORKER_TOKEN")
    tei_embedding_url: str = Field(
        default="http://127.0.0.1:8081", alias="TEI_EMBEDDING_URL"
    )
    queue_name: str = "rag_ingestion"
    queue_visibility_seconds: int = 300
    poll_seconds: float = 2.0
    embedding_batch_size: int = 32
    chunk_size: int = 700
    chunk_overlap: int = 100
    max_document_bytes: int = 100 * 1024 * 1024
    worker_id: str = "ingestion-worker-1"
