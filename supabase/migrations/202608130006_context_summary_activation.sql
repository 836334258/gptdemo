begin;

-- 压缩采用“候选 -> 校验 -> 激活”两阶段语义，但整个切换在单事务中完成。
-- 任一校验失败都会回滚，旧 active summary 继续生效。
create or replace function public.activate_context_summary(
  p_conversation_id uuid,
  p_summary jsonb,
  p_source_message_ids uuid[],
  p_from_message_id uuid,
  p_to_message_id uuid,
  p_model text,
  p_prompt_version text,
  p_source_tokens integer,
  p_summary_tokens integer
)
returns table (summary_id uuid, version integer)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  next_version integer;
  candidate_id uuid;
  checksum_value text;
  covered_count integer;
begin
  -- 行锁串行化同一会话的并发压缩，避免两个 active 版本竞态。
  perform 1 from public.conversations c
  where c.id = p_conversation_id and c.user_id = auth.uid()
  for update;
  if not found then raise exception 'conversation write denied' using errcode = '42501'; end if;

  if cardinality(p_source_message_ids) < 2 then
    raise exception 'summary must cover at least two messages' using errcode = '22023';
  end if;
  select count(*) into covered_count from public.messages m
  where m.conversation_id = p_conversation_id and m.id = any(p_source_message_ids);
  if covered_count <> cardinality(p_source_message_ids) then
    raise exception 'summary contains messages outside conversation' using errcode = '22023';
  end if;
  if not (p_from_message_id = any(p_source_message_ids) and p_to_message_id = any(p_source_message_ids)) then
    raise exception 'summary coverage endpoints are invalid' using errcode = '22023';
  end if;
  if p_source_tokens <= 0 or p_summary_tokens <= 0 or p_summary_tokens >= p_source_tokens then
    raise exception 'summary did not reduce context size' using errcode = '22023';
  end if;

  select coalesce(max(s.version), 0) + 1 into next_version
  from public.context_summary_versions s where s.conversation_id = p_conversation_id;
  p_summary := jsonb_set(p_summary, '{version}', to_jsonb(next_version), true);
  checksum_value := encode(digest(convert_to(p_summary::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.context_summary_versions (
    conversation_id, version, status, from_message_id, to_message_id, summary,
    source_message_ids, model, prompt_version, source_tokens, summary_tokens,
    checksum, validation
  ) values (
    p_conversation_id, next_version, 'candidate', p_from_message_id, p_to_message_id,
    p_summary, p_source_message_ids, p_model, p_prompt_version, p_source_tokens,
    p_summary_tokens, checksum_value,
    jsonb_build_object(
      'coverage', true,
      'messageOwnership', true,
      'compressionRatio', round((p_summary_tokens::numeric / p_source_tokens), 4),
      'checksum', checksum_value
    )
  ) returning id into candidate_id;

  update public.context_summary_versions set status = 'superseded'
  where conversation_id = p_conversation_id and status = 'active' and id <> candidate_id;
  update public.context_summary_versions set status = 'active', activated_at = now()
  where id = candidate_id;

  return query select candidate_id, next_version;
end;
$$;

revoke all on function public.activate_context_summary(uuid, jsonb, uuid[], uuid, uuid, text, text, integer, integer) from public;
grant execute on function public.activate_context_summary(uuid, jsonb, uuid[], uuid, uuid, text, text, integer, integer) to authenticated;

commit;
