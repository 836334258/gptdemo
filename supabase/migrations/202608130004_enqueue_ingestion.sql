begin;

-- 浏览器只负责把文件写入受 RLS 保护的私有 bucket；文档、任务和队列消息
-- 由这一事务一次性创建，避免“有任务没消息”或“有消息没任务”。
create or replace function public.enqueue_document_ingestion(
  p_document_id uuid,
  p_job_id uuid,
  p_knowledge_base_id uuid,
  p_storage_path text,
  p_title text,
  p_mime_type text,
  p_content_hash text,
  p_idempotency_key text
)
returns table (document_id uuid, job_id uuid, queue_message_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
  existing_job public.ingestion_jobs%rowtype;
  sent_message_id bigint;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not rag.can_edit_knowledge_base(p_knowledge_base_id) then
    raise exception 'knowledge base write denied' using errcode = '42501';
  end if;
  if char_length(p_title) < 1 or char_length(p_title) > 512 then
    raise exception 'invalid document title' using errcode = '22023';
  end if;

  select kb.organization_id into target_organization_id
  from public.knowledge_bases kb where kb.id = p_knowledge_base_id;

  -- 对象路径第一段必须是组织 ID，和 storage.objects 的 RLS 约定一致。
  if p_storage_path not like target_organization_id::text || '/%' then
    raise exception 'storage path is outside organization scope' using errcode = '42501';
  end if;

  select * into existing_job
  from public.ingestion_jobs j where j.idempotency_key = p_idempotency_key;
  if found then
    if existing_job.organization_id <> target_organization_id then
      raise exception 'idempotency key belongs to another organization' using errcode = '42501';
    end if;
    return query select existing_job.document_id, existing_job.id, existing_job.queue_message_id;
    return;
  end if;

  insert into public.documents (
    id, knowledge_base_id, title, mime_type, status, canonical_uri, metadata
  ) values (
    p_document_id, p_knowledge_base_id, p_title, p_mime_type, 'pending',
    'storage://rag-private/' || p_storage_path,
    jsonb_build_object('storage_path', p_storage_path, 'content_hash', p_content_hash)
  );

  insert into public.ingestion_jobs (
    id, organization_id, document_id, idempotency_key, status, stage
  ) values (
    p_job_id, target_organization_id, p_document_id, p_idempotency_key, 'queued', 'queued'
  );

  select pgmq.send(
    'rag_ingestion',
    jsonb_build_object(
      'job_id', p_job_id,
      'organization_id', target_organization_id,
      'knowledge_base_id', p_knowledge_base_id,
      'document_id', p_document_id,
      'source_uri', 'storage://rag-private/' || p_storage_path,
      'title', p_title,
      'mime_type', p_mime_type,
      'content_hash', p_content_hash
    )
  ) into sent_message_id;

  update public.ingestion_jobs set queue_message_id = sent_message_id where id = p_job_id;
  return query select p_document_id, p_job_id, sent_message_id;
end;
$$;

revoke all on function public.enqueue_document_ingestion(uuid, uuid, uuid, text, text, text, text, text) from public;
grant execute on function public.enqueue_document_ingestion(uuid, uuid, uuid, text, text, text, text, text) to authenticated;

commit;
