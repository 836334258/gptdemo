import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "../config";
import type { ChatRequest, ContextSummary, Evidence } from "../types";
import { rewriteQueries } from "../retrieval/knowledge";

export interface ConversationPersistence {
  activeContextSummary?: ContextSummary;
  saveContextSummary(summary: ContextSummary, sourceTokens: number): Promise<void>;
  saveAssistant(answer: string, evidence: Evidence[]): Promise<void>;
}

/**
 * 用用户 JWT 创建 PostgREST 客户端，所有 insert/select 都经过 RLS。
 * 这里绝不能使用 service role，否则聊天 API 会绕过租户权限边界。
 */
export async function beginConversationPersistence(
  request: ChatRequest,
  accessToken?: string,
): Promise<ConversationPersistence | undefined> {
  const config = getConfig();
  if (!accessToken || !config.SUPABASE_URL || !config.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    if (config.REQUIRE_AUTH) throw new Error("AUTH_REQUIRED");
    return undefined;
  }

  const client = createClient(config.SUPABASE_URL, config.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await client.auth.getUser(accessToken);
  if (userError || !userData.user) throw new Error("INVALID_SESSION");

  const latestUserMessage = [...request.messages].reverse().find((item) => item.role === "user");
  if (!latestUserMessage) throw new Error("USER_MESSAGE_REQUIRED");

  const { error: conversationError } = await client.from("conversations").upsert({
    id: request.conversationId,
    user_id: userData.user.id,
    // 仅首次插入时使用首条问题生成标题；ignoreDuplicates 保证后续轮次
    // 不会把用户手工修改过的标题覆盖掉。
    title: latestUserMessage.content.trim().replace(/\s+/g, " ").slice(0, 60) || "新对话",
    model: request.model,
    search_mode: request.searchMode,
  }, { onConflict: "id", ignoreDuplicates: true });
  if (conversationError) throw new Error(`CONVERSATION_WRITE_FAILED: ${conversationError.message}`);

  // 消息 ID 由前端生成并贯穿请求、trace 和持久化，重试同一请求不会产生副本。
  const { error: messageError } = await client.from("messages").upsert({
    id: latestUserMessage.id,
    conversation_id: request.conversationId,
    role: "user",
    content: [{ type: "text", text: latestUserMessage.content }],
    status: "complete",
  }, { onConflict: "id", ignoreDuplicates: true });
  if (messageError) throw new Error(`MESSAGE_WRITE_FAILED: ${messageError.message}`);

  const { data: activeRow, error: summaryReadError } = await client
    .from("context_summary_versions")
    .select("summary")
    .eq("conversation_id", request.conversationId)
    .eq("status", "active")
    .maybeSingle();
  if (summaryReadError) throw new Error(`SUMMARY_READ_FAILED: ${summaryReadError.message}`);
  const activeContextSummary = activeRow?.summary as ContextSummary | undefined;

  return {
    activeContextSummary,
    async saveContextSummary(summary, sourceTokens) {
      // 结构化摘要的近似 token 必须小于源上下文；数据库 RPC 会再次校验。
      const summaryTokens = Math.max(1, Math.ceil(JSON.stringify(summary).length / 4));
      const { error } = await client.rpc("activate_context_summary", {
        p_conversation_id: request.conversationId,
        p_summary: summary,
        p_source_message_ids: summary.sourceMessageIds,
        p_from_message_id: summary.fromMessageId,
        p_to_message_id: summary.toMessageId,
        p_model: getConfig().CONTEXT_COMPRESSION_MODEL,
        p_prompt_version: "context-summary-v1",
        p_source_tokens: sourceTokens,
        p_summary_tokens: summaryTokens,
      });
      if (error) throw new Error(`SUMMARY_WRITE_FAILED: ${error.message}`);
    },
    async saveAssistant(answer, evidence) {
      await saveAssistantTurn(client, request, answer, evidence);
    },
  };
}

async function saveAssistantTurn(
  client: SupabaseClient,
  request: ChatRequest,
  answer: string,
  evidence: Evidence[],
) {
  const assistantId = request.assistantMessageId ?? crypto.randomUUID();
  const citations = evidence.map((item, position) => ({
    chunk_id: item.chunkId,
    provider: item.provider,
    source_uri: item.url ?? "",
    title: item.title,
    quote: item.content.slice(0, 1_000),
    page_number: item.pageNumber?.toString() ?? "",
    position,
  }));
  const latestQuery = [...request.messages].reverse().find((item) => item.role === "user")?.content ?? "";
  const { error } = await client.rpc("save_rag_turn", {
    p_message_id: assistantId,
    p_conversation_id: request.conversationId,
    p_content: [{ type: "text", text: answer }],
    p_model: request.model,
    p_query: latestQuery,
    p_rewritten_queries: rewriteQueries(latestQuery),
    p_retrieval_config: {
      searchMode: request.searchMode,
      knowledgeBaseIds: request.knowledgeBaseIds,
      candidateCount: evidence.length,
    },
    p_candidates: citations.map((citation, position) => ({
      ...citation,
      title: evidence[position]?.title ?? "",
      fused_score: evidence[position]?.score?.toString() ?? "",
      rerank_score: evidence[position]?.score?.toString() ?? "",
      metadata: evidence[position]?.metadata ?? {},
    })),
  });
  if (error) throw new Error(`ASSISTANT_WRITE_FAILED: ${error.message}`);
}
