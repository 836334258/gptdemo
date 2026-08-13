begin;

-- 权限判断统一封装在 SECURITY DEFINER 函数中，既避免 policy 递归，
-- 也确保所有入口对 owner/admin/editor 的含义完全一致。
create or replace function rag.has_org_role(target_organization_id uuid, allowed_roles public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
      and m.role = any(allowed_roles)
  );
$$;

create or replace function rag.can_edit_knowledge_base(target_knowledge_base_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.knowledge_bases kb
    where kb.id = target_knowledge_base_id
      and (
        rag.has_org_role(kb.organization_id, array['owner', 'admin', 'editor']::public.member_role[])
        or exists (
          select 1 from public.knowledge_base_acl a
          where a.knowledge_base_id = kb.id
            and a.user_id = auth.uid()
            and a.role = any(array['owner', 'admin', 'editor']::public.member_role[])
        )
      )
  );
$$;

-- 创建组织和写入首个 owner 必须是一个原子事务；否则创建者会立即被 RLS
-- 挡在自己刚创建的组织之外。
create or replace function rag.add_organization_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_members (organization_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger organizations_add_owner
after insert on public.organizations
for each row execute function rag.add_organization_owner();

create policy organizations_update on public.organizations for update
using (rag.has_org_role(id, array['owner', 'admin']::public.member_role[]))
with check (rag.has_org_role(id, array['owner', 'admin']::public.member_role[]));
create policy organizations_delete on public.organizations for delete
using (rag.has_org_role(id, array['owner']::public.member_role[]));

-- 成员与知识库 ACL 涉及提权，第一版只允许 owner 修改；普通 admin/editor
-- 仍可管理内容，但不能给自己或他人授予更高角色。
create policy organization_members_insert on public.organization_members for insert
with check (rag.has_org_role(organization_id, array['owner']::public.member_role[]));
create policy organization_members_update on public.organization_members for update
using (rag.has_org_role(organization_id, array['owner']::public.member_role[]))
with check (rag.has_org_role(organization_id, array['owner']::public.member_role[]));
create policy organization_members_delete on public.organization_members for delete
using (rag.has_org_role(organization_id, array['owner']::public.member_role[]));

create policy knowledge_bases_insert on public.knowledge_bases for insert
with check (
  created_by = auth.uid()
  and rag.has_org_role(organization_id, array['owner', 'admin', 'editor']::public.member_role[])
);
create policy knowledge_bases_update on public.knowledge_bases for update
using (rag.can_edit_knowledge_base(id)) with check (rag.can_edit_knowledge_base(id));
create policy knowledge_bases_delete on public.knowledge_bases for delete
using (rag.can_edit_knowledge_base(id));

create policy knowledge_base_acl_select on public.knowledge_base_acl for select
using (rag.can_read_knowledge_base(knowledge_base_id));
create policy knowledge_base_acl_insert on public.knowledge_base_acl for insert
with check (exists (
  select 1 from public.knowledge_bases kb where kb.id = knowledge_base_id
    and rag.has_org_role(kb.organization_id, array['owner']::public.member_role[])
));
create policy knowledge_base_acl_update on public.knowledge_base_acl for update
using (exists (
  select 1 from public.knowledge_bases kb where kb.id = knowledge_base_id
    and rag.has_org_role(kb.organization_id, array['owner']::public.member_role[])
));
create policy knowledge_base_acl_delete on public.knowledge_base_acl for delete
using (exists (
  select 1 from public.knowledge_bases kb where kb.id = knowledge_base_id
    and rag.has_org_role(kb.organization_id, array['owner']::public.member_role[])
));

create policy data_sources_insert on public.data_sources for insert
with check (created_by = auth.uid() and rag.can_edit_knowledge_base(knowledge_base_id));
create policy data_sources_update on public.data_sources for update
using (rag.can_edit_knowledge_base(knowledge_base_id))
with check (rag.can_edit_knowledge_base(knowledge_base_id));
create policy data_sources_delete on public.data_sources for delete
using (rag.can_edit_knowledge_base(knowledge_base_id));

create policy source_sync_runs_select on public.source_sync_runs for select
using (exists (
  select 1 from public.data_sources ds
  where ds.id = data_source_id and rag.can_read_knowledge_base(ds.knowledge_base_id)
));
create policy documents_insert on public.documents for insert
with check (rag.can_edit_knowledge_base(knowledge_base_id));
create policy documents_update on public.documents for update
using (rag.can_edit_knowledge_base(knowledge_base_id))
with check (rag.can_edit_knowledge_base(knowledge_base_id));
create policy documents_delete on public.documents for delete
using (rag.can_edit_knowledge_base(knowledge_base_id));

create policy ingestion_jobs_select on public.ingestion_jobs for select
using (rag.is_org_member(organization_id));

create policy artifacts_all on public.artifacts for all
using (
  (conversation_id is not null and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
  ))
  or (organization_id is not null and rag.is_org_member(organization_id))
)
with check (
  (conversation_id is not null and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
  ))
  or (organization_id is not null and rag.has_org_role(
    organization_id, array['owner', 'admin', 'editor']::public.member_role[]
  ))
);

create policy tool_runs_all on public.tool_runs for all
using (exists (
  select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
)) with check (exists (
  select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
));
create policy retrieval_runs_all on public.retrieval_runs for all
using (conversation_id is null or exists (
  select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
)) with check (conversation_id is null or exists (
  select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
));
create policy retrieval_candidates_all on public.retrieval_candidates for all
using (exists (
  select 1 from public.retrieval_runs r
  join public.conversations c on c.id = r.conversation_id
  where r.id = retrieval_run_id and c.user_id = auth.uid()
)) with check (exists (
  select 1 from public.retrieval_runs r
  join public.conversations c on c.id = r.conversation_id
  where r.id = retrieval_run_id and c.user_id = auth.uid()
));
create policy citations_all on public.citations for all
using (exists (
  select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
  where m.id = message_id and c.user_id = auth.uid()
)) with check (exists (
  select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
  where m.id = message_id and c.user_id = auth.uid()
));

alter table public.model_catalog enable row level security;
alter table public.prompt_versions enable row level security;
create policy model_catalog_select on public.model_catalog for select to authenticated using (enabled);
create policy prompt_versions_select on public.prompt_versions for select to authenticated using (active);

create policy eval_datasets_insert on public.eval_datasets for insert
with check (created_by = auth.uid() and rag.has_org_role(
  organization_id, array['owner', 'admin', 'editor']::public.member_role[]
));
create policy eval_datasets_update on public.eval_datasets for update
using (rag.has_org_role(organization_id, array['owner', 'admin', 'editor']::public.member_role[]))
with check (rag.has_org_role(organization_id, array['owner', 'admin', 'editor']::public.member_role[]));
create policy eval_datasets_delete on public.eval_datasets for delete
using (rag.has_org_role(organization_id, array['owner', 'admin']::public.member_role[]));
create policy eval_cases_select on public.eval_cases for select
using (exists (
  select 1 from public.eval_datasets d where d.id = dataset_id and rag.is_org_member(d.organization_id)
));
create policy eval_runs_select on public.eval_runs for select
using (exists (
  select 1 from public.eval_datasets d where d.id = dataset_id and rag.is_org_member(d.organization_id)
));
create policy audit_logs_select on public.audit_logs for select
using (organization_id is not null and rag.has_org_role(
  organization_id, array['owner', 'admin']::public.member_role[]
));

-- 私有对象统一使用 organization_id 作为路径第一段；浏览器只能访问自己
-- 所在组织，写入还要求 editor 以上权限。
create policy rag_private_objects_select on storage.objects for select
using (
  bucket_id = 'rag-private'
  and rag.is_org_member(((storage.foldername(name))[1])::uuid)
);
create policy rag_private_objects_insert on storage.objects for insert
with check (
  bucket_id = 'rag-private'
  and rag.has_org_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner', 'admin', 'editor']::public.member_role[]
  )
);
create policy rag_private_objects_update on storage.objects for update
using (
  bucket_id = 'rag-private'
  and rag.has_org_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner', 'admin', 'editor']::public.member_role[]
  )
);
create policy rag_private_objects_delete on storage.objects for delete
using (
  bucket_id = 'rag-private'
  and rag.has_org_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner', 'admin', 'editor']::public.member_role[]
  )
);

commit;
