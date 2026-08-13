"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

export function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("Supabase 浏览器配置尚未完成");
      setLoading(false);
      return;
    }

    const result = mode === "login"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <section className="auth-card">
      <h1>{mode === "login" ? "登录 Open RAG" : "创建账号"}</h1>
      <p>登录后会话、知识库权限和引用记录才会持久化。</p>
      <form onSubmit={submit}>
        <label>邮箱<input name="email" type="email" autoComplete="email" required /></label>
        <label>密码<input name="password" type="password" minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button type="submit" disabled={loading}>{loading ? "处理中…" : mode === "login" ? "登录" : "注册"}</button>
      </form>
      <button type="button" className="auth-switch" onClick={() => setMode((value) => value === "login" ? "signup" : "login")}>
        {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
      </button>
    </section>
  );
}
