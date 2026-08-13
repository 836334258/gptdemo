"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, BookOpen, Menu, MessageSquarePlus, Search, Settings } from "lucide-react";
import type { SearchMode } from "@open-rag/core";
import { RagRuntimeProvider } from "./runtime-provider";
import { ChatThread } from "./chat-thread";
import { AuthButton } from "@/components/auth/auth-button";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

const searchModes: Array<{ value: SearchMode; label: string }> = [
  { value: "auto", label: "自动搜索" },
  { value: "off", label: "不联网" },
  { value: "firecrawl", label: "Firecrawl" },
  { value: "google", label: "Google Search" },
  { value: "both", label: "双搜索" },
];

interface ConversationItem { id: string; title: string; updated_at: string }
interface KnowledgeBaseItem { id: string; name: string }
interface ModelItem { alias: string; provider: string; upstream_model: string }

export function ChatWorkspace() {
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseItem[]>([]);
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [model, setModel] = useState("chat-default");

  const refreshWorkspace = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      setConversations([]);
      setKnowledgeBases([]);
      setModels([]);
      return;
    }
    const [conversationResult, kbResult, modelResult] = await Promise.all([
      supabase.from("conversations").select("id,title,updated_at").is("archived_at", null).order("updated_at", { ascending: false }).limit(40),
      supabase.from("knowledge_bases").select("id,name").order("name"),
      supabase.from("model_catalog").select("alias,provider,upstream_model").eq("enabled", true).order("alias"),
    ]);
    if (!conversationResult.error) setConversations((conversationResult.data ?? []) as ConversationItem[]);
    if (!kbResult.error) setKnowledgeBases((kbResult.data ?? []) as KnowledgeBaseItem[]);
    if (!modelResult.error) setModels((modelResult.data ?? []) as ModelItem[]);
  }, []);

  useEffect(() => {
    void refreshWorkspace();
    const client = getSupabaseBrowserClient();
    if (!client) return;
    const { data: { subscription } } = client.auth.onAuthStateChange(() => void refreshWorkspace());
    return () => subscription.unsubscribe();
  }, [refreshWorkspace]);

  const runtimeOptions = useMemo(
    () => ({ searchMode, knowledgeBaseIds, model }),
    [knowledgeBaseIds, model, searchMode],
  );

  return (
    <main className="app-shell">
      <aside className={sidebarOpen ? "sidebar" : "sidebar sidebar-collapsed"}>
        <div className="sidebar-header">
          <button type="button" className="icon-button" aria-label="展开或收起侧栏" onClick={() => setSidebarOpen((v) => !v)}>
            <Menu aria-hidden="true" />
          </button>
          {sidebarOpen && <span className="brand">Open RAG</span>}
        </div>
        {sidebarOpen && (
          <>
            <button type="button" className="new-chat" onClick={() => setConversationId(crypto.randomUUID())}><MessageSquarePlus aria-hidden="true" />新对话</button>
            <nav className="sidebar-nav" aria-label="工作区导航">
              <Link href="/knowledge"><BookOpen aria-hidden="true" />知识库</Link>
              <Link href="/evaluations"><BarChart3 aria-hidden="true" />RAG 评测</Link>
              <a href="#search"><Search aria-hidden="true" />搜索记录</a>
            </nav>
            <div className="conversation-list">
              <p>最近对话</p>
              {conversations.length === 0 ? <span>登录后显示历史记录</span> : conversations.map((item) => (
                <button type="button" key={item.id} className={item.id === conversationId ? "active" : ""} onClick={() => setConversationId(item.id)} title={item.title}>
                  {item.title}
                </button>
              ))}
            </div>
            <button type="button" className="sidebar-settings"><Settings aria-hidden="true" />系统设置</button>
          </>
        )}
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <div>
            <strong>{model}</strong>
            <span>由 LiteLLM 路由</span>
          </div>
          <div className="topbar-actions">
            <details className="kb-picker">
              <summary>{knowledgeBaseIds.length ? `知识库 ${knowledgeBaseIds.length}` : "选择知识库"}</summary>
              <div>
                {knowledgeBases.length === 0 ? <span>暂无知识库</span> : knowledgeBases.map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      checked={knowledgeBaseIds.includes(item.id)}
                      onChange={(event) => setKnowledgeBaseIds((current) => event.target.checked
                        ? [...current, item.id].slice(0, 20)
                        : current.filter((id) => id !== item.id))}
                    />
                    {item.name}
                  </label>
                ))}
              </div>
            </details>
            <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="模型路由">
              {(models.length ? models : [{ alias: "chat-default", provider: "gemini", upstream_model: "Gemini" }]).map((item) => (
                <option key={item.alias} value={item.alias}>{item.alias}</option>
              ))}
            </select>
            <select value={searchMode} onChange={(event) => setSearchMode(event.target.value as SearchMode)} aria-label="网页搜索模式">
              {searchModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
            </select>
            <AuthButton />
          </div>
        </header>

        <RagRuntimeProvider key={conversationId} conversationId={conversationId} options={runtimeOptions} onConversationChanged={refreshWorkspace}>
          <ChatThread />
        </RagRuntimeProvider>
      </section>
    </main>
  );
}
