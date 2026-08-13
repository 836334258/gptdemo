"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

export function AuthButton() {
  const [email, setEmail] = useState<string>();
  useEffect(() => {
    const client = getSupabaseBrowserClient();
    if (!client) return;
    void client.auth.getUser().then(({ data }) => setEmail(data.user?.email));
    const { data: { subscription } } = client.auth.onAuthStateChange(
      (_event, session) => setEmail(session?.user.email),
    );
    // 显式包一层清理函数，避免把类方法脱离实例后直接交给 React。
    return () => subscription.unsubscribe();
  }, []);

  if (!email) return <Link className="auth-link" href="/login">登录</Link>;
  return (
    <div className="auth-session">
      <span className="auth-user" title={email}>{email}</span>
      <button type="button" onClick={() => void getSupabaseBrowserClient()?.auth.signOut()}>退出</button>
    </div>
  );
}
