import { z } from "zod";

const optionalUrl = z.string().url().optional();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_DB_URL: z.string().optional(),
  LITELLM_BASE_URL: z.string().url().default("http://127.0.0.1:4000/v1"),
  LITELLM_API_KEY: z.string().optional(),
  CHAT_MODEL: z.string().default("chat-default"),
  CONTEXT_COMPRESSION_MODEL: z.string().default("context-compressor"),
  ALLOW_MOCK_LLM: z.string().default("false").transform((value) => value === "true"),
  REQUIRE_AUTH: z.string().default("false").transform((value) => value === "true"),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_SEARCH_MODEL: z.string().default("gemini-3.6-flash"),
  FIRECRAWL_BASE_URL: z.string().url().default("https://api.firecrawl.dev/v2"),
  FIRECRAWL_API_KEY: z.string().optional(),
  TEI_EMBEDDING_URL: z.string().url().default("http://127.0.0.1:8081"),
  TEI_RERANKER_URL: z.string().url().default("http://127.0.0.1:8082"),
  RETRIEVAL_CANDIDATE_LIMIT: z.coerce.number().int().min(10).max(200).default(40),
  RETRIEVAL_RERANK_LIMIT: z.coerce.number().int().min(1).max(50).default(12),
  CONTEXT_SOFT_LIMIT: z.coerce.number().min(0.1).max(0.9).default(0.65),
  CONTEXT_HARD_LIMIT: z.coerce.number().min(0.2).max(0.95).default(0.8),
  CONTEXT_EMERGENCY_LIMIT: z.coerce.number().min(0.3).max(0.99).default(0.92),
  CONTEXT_RECENT_MESSAGES: z.coerce.number().int().min(4).max(50).default(12),
  CONTEXT_MODEL_WINDOW_TOKENS: z.coerce.number().int().min(128).default(1_048_576),
});

export type RagConfig = ReturnType<typeof getConfig>;

let cachedConfig: z.infer<typeof EnvSchema> | undefined;

export function getConfig() {
  cachedConfig ??= EnvSchema.parse(process.env);
  return cachedConfig;
}

export function resetConfigForTests() {
  cachedConfig = undefined;
}
