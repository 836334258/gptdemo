from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
from urllib.parse import quote

import httpx
import psycopg
from psycopg import sql


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
LOCAL_SUPABASE_URL = "http://127.0.0.1:54321"
BUCKET = "rag-private"
AUTH_TABLES = ("users", "identities")


def load_repository_env() -> None:
    env_path = REPOSITORY_ROOT / ".env"
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name, value)


def table_columns(conn: psycopg.Connection, schema: str, table: str) -> list[str]:
    rows = conn.execute(
        """
        select column_name
        from information_schema.columns
        where table_schema = %s and table_name = %s and is_generated = 'NEVER'
        order by ordinal_position
        """,
        (schema, table),
    ).fetchall()
    return [str(row[0]) for row in rows]


def copy_table(
    source: psycopg.Connection,
    target: psycopg.Connection,
    schema: str,
    table: str,
) -> int:
    source_columns = table_columns(source, schema, table)
    target_columns = table_columns(target, schema, table)
    if source_columns != target_columns:
        raise RuntimeError(f"Column mismatch for {schema}.{table}")

    qualified = sql.SQL("{}.{}").format(sql.Identifier(schema), sql.Identifier(table))
    columns = sql.SQL(", ").join(map(sql.Identifier, source_columns))
    copy_out = sql.SQL("copy {} ({}) to stdout").format(qualified, columns)
    copy_in = sql.SQL("copy {} ({}) from stdin").format(qualified, columns)

    with source.cursor().copy(copy_out) as reader, target.cursor().copy(copy_in) as writer:
        for block in reader:
            writer.write(block)

    return int(source.execute(
        sql.SQL("select count(*) from {}").format(qualified)
    ).fetchone()[0])


def migrate_database(remote_db_url: str) -> None:
    with (
        psycopg.connect(LOCAL_DB_URL) as source,
        psycopg.connect(remote_db_url) as target,
    ):
        public_tables = [
            str(row[0])
            for row in source.execute(
                """
                select table_name
                from information_schema.tables
                where table_schema = 'public'
                  and table_type = 'BASE TABLE'
                  and table_name not like 'checkpoint%'
                order by table_name
                """
            ).fetchall()
        ]
        remote_public_tables = {
            str(row[0])
            for row in target.execute(
                """
                select table_name
                from information_schema.tables
                where table_schema = 'public' and table_type = 'BASE TABLE'
                """
            ).fetchall()
        }
        missing = sorted(set(public_tables) - remote_public_tables)
        if missing:
            raise RuntimeError(f"Remote schema is missing tables: {', '.join(missing)}")

        remote_users = int(target.execute("select count(*) from auth.users").fetchone()[0])
        remote_business_rows = 0
        for table in public_tables:
            if table == "model_catalog":
                continue
            qualified = sql.SQL("public.{}").format(sql.Identifier(table))
            remote_business_rows += int(
                target.execute(sql.SQL("select count(*) from {}").format(qualified)).fetchone()[0]
            )
        if remote_users or remote_business_rows:
            raise RuntimeError(
                "Remote project is no longer empty; refusing to replace cloud data"
            )

        try:
            target.execute("set session_replication_role = replica")
            target.execute("delete from auth.identities")
            target.execute("delete from auth.users")
            truncate_targets = sql.SQL(", ").join(
                sql.SQL("public.{}").format(sql.Identifier(table)) for table in public_tables
            )
            target.execute(sql.SQL("truncate table {} cascade").format(truncate_targets))

            copied: dict[str, int] = {}
            for table in AUTH_TABLES:
                copied[f"auth.{table}"] = copy_table(source, target, "auth", table)
            for table in public_tables:
                copied[f"public.{table}"] = copy_table(source, target, "public", table)

            target.execute("set session_replication_role = origin")
            target.commit()
        except Exception:
            target.rollback()
            raise

        for table, count in copied.items():
            if count:
                print(f"copied {table}: {count}")


def auth_headers(key: str) -> dict[str, str]:
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def migrate_storage(remote_url: str, remote_service_key: str, local_service_key: str) -> None:
    with psycopg.connect(LOCAL_DB_URL) as source:
        objects = source.execute(
            """
            select name, coalesce(metadata->>'mimetype', 'application/octet-stream')
            from storage.objects
            where bucket_id = %s
            order by name
            """,
            (BUCKET,),
        ).fetchall()

    with httpx.Client(timeout=120.0, follow_redirects=True) as client:
        for object_name, content_type in objects:
            encoded = quote(str(object_name), safe="/")
            local_response = client.get(
                f"{LOCAL_SUPABASE_URL}/storage/v1/object/{BUCKET}/{encoded}",
                headers=auth_headers(local_service_key),
            )
            local_response.raise_for_status()
            payload = local_response.content

            remote_response = client.post(
                f"{remote_url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}",
                headers={
                    **auth_headers(remote_service_key),
                    "x-upsert": "true",
                    "Content-Type": str(content_type),
                },
                content=payload,
            )
            remote_response.raise_for_status()

            verify_response = client.get(
                f"{remote_url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}",
                headers=auth_headers(remote_service_key),
            )
            verify_response.raise_for_status()
            if hashlib.sha256(verify_response.content).digest() != hashlib.sha256(payload).digest():
                raise RuntimeError(f"Storage checksum mismatch for {object_name}")
            print(f"copied storage object: {object_name} ({len(payload)} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--storage-only", action="store_true")
    args = parser.parse_args()

    load_repository_env()
    remote_db_url = os.environ["SUPABASE_DB_URL"]
    remote_url = os.environ["SUPABASE_URL"]
    remote_service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    local_service_key = os.environ["LOCAL_SUPABASE_SERVICE_ROLE_KEY"]

    if not args.storage_only:
        migrate_database(remote_db_url)
    migrate_storage(remote_url, remote_service_key, local_service_key)


if __name__ == "__main__":
    main()
