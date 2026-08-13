begin;

-- 一条助手消息和它的全部引用是同一个业务提交。RPC 让二者在一个事务中
-- 落库，并以 message_id 做幂等键，安全承受客户端或网关重试。
create or replace function public.save_assistant_turn(
  p_message_id uuid,
  p_conversation_id uuid,
  p_content jsonb,
  p_model text,
  p_citations jsonb default '[]'::jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  citation jsonb;
  inserted_rows integer;
begin
  insert into public.messages (id, conversation_id, role, content, status, model)
  values (p_message_id, p_conversation_id, 'assistant', p_content, 'complete', p_model)
  on conflict (id) do nothing;
  get diagnostics inserted_rows = row_count;

  -- 已存在说明同一个 turn 已提交；直接返回可防止重复引用。
  if inserted_rows = 0 then
    return;
  end if;

  for citation in select value from jsonb_array_elements(p_citations)
  loop
    insert into public.citations (
      message_id, chunk_id, provider, source_uri, title, quote, page_number, position
    ) values (
      p_message_id,
      nullif(citation->>'chunk_id', '')::uuid,
      citation->>'provider',
      nullif(citation->>'source_uri', ''),
      citation->>'title',
      citation->>'quote',
      nullif(citation->>'page_number', '')::integer,
      (citation->>'position')::integer
    );
  end loop;

  update public.conversations set updated_at = now() where id = p_conversation_id;
end;
$$;

revoke all on function public.save_assistant_turn(uuid, uuid, jsonb, text, jsonb) from public;
grant execute on function public.save_assistant_turn(uuid, uuid, jsonb, text, jsonb) to authenticated;

commit;
