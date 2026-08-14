import { ZodError } from "zod";

export type PublicChatErrorCode =
  | "AUTH_REQUIRED"
  | "INVALID_SESSION"
  | "INVALID_REQUEST"
  | "PERSISTENCE_FAILED"
  | "CHAT_FAILED";

export interface PublicChatError {
  code: PublicChatErrorCode;
  message: string;
}

const publicMessages: Record<PublicChatErrorCode, string> = {
  AUTH_REQUIRED: "请先登录后再发送消息。",
  INVALID_SESSION: "登录状态已失效，请重新登录。",
  INVALID_REQUEST: "聊天请求格式不正确，请刷新页面后重试。",
  PERSISTENCE_FAILED: "会话保存失败，请检查 Supabase 服务后重试。",
  CHAT_FAILED: "模型生成失败，请检查 LiteLLM 和模型配置后重试。",
};

/**
 * 流式响应已经返回 HTTP 200，后续错误只能通过 NDJSON 事件传递；
 * 保留 code/requestId，前端才能给出可操作提示，运维也能按编号定位日志。
 */
export class ChatStreamError extends Error {
  constructor(
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(toUserFacingChatError(code, requestId));
    this.name = "ChatStreamError";
  }
}

/** 服务端只向浏览器返回白名单错误，不直接暴露供应商或数据库原始异常。 */
export function toPublicChatError(error: unknown): PublicChatError {
  if (error instanceof ZodError) return fromCode("INVALID_REQUEST");
  const message = error instanceof Error ? error.message : "";
  if (message === "AUTH_REQUIRED") return fromCode("AUTH_REQUIRED");
  if (message === "INVALID_SESSION") return fromCode("INVALID_SESSION");
  if (/^(CONVERSATION|MESSAGE|SUMMARY|ASSISTANT)_(WRITE|READ)_FAILED:/.test(message)) {
    return fromCode("PERSISTENCE_FAILED");
  }
  return fromCode("CHAT_FAILED");
}

export function toUserFacingChatError(code: string, requestId?: string) {
  const normalized = isPublicChatErrorCode(code) ? code : "CHAT_FAILED";
  const message = publicMessages[normalized];
  // 认证错误本身已足够明确；基础设施错误附短编号，方便用户截图后查服务端日志。
  return requestId && normalized !== "AUTH_REQUIRED" && normalized !== "INVALID_SESSION"
    ? `${message}（错误编号：${requestId.slice(0, 8)}）`
    : message;
}

function fromCode(code: PublicChatErrorCode): PublicChatError {
  return { code, message: publicMessages[code] };
}

function isPublicChatErrorCode(code: string): code is PublicChatErrorCode {
  return code in publicMessages;
}
