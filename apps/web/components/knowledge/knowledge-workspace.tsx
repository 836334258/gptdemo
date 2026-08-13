"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, Database, FileUp, RefreshCw, Trash2 } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

interface Organization { id: string; name: string }
interface KnowledgeBase { id: string; organization_id: string; name: string; description?: string }
interface IngestionJob {
  id: string;
  document_id: string;
  status: string;
  stage: string;
  progress: Record<string, unknown>;
  error?: { message?: string };
  created_at: string;
}
interface DocumentRow { id: string; title: string; status: string; knowledge_base_id: string }

export function KnowledgeWorkspace() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [selectedKnowledgeBase, setSelectedKnowledgeBase] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | undefined>();

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: sessionData } = await supabase.auth.getSession();
    setAuthenticated(Boolean(sessionData.session));
    if (!sessionData.session) return;

    const [orgResult, kbResult, jobResult, documentResult] = await Promise.all([
      supabase.from("organizations").select("id,name").order("created_at"),
      supabase.from("knowledge_bases").select("id,organization_id,name,description").order("created_at"),
      supabase.from("ingestion_jobs").select("id,document_id,status,stage,progress,error,created_at").order("created_at", { ascending: false }).limit(30),
      supabase.from("documents").select("id,title,status,knowledge_base_id").order("created_at", { ascending: false }).limit(100),
    ]);
    const firstError = orgResult.error ?? kbResult.error ?? jobResult.error ?? documentResult.error;
    if (firstError) {
      setNotice(firstError.message);
      return;
    }
    setOrganizations((orgResult.data ?? []) as Organization[]);
    setKnowledgeBases((kbResult.data ?? []) as KnowledgeBase[]);
    setJobs((jobResult.data ?? []) as IngestionJob[]);
    setDocuments((documentResult.data ?? []) as DocumentRow[]);
    setSelectedKnowledgeBase((current) => current || kbResult.data?.[0]?.id || "");
  }, []);

  useEffect(() => {
    void refresh();
    // 处理中任务才需要轮询；完成后 effect 重建并停止定时器，避免空闲页面持续请求。
    if (!jobs.some((job) => ["queued", "running", "retrying"].includes(job.status))) return;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [jobs, refresh]);

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "").trim();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return setNotice("请先登录");
    setBusy(true);
    const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "workspace";
    const { error } = await supabase.from("organizations").insert({
      name,
      slug: `${slugBase}-${crypto.randomUUID().slice(0, 8)}`,
      created_by: userData.user.id,
    });
    setBusy(false);
    setNotice(error ? error.message : "组织已创建，现在可以建立知识库。");
    if (!error) {
      formElement.reset();
      await refresh();
    }
  }

  async function createKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const form = new FormData(formElement);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return setNotice("请先登录");
    setBusy(true);
    const { error } = await supabase.from("knowledge_bases").insert({
      organization_id: String(form.get("organizationId")),
      name: String(form.get("name")).trim(),
      description: String(form.get("description") ?? "").trim() || null,
      created_by: userData.user.id,
    });
    setBusy(false);
    setNotice(error ? error.message : "知识库已创建。");
    if (!error) {
      formElement.reset();
      await refresh();
    }
  }

  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const supabase = getSupabaseBrowserClient();
    const form = new FormData(formElement);
    const file = form.get("file");
    const kb = knowledgeBases.find((item) => item.id === selectedKnowledgeBase);
    if (!supabase || !(file instanceof File) || !kb) return;
    if (file.size > 100 * 1024 * 1024) return setNotice("单个文件不能超过 100 MB");

    setBusy(true);
    setNotice("正在计算内容指纹并上传…");
    const hash = await sha256(file);
    const extension = safeExtension(file.name);
    // 对象名由内容哈希决定，浏览器重试不会产生重复文件；组织 ID 放首段供 RLS 校验。
    const storagePath = `${kb.organization_id}/${kb.id}/${hash}${extension}`;
    const upload = await supabase.storage.from("rag-private").upload(storagePath, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    const alreadyExists = upload.error?.message.toLowerCase().includes("duplicate") ?? false;
    if (upload.error && !alreadyExists) {
      setBusy(false);
      return setNotice(upload.error.message);
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const response = await fetch("/api/ingestion/enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionData.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({
        documentId: crypto.randomUUID(),
        jobId: crypto.randomUUID(),
        knowledgeBaseId: kb.id,
        storagePath,
        title: file.name,
        mimeType: file.type || "application/octet-stream",
        contentHash: hash,
        idempotencyKey: `${kb.id}:${hash}`,
      }),
    });
    const result = await response.json() as { code?: string; message?: string };
    if (!response.ok && !alreadyExists) {
      // 入队事务失败时回收本次新上传的对象；已有对象不能删除，因为旧任务可能仍引用它。
      await supabase.storage.from("rag-private").remove([storagePath]);
    }
    setBusy(false);
    setNotice(response.ok ? "文件已进入解析队列。" : result.message ?? result.code ?? "入队失败");
    if (response.ok) {
      formElement.reset();
      await refresh();
    }
  }

  async function deleteDocument(documentId: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !window.confirm("确认删除这个文档及其全部索引版本？")) return;
    setBusy(true);
    // RPC 先软删除并让 chunk 立即退出检索，再由 deletion worker 清理对象和版本。
    const { error } = await supabase.rpc("enqueue_document_deletion", { p_document_id: documentId });
    setBusy(false);
    setNotice(error ? error.message : "文档已退出检索，后台正在清理原件和索引。");
    if (!error) await refresh();
  }

  async function retryJob(job: IngestionJob) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    // dead-letter 消息已经归档，必须由事务 RPC 重建队列消息，不能只修改状态。
    const { error } = await supabase.rpc("retry_ingestion_job", { p_job_id: job.id });
    setNotice(error ? error.message : "任务已重新进入等待队列。");
    if (!error) await refresh();
  }

  const activeJobs = useMemo(() => jobs.filter((job) => ["queued", "running", "retrying"].includes(job.status)).length, [jobs]);

  if (authenticated === false) {
    return <main className="knowledge-page"><div className="empty-card">请先 <Link href="/login">登录</Link> 后管理知识库。</div></main>;
  }

  return (
    <main className="knowledge-page">
      <header className="knowledge-header">
        <div><Link href="/" aria-label="返回聊天"><ArrowLeft /></Link><div><h1>知识库</h1><p>上传、解析、切分、向量化和版本激活都可追踪。</p></div></div>
        <button type="button" onClick={() => void refresh()}><RefreshCw />刷新</button>
      </header>

      {notice && <div className="notice" role="status">{notice}</div>}
      <section className="knowledge-grid">
        <form className="management-card" onSubmit={createOrganization}>
          <Database /><h2>1. 创建组织</h2>
          <label>组织名称<input name="name" required maxLength={120} placeholder="研发团队" /></label>
          <button disabled={busy}>创建组织</button>
        </form>
        <form className="management-card" onSubmit={createKnowledgeBase}>
          <Database /><h2>2. 创建知识库</h2>
          <label>所属组织<select name="organizationId" required>{organizations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>知识库名称<input name="name" required maxLength={160} placeholder="产品文档" /></label>
          <label>说明<input name="description" placeholder="可选" /></label>
          <button disabled={busy || organizations.length === 0}>创建知识库</button>
        </form>
        <form className="management-card" onSubmit={uploadDocument}>
          <FileUp /><h2>3. 上传并索引</h2>
          <label>目标知识库<select value={selectedKnowledgeBase} onChange={(event) => setSelectedKnowledgeBase(event.target.value)} required>{knowledgeBases.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>文件<input name="file" type="file" required /></label>
          <button disabled={busy || knowledgeBases.length === 0}>上传文件</button>
        </form>
      </section>

      <section className="jobs-card">
        <div><h2>索引任务</h2><span>{activeJobs} 个处理中</span></div>
        {jobs.length === 0 ? <p className="muted">还没有任务。</p> : jobs.map((job) => (
          <article key={job.id}>
            <div><strong>{documents.find((item) => item.id === job.document_id)?.title ?? job.document_id}</strong><small>{new Date(job.created_at).toLocaleString()}</small></div>
            <span className={`job-status status-${job.status}`}>{job.status} · {job.stage}</span>
            {job.error?.message && <p>{job.error.message}</p>}
            {["failed", "dead_letter"].includes(job.status) && <button type="button" className="row-action" onClick={() => void retryJob(job)}>重试</button>}
          </article>
        ))}
      </section>

      <section className="jobs-card">
        <div><h2>文档</h2><span>{documents.filter((item) => item.status !== "deleted").length} 个可见</span></div>
        {documents.filter((item) => item.status !== "deleted").map((document) => (
          <article key={document.id}>
            <div><strong>{document.title}</strong><small>{document.status}</small></div>
            <button type="button" className="row-action danger" disabled={busy} onClick={() => void deleteDocument(document.id)}><Trash2 />删除</button>
          </article>
        ))}
      </section>
    </main>
  );
}

async function sha256(file: File) {
  const bytes = await file.arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeExtension(name: string) {
  const match = name.toLowerCase().match(/\.[a-z0-9]{1,10}$/);
  return match?.[0] ?? ".bin";
}
