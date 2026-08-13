begin;

create table public.eval_case_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.eval_runs(id) on delete cascade,
  case_id uuid not null references public.eval_cases(id) on delete cascade,
  output jsonb not null,
  scores jsonb not null default '{}'::jsonb,
  latency_ms integer,
  passed boolean,
  error jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, case_id)
);

alter table public.eval_case_results enable row level security;
grant select on table public.eval_case_results to authenticated;
create policy eval_case_results_select on public.eval_case_results for select
using (exists (
  select 1 from public.eval_runs r join public.eval_datasets d on d.id = r.dataset_id
  where r.id = run_id and rag.is_org_member(d.organization_id)
));

commit;
