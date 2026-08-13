import type { ChatMessage, ContextAction, ContextSummary } from "../types";

export interface ContextPolicy {
  modelWindowTokens: number;
  softLimit: number;
  hardLimit: number;
  emergencyLimit: number;
  recentMessages: number;
}

export interface ContextPlan {
  action: ContextAction;
  estimatedTokens: number;
  ratio: number;
  messagesToSummarize: ChatMessage[];
  recentMessages: ChatMessage[];
}

/**
 * 这是无外部依赖的保守估算器。中文字符通常比英文单词更接近一字符一
 * token，因此不能只用英文常见的 chars/4。正式调用前可再接供应商 countTokens。
 */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    const cjk = (message.content.match(/[\u3400-\u9fff]/g) ?? []).length;
    const other = message.content.length - cjk;
    return total + cjk + Math.ceil(other / 4) + 8;
  }, 0);
}

export function planContextCompression(
  messages: ChatMessage[],
  policy: ContextPolicy,
): ContextPlan {
  const estimatedTokens = estimateMessageTokens(messages);
  const ratio = estimatedTokens / policy.modelWindowTokens;
  const keepCount = Math.min(policy.recentMessages, messages.length);
  const splitAt = Math.max(0, messages.length - keepCount);

  let action: ContextAction = "none";
  if (ratio >= policy.emergencyLimit) action = "emergency";
  else if (ratio >= policy.hardLimit) action = "summarize";
  else if (ratio >= policy.softLimit) action = "artifactize";

  return {
    action,
    estimatedTokens,
    ratio,
    // 当前回合和最近消息永远不进入本次压缩，避免丢失进行中的工具状态。
    messagesToSummarize: messages.slice(0, splitAt),
    recentMessages: messages.slice(splitAt),
  };
}

/** 测试和无模型开发环境使用的可追溯摘要，不伪造消息中不存在的事实。 */
export function createDeterministicSummary(
  messages: ChatMessage[],
  previous?: ContextSummary,
): ContextSummary | undefined {
  if (messages.length === 0) return undefined;
  const userMessages = messages.filter((message) => message.role === "user");
  const sourceMessageIds = [...new Set([
    ...(previous?.sourceMessageIds ?? []),
    ...messages.map((message) => message.id),
  ])];
  return {
    version: (previous?.version ?? 0) + 1,
    goals: [...(previous?.goals ?? []), ...userMessages.slice(-3).map((message) => truncate(message.content, 180))].slice(-8),
    decisions: previous?.decisions ?? [],
    facts: previous?.facts ?? [],
    constraints: previous?.constraints ?? [],
    openTasks: previous?.openTasks ?? [],
    artifactRefs: previous?.artifactRefs ?? [],
    citationIds: [...new Set([...(previous?.citationIds ?? []), ...extractCitationIds(messages)])],
    fromMessageId: previous?.fromMessageId ?? messages[0].id,
    toMessageId: messages.at(-1)!.id,
    sourceMessageIds,
  };
}

function extractCitationIds(messages: ChatMessage[]): string[] {
  const ids = messages.flatMap((message) => message.content.match(/\[(?:S|K)\d+\]/g) ?? []);
  return [...new Set(ids.map((id) => id.slice(1, -1)))];
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
