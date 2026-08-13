import { ChatRequestSchema, type ChatRequest, type StreamEvent } from "./types";
import { streamRagGraph, type RunGraphOptions } from "./graph";
import type { ContextAction, ContextSummary, Evidence } from "./types";

export interface StreamChatOptions extends RunGraphOptions {
  onContextSummary?: (summary: ContextSummary, estimatedTokens: number) => Promise<void>;
}

/**
 * 对外统一成事件流。当前图先完整执行再按文本块发送；后续替换成 LangGraph
 * streamEvents 时，前端协议和组件无需改动。
 */
export async function* streamChat(
  unsafeRequest: unknown,
  options: StreamChatOptions = {},
): AsyncGenerator<StreamEvent> {
  const request: ChatRequest = ChatRequestSchema.parse(unsafeRequest);
  yield { type: "status", stage: "context", message: "正在整理上下文" };

  const graphStream = await streamRagGraph(request, options);
  for await (const item of graphStream) {
    const [mode, payload] = item as ["updates" | "custom", unknown];
    if (mode === "custom") {
      const event = payload as StreamEvent;
      if (event.type === "token") yield event;
      continue;
    }
    const update = payload as Record<string, Record<string, unknown>>;
    const context = update.prepare_context;
    if (context) {
      const estimatedTokens = Number(context.estimatedTokens ?? 0);
      yield {
        type: "context",
        action: context.contextAction as ContextAction,
        estimatedTokens,
      } as StreamEvent;
      const summary = context.contextSummary as ContextSummary | undefined;
      if (summary && summary.version > (options.activeContextSummary?.version ?? 0)) {
        await options.onContextSummary?.(summary, Number(context.summarySourceTokens ?? estimatedTokens));
      }
    }
    const merged = update.merge_evidence;
    for (const evidence of (merged?.evidence as Evidence[] | undefined) ?? []) {
      yield { type: "citation", evidence };
    }
  }
  yield { type: "done", conversationId: request.conversationId };
}
