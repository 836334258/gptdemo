import { ChatGoogle } from "@langchain/google";
import { HumanMessage } from "@langchain/core/messages";
import { getConfig } from "../config";
import type { Evidence } from "../types";

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

/**
 * Google 原生搜索必须独立调用，不能和 Firecrawl 这种标准函数工具绑定到
 * 同一个 Gemini 请求。这里仅产出证据，最终回答仍统一经过 LiteLLM。
 */
export async function searchWithGoogle(query: string): Promise<Evidence[]> {
  const config = getConfig();
  if (!config.GOOGLE_API_KEY) return [];

  const model = new ChatGoogle(config.GOOGLE_SEARCH_MODEL).bindTools([{ googleSearch: {} }]);
  const response = await model.invoke([
    new HumanMessage(`请搜索并整理这个问题需要的最新事实。只陈述搜索结果能支持的内容：${query}`),
  ]);

  const metadata = response.response_metadata as {
    groundingMetadata?: { groundingChunks?: GroundingChunk[] };
  };
  const chunks = metadata.groundingMetadata?.groundingChunks ?? [];
  const text = typeof response.text === "string" ? response.text : String(response.content);

  if (chunks.length === 0) {
    return [{
      id: "G1",
      provider: "google",
      title: "Google Search Grounding",
      content: text,
      score: 0.75,
      retrievedAt: new Date().toISOString(),
      metadata: { grounded: true },
    }];
  }

  return chunks.map((chunk, index) => ({
    id: `G${index + 1}`,
    provider: "google",
    title: chunk.web?.title || "Google Search result",
    url: chunk.web?.uri,
    // Grounding API 的整体研究结果保留一次；引用 URL 则逐条保留。
    content: index === 0 ? text : `来源：${chunk.web?.title ?? chunk.web?.uri ?? "Google"}`,
    score: Math.max(0.1, 0.95 - index * 0.05),
    retrievedAt: new Date().toISOString(),
    metadata: { grounded: true },
  }));
}
