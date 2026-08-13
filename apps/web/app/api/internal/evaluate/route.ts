import { ChatRequestSchema, streamChat } from "@open-rag/core";
import { z } from "zod";

const EvaluationInput = z.object({
  conversationId: z.string().uuid().default(() => crypto.randomUUID()),
  messages: ChatRequestSchema.shape.messages,
  knowledgeBaseIds: ChatRequestSchema.shape.knowledgeBaseIds,
  searchMode: ChatRequestSchema.shape.searchMode,
  model: ChatRequestSchema.shape.model,
});

export async function POST(request: Request) {
  const expectedToken = process.env.EVALUATION_WORKER_TOKEN;
  if (!expectedToken || request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
    return Response.json({ code: "FORBIDDEN" }, { status: 403 });
  }
  const parsed = EvaluationInput.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });

  let answer = "";
  const citations: string[] = [];
  const serviceToken = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceToken) return Response.json({ code: "EVALUATION_SERVICE_NOT_CONFIGURED" }, { status: 503 });
  // 评测不创建业务会话，但使用与在线回答完全相同的图和检索配置，防止离线/在线偏差。
  // service role 只在 Worker-token 保护的内部端点使用，用来评测组织知识库；不进入浏览器聊天路径。
  for await (const event of streamChat(parsed.data, { accessToken: serviceToken })) {
    if (event.type === "token") answer += event.text;
    if (event.type === "citation") citations.push(event.evidence.id);
  }
  return Response.json({ answer, citations });
}
