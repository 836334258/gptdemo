begin;

create or replace function public.retry_ingestion_job(p_job_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare job public.ingestion_jobs%rowtype; document public.documents%rowtype; sent_id bigint;
begin
  select * into job from public.ingestion_jobs j where j.id = p_job_id for update;
  if not found or not rag.has_org_role(
    job.organization_id, array['owner', 'admin', 'editor']::public.member_role[]
  ) then raise exception 'ingestion retry denied' using errcode = '42501'; end if;
  if job.status not in ('failed', 'dead_letter') then
    raise exception 'only failed jobs can be retried' using errcode = '22023';
  end if;
  select * into document from public.documents d where d.id = job.document_id;
  if not found then raise exception 'document not found' using errcode = '22023'; end if;

  select pgmq.send('rag_ingestion', jsonb_build_object(
    'job_id', job.id,
    'organization_id', job.organization_id,
    'knowledge_base_id', document.knowledge_base_id,
    'data_source_id', job.data_source_id,
    'document_id', document.id,
    'source_uri', document.canonical_uri,
    'title', document.title,
    'mime_type', document.mime_type,
    'content_hash', document.metadata->>'content_hash'
  )) into sent_id;
  update public.ingestion_jobs set
    status='retrying', stage='queued', attempt=0, error=null,
    queue_message_id=sent_id, available_at=now(), finished_at=null
  where id=p_job_id;
  update public.documents set status='pending' where id=document.id;
  return sent_id;
end;
$$;

revoke all on function public.retry_ingestion_job(uuid) from public;
grant execute on function public.retry_ingestion_job(uuid) to authenticated;

commit;
