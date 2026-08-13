import { z } from "zod";

export const SearchModeSchema = z.enum(["off", "auto", "firecrawl", "google", "both"]);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string().datetime().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  conversationId: z.string().uuid(),
  assistantMessageId: z.string().uuid().optional(),
  messages: z.array(ChatMessageSchema).min(1).max(500),
  searchMode: SearchModeSchema.default("auto"),
  knowledgeBaseIds: z.array(z.string().uuid()).max(20).default([]),
  model: z.string().min(1).default("chat-default"),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export type EvidenceProvider = "knowledge_base" | "firecrawl" | "google";

/** 所有检索器都必须转换成这一结构，生成器不感知供应商差异。 */
export interface Evidence {
  id: string;
  provider: EvidenceProvider;
  title: string;
  url?: string;
  content: string;
  score: number;
  documentId?: string;
  chunkId?: string;
  pageNumber?: number;
  retrievedAt: string;
  metadata: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "status"; stage: string; message: string }
  | { type: "token"; text: string }
  | { type: "citation"; evidence: Evidence }
  | { type: "context"; action: ContextAction; estimatedTokens: number }
  | { type: "done"; conversationId: string }
  | { type: "error"; code: string; message: string };

export type ContextAction = "none" | "artifactize" | "summarize" | "emergency";

export interface ContextSummary {
  version: number;
  goals: string[];
  decisions: string[];
  facts: string[];
  constraints: string[];
  openTasks: string[];
  artifactRefs: string[];
  citationIds: string[];
  fromMessageId: string;
  toMessageId: string;
  sourceMessageIds: string[];
}
