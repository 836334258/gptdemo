import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, { ok: boolean; latencyMs: number; detail?: string }> = {};
  await runCheck(checks, "supabase", async () => {
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) throw new Error("SUPABASE_URL missing");
    const response = await fetch(`${url}/auth/v1/health`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  });
  await runCheck(checks, "postgrest", async () => {
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase REST config missing");
    // 根 OpenAPI 端点会穿过 API gateway 并访问数据库 schema cache，
    // 不需要为健康检查引入直接 PostgreSQL 驱动。
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  });
  const healthy = Object.values(checks).every((check) => check.ok);
  return NextResponse.json({
    status: healthy ? "ok" : "degraded",
    service: "open-rag-web",
    timestamp: new Date().toISOString(),
    checks,
  }, { status: healthy ? 200 : 503 });
}

async function runCheck(
  checks: Record<string, { ok: boolean; latencyMs: number; detail?: string }>,
  name: string,
  operation: () => Promise<void>,
) {
  const started = performance.now();
  try {
    await operation();
    checks[name] = { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    // 健康接口只公开低敏错误摘要，不返回连接串或堆栈。
    checks[name] = { ok: false, latencyMs: Math.round(performance.now() - started), detail: error instanceof Error ? error.message : "unknown" };
  }
}
