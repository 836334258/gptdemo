import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, rewriteQueries } from "./knowledge";

function row(chunkId: string, score = 0) {
  return {
    chunk_id: chunkId,
    document_id: `doc-${chunkId}`,
    title: chunkId,
    content: chunkId,
    page_number: null,
    score,
    metadata: null,
  };
}

describe("knowledge retrieval helpers", () => {
  it("keeps the original query and adds a normalized recall query", () => {
    expect(rewriteQueries("请问 RAG 的召回率如何提升？")).toEqual([
      "请问 RAG 的召回率如何提升？",
      "RAG 的召回率如何提升",
    ]);
  });

  it("RRF rewards chunks returned by multiple query variants", () => {
    const result = reciprocalRankFusion([[row("a"), row("b")], [row("b"), row("c")]]);
    expect(result[0].chunk_id).toBe("b");
    expect(new Set(result.map((item) => item.chunk_id)).size).toBe(3);
  });
});
