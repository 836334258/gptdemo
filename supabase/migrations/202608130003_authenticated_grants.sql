begin;

-- PostgreSQL 权限是第一道门，RLS 是第二道门。这里逐表授权，刻意不使用
-- `all tables in schema public`，避免 LangGraph checkpoint 等内部表被暴露。
grant usage on schema public to authenticated;

grant select on table
  public.organizations,
  public.organization_members,
  public.knowledge_bases,
  public.knowledge_base_acl,
  public.data_sources,
  public.source_sync_runs,
  public.documents,
  public.document_versions,
  public.document_pages,
  public.chunks,
  public.ingestion_jobs,
  public.conversations,
  public.messages,
  public.context_summary_versions,
  public.artifacts,
  public.tool_runs,
  public.retrieval_runs,
  public.retrieval_candidates,
  public.citations,
  public.model_catalog,
  public.prompt_versions,
  public.feedback,
  public.eval_datasets,
  public.eval_cases,
  public.eval_runs,
  public.audit_logs
to authenticated;

grant insert, update, delete on table
  public.organizations,
  public.organization_members,
  public.knowledge_bases,
  public.knowledge_base_acl,
  public.data_sources,
  public.documents,
  public.conversations,
  public.messages,
  public.context_summary_versions,
  public.artifacts,
  public.tool_runs,
  public.retrieval_runs,
  public.retrieval_candidates,
  public.citations,
  public.feedback,
  public.eval_datasets
to authenticated;

-- audit_logs 使用 identity；浏览器没有 insert 权限，序列仅供受信任的服务端角色。
grant usage, select on all sequences in schema public to service_role;

commit;
