from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


# Worker 可能从仓库根目录或 workers/ingestion 启动。使用源码位置定位根 .env，
# 避免 Pydantic 只按当前工作目录查找 .env，导致 SUPABASE_DB_URL 被误判为缺失。
REPOSITORY_ENV_FILE = Path(__file__).resolve().parents[4] / ".env"


class Settings(BaseSettings):
    """Only the worker receives the direct database and service-role credentials."""

    # 根 .env 提供本地共享配置；真实进程环境变量依然拥有最高优先级，
    # 因此生产环境可以用 Secret Manager/Kubernetes Secret 安全覆盖本地值。
    model_config = SettingsConfigDict(env_file=REPOSITORY_ENV_FILE, extra="ignore")

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
    # 本地 CPU TEI 以小批次控制峰值内存；生产 GPU 可用环境变量覆盖。
    embedding_batch_size: int = 8
    chunk_size: int = 700
    chunk_overlap: int = 100
    max_document_bytes: int = 100 * 1024 * 1024
    worker_id: str = "ingestion-worker-1"
