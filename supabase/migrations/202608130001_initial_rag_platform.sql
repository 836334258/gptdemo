begin;

create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pgmq;
create extension if not exists pg_cron;
create schema if not exists rag;

create type public.member_role as enum ('owner', 'admin', 'editor', 'viewer');
create type public.source_status as enum ('draft', 'syncing', 'ready', 'failed', 'paused', 'deleting');
create type public.document_status as enum ('pending', 'processing', 'active', 'failed', 'deleted');
create type public.job_status as enum ('queued', 'running', 'retrying', 'succeeded', 'failed', 'dead_letter');
create type public.summary_status as enum ('candidate', 'active', 'rejected', 'superseded');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  description text,
  embedding_model text not null default 'BAAI/bge-m3',
  embedding_dimensions integer not null default 1024 check (embedding_dimensions = 1024),
  retrieval_config jsonb not null default '{"semanticWeight": 1, "keywordWeight": 1, "rerankTopK": 12}'::jsonb,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.knowledge_base_acl (
  knowledge_base_id uuid not null references public.knowledge_bases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (knowledge_base_id, user_id)
);

create table public.data_sources (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references public.knowledge_bases(id) on delete cascade,
  source_type text not null check (source_type in ('upload', 'url', 'website', 'sitemap', 'rss', 'git', 's3', 'webdav', 'api', 'google_drive', 'notion')),
  name text not null,
  status public.source_status not null default 'draft',
  config jsonb not null default '{}'::jsonb,
  sync_cursor jsonb,
  sync_interval interval,
  next_sync_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.source_sync_runs (
  id uuid primary key default gen_random_uuid(),
  data_source_id uuid not null references public.data_sources(id) on delete cascade,
  status public.job_status not null default 'queued',
  trigger text not null default 'manual',
  discovered_count integer not null default 0,
  processed_count integer not null default 0,
  failed_count integer not null default 0,
  cursor_before jsonb,
  cursor_after jsonb,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references public.knowledge_bases(id) on delete cascade,
  data_source_id uuid references public.data_sources(id) on delete set null,
  external_id text,
  canonical_uri text,
  title text not null,
  mime_type text,
  language text,
  status public.document_status not null default 'pending',
  active_version_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (data_source_id, external_id)
);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version integer not null check (version > 0),
  content_hash text not null,
  storage_path text,
  raw_size_bytes bigint,
  parser_name text not null,
  parser_version text,
  status public.document_status not null default 'processing',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (document_id, version),
  unique (document_id, content_hash)
);

alter table public.documents
  add constraint documents_active_version_fk
  foreign key (active_version_id) references public.document_versions(id) on delete set null;

create table public.document_pages (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  page_number integer not null check (page_number > 0),
  content text not null default '',
  layout jsonb,
  image_path text,
  created_at timestamptz not null default now(),
  unique (document_version_id, page_number)
);

create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references public.knowledge_bases(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  page_id uuid references public.document_pages(id) on delete set null,
  parent_chunk_id uuid references public.chunks(id) on delete set null,
  ordinal integer not null check (ordinal >= 0),
  page_number integer,
  content text not null,
  content_hash text not null,
  token_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1024),
  fts tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (document_version_id, ordinal)
);

create index chunks_embedding_hnsw_idx on public.chunks using hnsw (embedding vector_cosine_ops) where is_active;
create index chunks_fts_idx on public.chunks using gin (fts) where is_active;
create index chunks_kb_active_idx on public.chunks (knowledge_base_id, is_active);
create index chunks_document_version_idx on public.chunks (document_id, document_version_id);

create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  data_source_id uuid references public.data_sources(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  queue_message_id bigint,
  idempotency_key text not null unique,
  status public.job_status not null default 'queued',
  stage text not null default 'queued',
  attempt integer not null default 0,
  max_attempts integer not null default 5,
  progress jsonb not null default '{}'::jsonb,
  error jsonb,
  available_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '新对话',
  model text not null default 'chat-default',
  search_mode text not null default 'auto' check (search_mode in ('off', 'auto', 'firecrawl', 'google', 'both')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  parent_message_id uuid references public.messages(id) on delete set null,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content jsonb not null,
  status text not null default 'complete' check (status in ('pending', 'streaming', 'complete', 'failed', 'cancelled')),
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  latency_ms integer,
  error jsonb,
  created_at timestamptz not null default now()
);

create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

create table public.context_summary_versions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  version integer not null,
  status public.summary_status not null default 'candidate',
  from_message_id uuid not null references public.messages(id),
  to_message_id uuid not null references public.messages(id),
  summary jsonb not null,
  source_message_ids uuid[] not null,
  model text not null,
  prompt_version text not null,
  source_tokens integer not null,
  summary_tokens integer not null,
  checksum text not null,
  validation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (conversation_id, version)
);

create unique index one_active_summary_per_conversation
  on public.context_summary_versions (conversation_id)
  where status = 'active';

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  kind text not null,
  storage_path text,
  content_hash text not null,
  byte_size bigint not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.tool_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  tool_name text not null,
  provider text,
  input jsonb not null,
  output_artifact_id uuid references public.artifacts(id) on delete set null,
  status public.job_status not null default 'running',
  latency_ms integer,
  error jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table public.retrieval_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  query text not null,
  rewritten_queries text[] not null default '{}',
  filters jsonb not null default '{}'::jsonb,
  config jsonb not null default '{}'::jsonb,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create table public.retrieval_candidates (
  retrieval_run_id uuid not null references public.retrieval_runs(id) on delete cascade,
  chunk_id uuid references public.chunks(id) on delete set null,
  provider text not null,
  source_uri text,
  semantic_rank integer,
  keyword_rank integer,
  fused_score double precision,
  rerank_score double precision,
  selected boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  primary key (retrieval_run_id, provider, source_uri, chunk_id)
);

create table public.citations (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  retrieval_run_id uuid references public.retrieval_runs(id) on delete set null,
  chunk_id uuid references public.chunks(id) on delete set null,
  provider text not null,
  source_uri text,
  title text not null,
  quote text,
  claim_text text,
  page_number integer,
  position integer not null,
  verification_status text not null default 'pending' check (verification_status in ('pending', 'supported', 'partial', 'unsupported')),
  verification_score double precision,
  created_at timestamptz not null default now()
);

create table public.model_catalog (
  alias text primary key,
  provider text not null,
  upstream_model text not null,
  enabled boolean not null default true,
  capabilities jsonb not null default '{}'::jsonb,
  limits jsonb not null default '{}'::jsonb,
  routing jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.model_catalog (alias, provider, upstream_model, capabilities) values
  ('chat-default', 'gemini', 'gemini-3.6-flash', '{"tools":true,"structuredOutput":true,"vision":true,"searchGrounding":true}'),
  ('context-compressor', 'gemini', 'gemini-3.6-flash', '{"structuredOutput":true}');

create table public.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version integer not null,
  content text not null,
  variables jsonb not null default '[]'::jsonb,
  checksum text not null,
  active boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (name, version)
);

create unique index one_active_prompt_per_name on public.prompt_versions (name) where active;

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint check (rating in (-1, 1)),
  category text,
  comment text,
  created_at timestamptz not null default now(),
  unique (message_id, user_id)
);

create table public.eval_datasets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.eval_cases (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.eval_datasets(id) on delete cascade,
  input jsonb not null,
  expected jsonb,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.eval_datasets(id) on delete cascade,
  config jsonb not null,
  status public.job_status not null default 'queued',
  metrics jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  ip inet,
  user_agent text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create or replace function rag.is_org_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = target_organization_id and m.user_id = auth.uid()
  );
$$;

create or replace function rag.can_read_knowledge_base(target_knowledge_base_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.knowledge_bases kb
    where kb.id = target_knowledge_base_id
      and (
        exists (select 1 from public.organization_members m where m.organization_id = kb.organization_id and m.user_id = auth.uid())
        or exists (select 1 from public.knowledge_base_acl a where a.knowledge_base_id = kb.id and a.user_id = auth.uid())
      )
  );
$$;

create or replace function public.search_chunks_hybrid(
  query_text text,
  query_embedding vector(1024),
  kb_ids uuid[],
  match_count integer default 20
)
returns table (
  chunk_id uuid,
  document_id uuid,
  title text,
  content text,
  page_number integer,
  score double precision,
  metadata jsonb
)
language sql
stable
security invoker
-- pgvector may be installed in Supabase's `extensions` schema. Keeping only
-- these two trusted schemas exposes the vector operator without accepting a
-- caller-controlled search path.
set search_path = public, extensions
as $$
  with semantic as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.chunks c
    where c.is_active
      and c.embedding is not null
      and c.knowledge_base_id = any(kb_ids)
    order by c.embedding <=> query_embedding
    limit greatest(match_count * 4, 40)
  ),
  keyword as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, websearch_to_tsquery('simple', query_text)) desc) as rank
    from public.chunks c
    where c.is_active
      and c.knowledge_base_id = any(kb_ids)
      and c.fts @@ websearch_to_tsquery('simple', query_text)
    order by ts_rank_cd(c.fts, websearch_to_tsquery('simple', query_text)) desc
    limit greatest(match_count * 4, 40)
  ),
  fused as (
    select coalesce(s.id, k.id) as id,
      coalesce(1.0 / (60 + s.rank), 0.0) + coalesce(1.0 / (60 + k.rank), 0.0) as score
    from semantic s full outer join keyword k on s.id = k.id
  )
  select c.id, c.document_id, d.title, c.content, c.page_number, f.score, c.metadata
  from fused f
  join public.chunks c on c.id = f.id
  join public.documents d on d.id = c.document_id
  where rag.can_read_knowledge_base(c.knowledge_base_id)
  order by f.score desc
  limit match_count;
$$;

grant execute on function public.search_chunks_hybrid(text, vector, uuid[], integer) to authenticated;

-- updated_at 统一由数据库维护，避免不同 Worker/前端忘记更新时间。
create or replace function rag.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_touch before update on public.organizations for each row execute function rag.touch_updated_at();
create trigger knowledge_bases_touch before update on public.knowledge_bases for each row execute function rag.touch_updated_at();
create trigger data_sources_touch before update on public.data_sources for each row execute function rag.touch_updated_at();
create trigger documents_touch before update on public.documents for each row execute function rag.touch_updated_at();
create trigger conversations_touch before update on public.conversations for each row execute function rag.touch_updated_at();
create trigger ingestion_jobs_touch before update on public.ingestion_jobs for each row execute function rag.touch_updated_at();

-- Durable queues are not exposed to the browser. API only writes job rows and a
-- trusted server function/worker publishes queue messages.
select pgmq.create('rag_ingestion');
select pgmq.create('rag_deletion');
select pgmq.create('rag_evaluation');

-- RLS is enabled on every tenant-bearing business table. Worker operations use
-- service_role; interactive retrieval always uses the authenticated user JWT.
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.knowledge_bases enable row level security;
alter table public.knowledge_base_acl enable row level security;
alter table public.data_sources enable row level security;
alter table public.source_sync_runs enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_pages enable row level security;
alter table public.chunks enable row level security;
alter table public.ingestion_jobs enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.context_summary_versions enable row level security;
alter table public.artifacts enable row level security;
alter table public.tool_runs enable row level security;
alter table public.retrieval_runs enable row level security;
alter table public.retrieval_candidates enable row level security;
alter table public.citations enable row level security;
alter table public.feedback enable row level security;
alter table public.eval_datasets enable row level security;
alter table public.eval_cases enable row level security;
alter table public.eval_runs enable row level security;
alter table public.audit_logs enable row level security;

create policy organizations_select on public.organizations for select using (rag.is_org_member(id));
create policy organizations_insert on public.organizations for insert with check (created_by = auth.uid());
create policy organization_members_select on public.organization_members for select using (rag.is_org_member(organization_id));
create policy knowledge_bases_select on public.knowledge_bases for select using (rag.can_read_knowledge_base(id));
create policy data_sources_select on public.data_sources for select using (rag.can_read_knowledge_base(knowledge_base_id));
create policy documents_select on public.documents for select using (rag.can_read_knowledge_base(knowledge_base_id));
create policy document_versions_select on public.document_versions for select using (
  exists (select 1 from public.documents d where d.id = document_id and rag.can_read_knowledge_base(d.knowledge_base_id))
);
create policy document_pages_select on public.document_pages for select using (
  exists (
    select 1 from public.document_versions v join public.documents d on d.id = v.document_id
    where v.id = document_version_id and rag.can_read_knowledge_base(d.knowledge_base_id)
  )
);
create policy chunks_select on public.chunks for select using (rag.can_read_knowledge_base(knowledge_base_id));
create policy conversations_all on public.conversations for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy messages_all on public.messages for all using (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())
) with check (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())
);
create policy summaries_all on public.context_summary_versions for all using (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())
) with check (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())
);
create policy feedback_all on public.feedback for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy eval_datasets_select on public.eval_datasets for select using (rag.is_org_member(organization_id));

-- The private bucket stores originals, parsed artifacts, previews and large tool outputs.
insert into storage.buckets (id, name, public, file_size_limit)
values ('rag-private', 'rag-private', false, 104857600)
on conflict (id) do nothing;

commit;
