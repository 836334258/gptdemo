import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 本地端到端测试使用 127.0.0.1；显式允许该开发来源可保留 Next.js
  // 对其他未知跨域来源的默认拦截。
  allowedDevOrigins: ["127.0.0.1"],
  // rag-core keeps the orchestration code outside the UI package while Next.js
  // still compiles it into server route handlers.
  transpilePackages: ["@open-rag/core"],
};

export default nextConfig;
