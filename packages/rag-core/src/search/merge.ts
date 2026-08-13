import type { Evidence } from "../types";

/** URL 相同的网页只保留高分项；知识库 Chunk 依靠 chunkId 去重。 */
export function mergeAndRankEvidence(groups: Evidence[][], limit = 12): Evidence[] {
  const best = new Map<string, Evidence>();
  for (const evidence of groups.flat()) {
    const key = evidence.url?.toLowerCase() || evidence.chunkId || `${evidence.provider}:${evidence.id}`;
    const existing = best.get(key);
    if (!existing || evidence.score > existing.score) best.set(key, evidence);
  }

  return [...best.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item, index) => ({ ...item, id: `S${index + 1}` }));
}
