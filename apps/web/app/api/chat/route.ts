import {
  beginConversationPersistence,
  ChatRequestSchema,
  streamChat,
  type Evidence,
  type StreamEvent,
} from "@open-rag/core";
import { ZodError } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // 在创建流之前校验请求，这样格式错误会得到明确的 HTTP 400，
  // 而不是已经返回 200 后才在 NDJSON 中混入一个错误事件。
  const parsed = ChatRequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json(
      { code: "INVALID_REQUEST", message: "聊天请求格式不正确", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const authorization = request.headers.get("authorization");
  const accessToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let answer = "";
      const evidence: Evidence[] = [];
      let doneEvent: StreamEvent | undefined;
      try {
        const persistence = await beginConversationPersistence(body, accessToken);
        for await (const event of streamChat(body, {
          accessToken,
          activeContextSummary: persistence?.activeContextSummary,
          onContextSummary: async (summary, sourceTokens) => {
            await persistence?.saveContextSummary(summary, sourceTokens);
          },
        })) {
          if (event.type === "token") answer += event.text;
          if (event.type === "citation") evidence.push(event.evidence);
          // done 代表整个请求已经可靠完成，因此必须等回答与引用落库后再发送。
          if (event.type === "done") {
            doneEvent = event;
            continue;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        await persistence?.saveAssistant(answer, evidence);
        controller.enqueue(encoder.encode(`${JSON.stringify(doneEvent ?? {
          type: "done",
          conversationId: body.conversationId,
        })}\n`));
      } catch (error) {
        const event: StreamEvent = {
          type: "error",
          code: error instanceof ZodError ? "INVALID_REQUEST" : "CHAT_FAILED",
          message: error instanceof Error ? error.message : "Unknown chat error",
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
