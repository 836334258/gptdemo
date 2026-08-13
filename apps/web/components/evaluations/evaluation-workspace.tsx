"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Play } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

interface Organization { id: string; name: string }
interface Dataset { id: string; name: string; organization_id: string }
interface Run { id: string; dataset_id: string; status: string; metrics?: Record<string, unknown>; created_at: string }

export function EvaluationWorkspace() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [orgs, sets, runRows] = await Promise.all([
      supabase.from("organizations").select("id,name").order("name"),
      supabase.from("eval_datasets").select("id,name,organization_id").order("created_at", { ascending: false }),
      supabase.from("eval_runs").select("id,dataset_id,status,metrics,created_at").order("created_at", { ascending: false }).limit(50),
    ]);
    if (!orgs.error) setOrganizations((orgs.data ?? []) as Organization[]);
    if (!sets.error) setDatasets((sets.data ?? []) as Dataset[]);
    if (!runRows.error) setRuns((runRows.data ?? []) as Run[]);
  }, []);

  useEffect(() => {
    void refresh();
    if (!runs.some((run) => ["queued", "running"].includes(run.status))) return;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [refresh, runs]);

  async function createDataset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    const { data } = await supabase.auth.getUser();
    if (!data.user) return setNotice("请先登录");
    const { error } = await supabase.from("eval_datasets").insert({
      organization_id: String(form.get("organizationId")),
      name: String(form.get("name")),
      description: String(form.get("description") ?? "") || null,
      created_by: data.user.id,
    });
    setNotice(error?.message ?? "评测集已创建。");
    if (!error) await refresh();
  }

  async function addCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    const question = String(form.get("question"));
    const expectedTerms = String(form.get("expectedTerms") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const { error } = await supabase.from("eval_cases").insert({
      dataset_id: String(form.get("datasetId")),
      input: {
        messages: [{ id: crypto.randomUUID(), role: "user", content: question }],
        knowledgeBaseIds: [],
        searchMode: "off",
        model: "chat-default",
      },
      expected: { contains: expectedTerms },
    });
    setNotice(error?.message ?? "Case 已加入评测集。");
  }

  async function runDataset(datasetId: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const runId = crypto.randomUUID();
    // RPC 把 run 与 PGMQ 消息放在同一事务，Worker 再逐 case 调同一 RAG 图。
    const { error } = await supabase.rpc("enqueue_evaluation_run", {
      p_run_id: runId,
      p_dataset_id: datasetId,
      p_config: { model: "chat-default", searchMode: "off" },
      p_idempotency_key: `${datasetId}:${runId}`,
    });
    setNotice(error?.message ?? "评测运行已入队。");
    if (!error) await refresh();
  }

  return (
    <main className="knowledge-page">
      <header className="knowledge-header">
        <div><Link href="/" aria-label="返回聊天"><ArrowLeft /></Link><div><h1>RAG 评测</h1><p>固定数据集回归回答正确性、延迟与检索配置。</p></div></div>
      </header>
      {notice && <div className="notice">{notice}</div>}
      <section className="knowledge-grid two-columns">
        <form className="management-card" onSubmit={createDataset}>
          <h2>创建评测集</h2>
          <label>组织<select name="organizationId" required>{organizations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>名称<input name="name" required /></label>
          <label>说明<input name="description" /></label>
          <button disabled={!organizations.length}>创建</button>
        </form>
        <form className="management-card" onSubmit={addCase}>
          <h2>添加 Case</h2>
          <label>评测集<select name="datasetId" required>{datasets.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>问题<textarea name="question" required rows={3} /></label>
          <label>答案必须包含（逗号分隔）<input name="expectedTerms" /></label>
          <button disabled={!datasets.length}>添加</button>
        </form>
      </section>
      <section className="jobs-card">
        <div><h2>评测集</h2><span>{datasets.length} 个</span></div>
        {datasets.map((dataset) => (
          <article key={dataset.id}>
            <div><strong>{dataset.name}</strong><small>{dataset.id}</small></div>
            <button type="button" className="row-action" onClick={() => void runDataset(dataset.id)}><Play />运行</button>
          </article>
        ))}
      </section>
      <section className="jobs-card">
        <div><h2>运行记录</h2><span>{runs.length} 次</span></div>
        {runs.map((run) => (
          <article key={run.id}>
            <div><strong>{datasets.find((item) => item.id === run.dataset_id)?.name ?? run.dataset_id}</strong><small>{JSON.stringify(run.metrics ?? {})}</small></div>
            <span className={`job-status status-${run.status}`}>{run.status}</span>
          </article>
        ))}
      </section>
    </main>
  );
}
