import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

export const runtime = "nodejs";

interface EnqueuedJob {
  document_id?: string;
  job_id?: string;
  queue_message_id?: number;
}

const EnqueueSchema = z.object({
  documentId: z.string().uuid(),
  jobId: z.string().uuid(),
  knowledgeBaseId: z.string().uuid(),
  storagePath: z.string().min(3).max(1_500),
  title: z.string().min(1).max(512),
  mimeType: z.string().max(255).default("application/octet-stream"),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(255),
});

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ code: "AUTH_REQUIRED" }, { status: 401 });
  }
  const parsed = EnqueueSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json({ code: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  }

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return Response.json({ code: "SUPABASE_NOT_CONFIGURED" }, { status: 503 });
  }

  const token = authorization.slice(7);
  // 继续使用用户 JWT 调 RPC：函数会再次检查 knowledge base 编辑权限，
  // API 层绝不持有可绕过 RLS 的 service role。
  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return Response.json({ code: "INVALID_SESSION" }, { status: 401 });
  }

  const body = parsed.data;
  const { data, error } = await supabase.rpc("enqueue_document_ingestion", {
    p_document_id: body.documentId,
    p_job_id: body.jobId,
    p_knowledge_base_id: body.knowledgeBaseId,
    p_storage_path: body.storagePath,
    p_title: body.title,
    p_mime_type: body.mimeType,
    p_content_hash: body.contentHash,
    p_idempotency_key: body.idempotencyKey,
  });
  if (error) {
    // 数据库原始错误可能包含表名和约束名，不直接暴露给页面；服务端日志保留
    // PostgREST code/message，既方便排障，也避免把内部结构交给普通用户。
    console.error("[ingestion] enqueue failed", { code: error.code, message: error.message });
    if (error.code === "42501") {
      return Response.json({ code: "INGESTION_FORBIDDEN", message: "没有该知识库的上传权限。" }, { status: 403 });
    }
    if (error.code === "23505") {
      return Response.json({ code: "DOCUMENT_CONFLICT", message: "文件已存在或正在处理，请刷新任务列表。" }, { status: 409 });
    }
    return Response.json({ code: "ENQUEUE_FAILED", message: "创建索引任务失败，请稍后重试。" }, { status: 500 });
  }
  const job = (Array.isArray(data) ? data[0] : data) as EnqueuedJob | null;
  // 每次页面上传都会生成新 UUID；RPC 返回不同 UUID 说明命中了同一知识库、
  // 同一内容哈希的既有幂等任务，不需要再次向 PGMQ 发送消息。
  const reused = Boolean(job && (
    job.document_id !== body.documentId || job.job_id !== body.jobId
  ));
  return Response.json({ job, reused }, { status: 202 });
}
