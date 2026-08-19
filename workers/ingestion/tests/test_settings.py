from pathlib import Path

from open_rag_ingestion.settings import REPOSITORY_ENV_FILE


def test_repository_env_file_points_to_workspace_root() -> None:
    """Keep Worker startup independent from the caller's current directory."""

    assert REPOSITORY_ENV_FILE == Path(__file__).resolve().parents[3] / ".env"
