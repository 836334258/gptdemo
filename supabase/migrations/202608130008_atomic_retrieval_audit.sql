begin;

-- 原设计用多个可空业务字段组成主键，PostgreSQL 会隐式把它们改成 NOT NULL，
-- 无法同时表达“网页候选没有 chunk_id”和“知识库候选没有 URL”。改用独立 UUID。
alter table public.retrieval_candidates drop constraint retrieval_candidates_pkey;
-- 主键曾隐式施加 NOT NULL；删除复合主键后要显式恢复两类候选需要的可空性。
alter table public.retrieval_candidates alter column chunk_id drop not null;
alter table public.retrieval_candidates alter column source_uri drop not null;
alter table public.retrieval_candidates add column id uuid not null default gen_random_uuid();
alter table public.retrieval_candidates add primary key (id);
create unique index retrieval_candidates_chunk_once
  on public.retrieval_candidates (retrieval_run_id, chunk_id)
  where chunk_id is not null;
create unique index retrieval_candidates_url_once
  on public.retrieval_candidates (retrieval_run_id, provider, source_uri)
  where source_uri is not null;

create or replace function public.save_rag_turn(
  p_message_id uuid,
  p_conversation_id uuid,
  p_content jsonb,
  p_model text,
  p_query text,
  p_rewritten_queries text[],
  p_retrieval_config jsonb,
  p_candidates jsonb default '[]'::jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare candidate jsonb; run_id uuid := gen_random_uuid(); inserted_rows integer;
begin
  insert into public.messages (id, conversation_id, role, content, status, model)
  values (p_message_id, p_conversation_id, 'assistant', p_content, 'complete', p_model)
  on conflict (id) do nothing;
  get diagnostics inserted_rows = row_count;
  if inserted_rows = 0 then return; end if;

  insert into public.retrieval_runs (
    id, conversation_id, message_id, query, rewritten_queries, config
  ) values (
    run_id, p_conversation_id, p_message_id, p_query, p_rewritten_queries, p_retrieval_config
  );

  for candidate in select value from jsonb_array_elements(p_candidates)
  loop
    insert into public.retrieval_candidates (
      retrieval_run_id, chunk_id, provider, source_uri, fused_score,
      rerank_score, selected, metadata
    ) values (
      run_id, nullif(candidate->>'chunk_id', '')::uuid, candidate->>'provider',
      nullif(candidate->>'source_uri', ''),
      nullif(candidate->>'fused_score', '')::double precision,
      nullif(candidate->>'rerank_score', '')::double precision,
      true, coalesce(candidate->'metadata', '{}'::jsonb)
    );

    insert into public.citations (
      message_id, retrieval_run_id, chunk_id, provider, source_uri, title,
      quote, page_number, position, verification_status
    ) values (
      p_message_id, run_id, nullif(candidate->>'chunk_id', '')::uuid,
      candidate->>'provider', nullif(candidate->>'source_uri', ''),
      candidate->>'title', candidate->>'quote',
      nullif(candidate->>'page_number', '')::integer,
      (candidate->>'position')::integer, 'pending'
    );
  end loop;

  update public.conversations set updated_at = now() where id = p_conversation_id;
end;
$$;

revoke all on function public.save_rag_turn(uuid, uuid, jsonb, text, text, text[], jsonb, jsonb) from public;
grant execute on function public.save_rag_turn(uuid, uuid, jsonb, text, text, text[], jsonb, jsonb) to authenticated;

commit;
