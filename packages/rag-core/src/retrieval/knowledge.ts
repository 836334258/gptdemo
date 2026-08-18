import { createClient } from "@supabase/supabase-js";
import { getConfig } from "../config";
import type { Evidence } from "../types";

interface HybridRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  page_number: number | null;
  score: number;
  metadata: Record<string, unknown> | null;
}

export async function retrieveKnowledge(
  query: string,
  knowledgeBaseIds: string[],
  accessToken?: string,
): Promise<Evidence[]> {
  const config = getConfig();
  if (!config.SUPABASE_URL || !config.NEXT_PUBLIC_SUPABASE_ANON_KEY || knowledgeBaseIds.length === 0) {
    return [];
  }

  // 刻意使用 anon key + 用户 JWT，而不是 service role；这样向量 RPC 仍受 RLS 限制。
  const supabase = createClient(config.SUPABASE_URL, config.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const queries = rewriteQueries(query);
  const vectors = await createEmbeddings(queries);
  if (vectors.length !== queries.length) return [];
  const candidateGroups = await Promise.all(queries.map(async (rewritten, queryIndex) => {
    const { data, error } = await supabase.rpc("search_chunks_hybrid", {
      query_text: rewritten,
      query_embedding: vectors[queryIndex],
      kb_ids: knowledgeBaseIds,
      match_count: config.RETRIEVAL_CANDIDATE_LIMIT,
    });
    if (error) throw new Error(`KNOWLEDGE_RETRIEVAL_FAILED: ${error.message}`);
    return (data ?? []) as HybridRow[];
  }));

  // 多查询结果再做一次 RRF，减少单次改写偏离原问题造成的召回损失。
  const fused = reciprocalRankFusion(candidateGroups).slice(0, config.RETRIEVAL_CANDIDATE_LIMIT);
  const reranked = await rerank(query, fused).catch(() => fused);
  return reranked.slice(0, config.RETRIEVAL_RERANK_LIMIT).map((row, index) => ({
    id: `K${index + 1}`,
    provider: "knowledge_base",
    title: row.title,
    content: row.content,
    score: row.score,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    pageNumber: row.page_number ?? undefined,
    retrievedAt: new Date().toISOString(),
    metadata: row.metadata ?? {},
  }));
}

export function rewriteQueries(query: string): string[] {
  const normalized = query.trim().replace(/\s+/g, " ");
  const withoutQuestionWords = normalized
    .replace(/^(请问|请帮我|帮我|我想知道|能否|可以).{0,4}?/u, "")
    .replace(/[？?。.!！]+$/u, "")
    .trim();
  return [...new Set([normalized, withoutQuestionWords])].filter(Boolean).slice(0, 3);
}

export function reciprocalRankFusion(groups: HybridRow[][]): HybridRow[] {
  const fused = new Map<string, HybridRow>();
  for (const group of groups) {
    group.forEach((row, rank) => {
      const previous = fused.get(row.chunk_id);
      const score = (previous?.score ?? 0) + 1 / (60 + rank + 1);
      fused.set(row.chunk_id, { ...(previous ?? row), score });
    });
  }
  return [...fused.values()].sort((left, right) => right.score - left.score);
}

async function createEmbeddings(texts: string[]): Promise<number[][]> {
  const { TEI_EMBEDDING_URL } = getConfig();
  try {
    const response = await fetch(`${TEI_EMBEDDING_URL.replace(/\/$/, "")}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: texts, normalize: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Embedding service returned ${response.status}`);
    }
    return (await response.json()) as number[][];
  } catch (error) {
    // 用户明确选了知识库时，不能把基础设施故障伪装成“无相关文档”，
    // 否则模型会基于空证据给出误导性回答。原始异常保留在 cause 中供服务端日志排障。
    throw new Error("KNOWLEDGE_RETRIEVAL_UNAVAILABLE", { cause: error });
  }
}

interface RerankResult { index: number; score: number }

async function rerank(query: string, rows: HybridRow[]): Promise<HybridRow[]> {
  if (rows.length === 0) return [];
  const { TEI_RERANKER_URL } = getConfig();
  const response = await fetch(`${TEI_RERANKER_URL.replace(/\/$/, "")}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      texts: rows.map((row) => row.content),
      raw_scores: false,
      return_text: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Reranker returned ${response.status}`);
  const rankings = (await response.json()) as RerankResult[];
  // TEI 返回原数组 index；过滤异常 index，再将 cross-encoder 分数写回统一 score。
  return rankings
    .filter((item) => Number.isInteger(item.index) && rows[item.index])
    .map((item) => ({ ...rows[item.index], score: item.score }));
}
