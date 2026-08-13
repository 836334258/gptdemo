import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

export const runtime = "nodejs";

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
    return Response.json({ code: "ENQUEUE_FAILED", message: error.message }, { status: 403 });
  }
  return Response.json({ job: Array.isArray(data) ? data[0] : data }, { status: 202 });
}
