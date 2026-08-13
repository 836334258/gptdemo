begin;

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
declare target_org uuid; sent_id bigint; case_count integer;
begin
  select d.organization_id into target_org from public.eval_datasets d where d.id = p_dataset_id;
  if target_org is null or not rag.has_org_role(
    target_org, array['owner', 'admin', 'editor']::public.member_role[]
  ) then raise exception 'evaluation write denied' using errcode = '42501'; end if;
  select count(*) into case_count from public.eval_cases c where c.dataset_id = p_dataset_id;
  if case_count = 0 then raise exception 'evaluation dataset has no cases' using errcode = '22023'; end if;

  insert into public.eval_runs (id, dataset_id, config, status)
  values (p_run_id, p_dataset_id, p_config || jsonb_build_object('idempotencyKey', p_idempotency_key), 'queued');
  select pgmq.send('rag_evaluation', jsonb_build_object(
    'run_id', p_run_id, 'dataset_id', p_dataset_id, 'config', p_config
  )) into sent_id;
  return query select p_run_id, sent_id;
end;
$$;

commit;
