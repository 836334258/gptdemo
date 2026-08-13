"use client";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type MessageStatus,
  type SourceMessagePart,
  type TextMessagePart,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatRequest, Evidence, StreamEvent } from "@open-rag/core";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type RuntimeOptions = Pick<ChatRequest, "searchMode" | "knowledgeBaseIds" | "model">;

interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources: Evidence[];
  status: MessageStatus;
  createdAt: Date;
}

interface PersistedCitation {
  id: string;
  provider: Evidence["provider"];
  title: string;
  source_uri?: string;
  quote?: string;
  chunk_id?: string;
  page_number?: number;
  verification_score?: number;
  created_at: string;
}

interface PersistedMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: Array<{ type: string; text?: string }>;
  status: string;
  created_at: string;
  citations?: PersistedCitation[];
}

/**
 * 当前视图消息由应用持有，历史记录由 Supabase 恢复；assistant-ui 只负责
 * 渲染与交互，因此后续替换数据库订阅策略时不需要重写 UI。
 */
export function RagRuntimeProvider({
  children,
  options,
  conversationId,
  onConversationChanged,
}: Readonly<{
  children: ReactNode;
  options: RuntimeOptions;
  conversationId: string;
  onConversationChanged?: () => void;
}>) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let cancelled = false;
    // 会话切换时从 Supabase 恢复消息和引用；UI state 只是当前视图缓存，
    // 数据库始终是可跨设备恢复的事实来源。
    void supabase
      .from("messages")
      .select("id,role,content,status,created_at,citations(id,provider,title,source_uri,quote,chunk_id,page_number,verification_score,created_at)")
      .eq("conversation_id", conversationId)
      .order("created_at")
      .then(({ data, error }) => {
        if (cancelled || error) return;
        setMessages(((data ?? []) as PersistedMessage[])
          .filter((row) => row.role === "user" || row.role === "assistant")
          .map(persistedToStored));
      });
    return () => { cancelled = true; };
  }, [conversationId]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const userMessage: StoredMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: getAppendText(message),
      sources: [],
      status: { type: "complete", reason: "stop" },
      createdAt: new Date(),
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: StoredMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      sources: [],
      status: { type: "running" },
      createdAt: new Date(),
    };
    const requestMessages = [...messages, userMessage];
    setMessages([...requestMessages, assistantMessage]);
    setIsRunning(true);

    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      await consumeChatStream(
        {
          conversationId,
          assistantMessageId: assistantId,
          messages: requestMessages.map((item) => ({
            id: item.id,
            role: item.role,
            content: item.text,
            createdAt: item.createdAt.toISOString(),
          })),
          searchMode: options.searchMode,
          knowledgeBaseIds: options.knowledgeBaseIds,
          model: options.model,
        },
        controller.signal,
        (event) => {
          setMessages((current) => current.map((item) => {
            if (item.id !== assistantId) return item;
            if (event.type === "token") return { ...item, text: item.text + event.text };
            if (event.type === "citation") return { ...item, sources: [...item.sources, event.evidence] };
            return item;
          }));
        },
      );
      setMessages((current) => updateStatus(current, assistantId, { type: "complete", reason: "stop" }));
      onConversationChanged?.();
    } catch (error) {
      const cancelled = controller.signal.aborted;
      setMessages((current) => current.map((item) => item.id === assistantId ? {
        ...item,
        text: item.text || (cancelled ? "已停止生成。" : "生成失败，请稍后重试。"),
        status: {
          type: "incomplete",
          reason: cancelled ? "cancelled" : "error",
          error: cancelled ? undefined : { message: error instanceof Error ? error.message : "Unknown error" },
        },
      } : item));
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setIsRunning(false);
    }
  }, [conversationId, messages, onConversationChanged, options]);

  const onCancel = useCallback(async () => {
    activeRequest.current?.abort();
  }, []);

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning,
    onNew,
    onCancel,
    setMessages: (next) => setMessages([...next]),
    convertMessage,
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function persistedToStored(row: PersistedMessage): StoredMessage {
  return {
    id: row.id,
    role: row.role as "user" | "assistant",
    text: row.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"),
    sources: (row.citations ?? []).map((citation) => ({
      id: citation.id,
      provider: citation.provider,
      title: citation.title,
      url: citation.source_uri,
      content: citation.quote ?? "",
      score: citation.verification_score ?? 0,
      chunkId: citation.chunk_id,
      pageNumber: citation.page_number,
      retrievedAt: citation.created_at,
      metadata: {},
    })),
    status: { type: "complete", reason: "stop" },
    createdAt: new Date(row.created_at),
  };
}

function convertMessage(message: StoredMessage): ThreadMessageLike {
  const content: Array<TextMessagePart | SourceMessagePart> = [
    { type: "text", text: message.text },
    ...message.sources.flatMap((source): SourceMessagePart[] => {
      if (source.url) {
        return [{ type: "source", sourceType: "url", id: source.id, url: source.url, title: source.title }];
      }
      return [{
        type: "source",
        sourceType: "document",
        id: source.id,
        title: source.title,
        mediaType: "text/plain",
      }];
    }),
  ];
  return {
    id: message.id,
    role: message.role,
    content,
    status: message.status,
    createdAt: message.createdAt,
  };
}

function getAppendText(message: AppendMessage) {
  return message.content
    .filter((part): part is TextMessagePart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function updateStatus(messages: StoredMessage[], id: string, status: MessageStatus) {
  return messages.map((message) => message.id === id ? { ...message, status } : message);
}

async function consumeChatStream(
  request: ChatRequest,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: await createRequestHeaders(),
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error((await response.text()) || "聊天服务暂时不可用");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as StreamEvent;
      if (event.type === "error") throw new Error(event.message);
      onEvent(event);
    }
  }
}

async function createRequestHeaders() {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return headers;
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
  return headers;
}
