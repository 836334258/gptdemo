begin;

-- NULLS NOT DISTINCT 会把所有没有 data source / external id 的浏览器上传
-- 都视为同一个键，导致第二个本地文件永远触发 23505。外部同步文档才需要
-- 依靠 (data_source_id, external_id) 去重；本地上传由 ingestion idempotency key 去重。
alter table public.documents
  drop constraint if exists documents_data_source_id_external_id_key;

create unique index if not exists documents_data_source_external_unique
  on public.documents (data_source_id, external_id)
  where data_source_id is not null and external_id is not null;

commit;
