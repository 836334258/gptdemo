import { getConfig } from "../config";
import type { Evidence } from "../types";

interface FirecrawlSearchResponse {
  success: boolean;
  data?: {
    web?: Array<{
      title?: string;
      description?: string;
      url?: string;
      markdown?: string;
      metadata?: Record<string, unknown>;
    }>;
  };
  error?: string;
}

export async function searchWithFirecrawl(query: string, limit = 6): Promise<Evidence[]> {
  const config = getConfig();
  if (!config.FIRECRAWL_API_KEY) return [];

  const response = await fetch(`${config.FIRECRAWL_BASE_URL.replace(/\/$/, "")}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      limit,
      sources: ["web"],
      safe: true,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      // 服务端威胁过滤是第一层，抓取正文仍会在生成提示中标为不可信数据。
      threatProtection: { riskScoreThreshold: 60 },
    }),
    signal: AbortSignal.timeout(65_000),
  });

  const payload = (await response.json()) as FirecrawlSearchResponse;
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Firecrawl search failed with ${response.status}`);
  }

  return (payload.data?.web ?? [])
    .filter((item): item is typeof item & { url: string } => Boolean(item.url))
    .map((item, index) => ({
      id: `F${index + 1}`,
      provider: "firecrawl",
      title: item.title || item.url,
      url: canonicalizeUrl(item.url),
      content: (item.markdown || item.description || "").slice(0, 12_000),
      score: Math.max(0.1, 1 - index * 0.08),
      retrievedAt: new Date().toISOString(),
      metadata: item.metadata ?? {},
    }));
}

function canonicalizeUrl(raw: string) {
  const url = new URL(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "fbclid" || key === "gclid") {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}
