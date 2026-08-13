begin;

-- 评测运行也走持久队列；创建者必须能编辑对应组织，避免普通 viewer
-- 消耗大模型预算。Worker 完成后把 metrics 写回 eval_runs。
create or replace function public.enqueue_evaluation_run(
  p_run_id uuid,
  p_dataset_id uuid,
  p_config jsonb,
  p_idempotency_key text
)
returns table (run_id uuid, queue_message_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare target_org uuid; sent_id bigint;
begin
  select d.organization_id into target_org from public.eval_datasets d where d.id = p_dataset_id;
  if target_org is null or not rag.has_org_role(
    target_org, array['owner', 'admin', 'editor']::public.member_role[]
  ) then raise exception 'evaluation write denied' using errcode = '42501'; end if;

  insert into public.eval_runs (id, dataset_id, config, status)
  values (p_run_id, p_dataset_id, p_config || jsonb_build_object('idempotencyKey', p_idempotency_key), 'queued');
  select pgmq.send('rag_evaluation', jsonb_build_object(
    'run_id', p_run_id, 'dataset_id', p_dataset_id, 'config', p_config
  )) into sent_id;
  return query select p_run_id, sent_id;
end;
$$;

-- 删除使用软删除 + PGMQ；对象、版本、chunk 和缓存由 deletion worker
-- 异步清除，用户请求不承担长事务。
create or replace function public.enqueue_document_deletion(p_document_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare target_kb uuid; sent_id bigint;
begin
  select d.knowledge_base_id into target_kb from public.documents d where d.id = p_document_id;
  if target_kb is null or not rag.can_edit_knowledge_base(target_kb) then
    raise exception 'document delete denied' using errcode = '42501';
  end if;
  update public.documents set status = 'deleted', deleted_at = now() where id = p_document_id;
  update public.chunks set is_active = false where document_id = p_document_id;
  select pgmq.send('rag_deletion', jsonb_build_object('document_id', p_document_id)) into sent_id;
  return sent_id;
end;
$$;

revoke all on function public.enqueue_evaluation_run(uuid, uuid, jsonb, text) from public;
revoke all on function public.enqueue_document_deletion(uuid) from public;
grant execute on function public.enqueue_evaluation_run(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.enqueue_document_deletion(uuid) to authenticated;

-- 评测 case 和 run 允许 editor 写入；读取策略已在前序迁移定义。
grant insert, update, delete on table public.eval_cases, public.eval_runs to authenticated;
create policy eval_cases_write on public.eval_cases for all
using (exists (
  select 1 from public.eval_datasets d where d.id = dataset_id and rag.has_org_role(
    d.organization_id, array['owner', 'admin', 'editor']::public.member_role[]
  )
)) with check (exists (
  select 1 from public.eval_datasets d where d.id = dataset_id and rag.has_org_role(
    d.organization_id, array['owner', 'admin', 'editor']::public.member_role[]
  )
));

commit;
