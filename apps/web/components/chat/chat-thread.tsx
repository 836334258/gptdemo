"use client";

import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowUp, Bot, Copy, RefreshCw, Square, ThumbsDown, ThumbsUp, User } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

export function ChatThread() {
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport">
        {/*
          这里不依赖已弃用的 ThreadPrimitive.Empty。部分自定义 Runtime 会在
          初始化时创建空分支，使 isEmpty 暂时为 false；CSS 根据真实消息节点
          决定是否隐藏欢迎区，首屏不会因此出现大片空白。
        */}
        <div className="empty-state">
          <div className="empty-logo"><Bot aria-hidden="true" /></div>
          <h1>今天想研究什么？</h1>
          <p>可以搜索私有知识库、实时网页，或同时比较两种来源。</p>
          <div className="starter-questions">
            <StarterQuestion text="总结知识库里的核心结论" />
            <StarterQuestion text="搜索最新资料并给出引用" />
          </div>
        </div>

        <ThreadPrimitive.Messages
          components={{ UserMessage, AssistantMessage }}
        />

        <ThreadPrimitive.ViewportFooter className="composer-footer">
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              className="composer-input"
              placeholder="向知识库提问…"
              rows={1}
            />
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send className="composer-button" aria-label="发送">
                <ArrowUp aria-hidden="true" />
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel className="composer-button" aria-label="停止生成">
                <Square aria-hidden="true" />
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </ComposerPrimitive.Root>
          <p className="composer-hint">回答可能有误，请通过引用原文核实重要信息。</p>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function StarterQuestion({ text }: Readonly<{ text: string }>) {
  const aui = useAui();
  return (
    <button type="button" onClick={() => aui.composer.setText(text)}>
      {text}
    </button>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message-row message-user">
      <div className="message-avatar"><User aria-hidden="true" /></div>
      <div className="message-bubble"><MessagePrimitive.Content /></div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const messageId = useAuiState((state) => state.message.id);
  async function rate(rating: -1 | 1) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.auth.getUser();
    if (!data.user) return;
    // message_id + user_id 唯一约束使用户修改评价时只更新同一行。
    await supabase.from("feedback").upsert({
      message_id: messageId,
      user_id: data.user.id,
      rating,
    }, { onConflict: "message_id,user_id" });
  }
  return (
    <MessagePrimitive.Root className="message-row message-assistant">
      <div className="message-avatar"><Bot aria-hidden="true" /></div>
      <div className="message-body">
        <div className="message-bubble"><MessagePrimitive.Content /></div>
        <div className="message-actions">
          <ActionBarPrimitive.Copy asChild>
            <button type="button" aria-label="复制回答"><Copy aria-hidden="true" /></button>
          </ActionBarPrimitive.Copy>
          <button type="button" aria-label="回答有帮助" onClick={() => void rate(1)}><ThumbsUp aria-hidden="true" /></button>
          <button type="button" aria-label="回答需改进" onClick={() => void rate(-1)}><ThumbsDown aria-hidden="true" /></button>
          <BranchPickerPrimitive.Root hideWhenSingleBranch>
            <BranchPickerPrimitive.Previous aria-label="上一个分支">‹</BranchPickerPrimitive.Previous>
            <span><BranchPickerPrimitive.Number />/<BranchPickerPrimitive.Count /></span>
            <BranchPickerPrimitive.Next aria-label="下一个分支">›</BranchPickerPrimitive.Next>
          </BranchPickerPrimitive.Root>
          <ActionBarPrimitive.Reload asChild>
            <button type="button" aria-label="重新生成"><RefreshCw aria-hidden="true" /></button>
          </ActionBarPrimitive.Reload>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}
