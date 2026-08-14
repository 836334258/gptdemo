# Open RAG Chat

一个面向生产环境的开源 ChatGPT 风格 RAG 工作台。默认模型是 Gemini，普通模型调用统一经过 LiteLLM；在线编排只使用 LangGraph/LangChain，LlamaIndex 只负责离线文档切分，不存在重复 Agent 编排层。

## 已实现能力

- Next.js 16 + assistant-ui：流式聊天、历史会话、停止生成、搜索模式、知识库与模型选择。
- Supabase：Auth、Postgres、pgvector、Storage、RLS、PGMQ、Cron 扩展、会话/引用/反馈/评测/审计模型。
- 两种网页搜索：Firecrawl v2 与 Gemini 原生 Google Search，可关闭、自动选择、单独启用或双路融合。
- RAG 检索：中文友好查询归一化、多查询召回、向量 + 全文 RRF、跨查询 RRF、TEI cross-encoder rerank、去重和引用编号。
- 文档生产链：私有上传、SHA-256 幂等、PGMQ、Docling 本地解析、LlamaIndex 切分、TEI 批量向量化、版本原子激活、重试/死信。
- 自动上下文压缩：软/硬/紧急水位、保留最近消息、结构化摘要版本、覆盖校验、校验和、候选/激活/废弃状态；原始消息永久保留。
- 一致性与安全：用户 JWT 贯穿 PostgREST/RPC、service role 不进入 Web、消息 + 引用原子提交、租户 RLS、私有对象路径隔离。
- 可运维性：LangGraph Postgres checkpoint、健康检查、检索与工具运行表、评测/删除持久队列、Phoenix/OTel 基础设施入口。

## 目录

```text
apps/web                 Next.js 页面、认证、聊天与知识库管理
packages/rag-core        LangGraph、检索、搜索、上下文策略、持久化
workers/ingestion        Docling/LlamaIndex/TEI 文档 Worker
supabase/migrations      数据模型、RLS、RPC、队列
infra/litellm            模型别名与路由
docker-compose.yml       LiteLLM、Phoenix、Valkey、TEI
```

## 本地启动

要求 Node.js 22+、pnpm 11、Python 3.12、Docker Desktop 和 Supabase CLI。

1. 复制 `.env.example` 为根目录 `.env`，填写本地 Supabase publishable/anon key、LiteLLM master key 等配置。Web 启动脚本会显式加载这一个文件，Docker Compose 也读取它，避免根目录与 `apps/web/.env.local` 的同名变量互相覆盖。密钥不要提交 Git。
2. 执行 `supabase start` 应用全部迁移。
3. 执行 `docker compose --profile models up -d` 启动 LiteLLM、Phoenix、embedding 与 reranker。LiteLLM 会把成功和失败调用通过 OTLP 写入 Phoenix，可在 `http://127.0.0.1:6006` 查看延迟、token、异常与模型 trace。没有模型服务时，聊天仍可运行但知识库召回会降级为空。
4. 执行 `pnpm dev` 启动 Web。
5. 在 `workers/ingestion` 执行 `uv sync --all-groups`，配置 Worker 的 `SUPABASE_DB_URL`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 后运行 `uv run rag-ingestion-worker`。
6. 再配置 `EVALUATION_WORKER_TOKEN`（Web 与 Worker 必须相同），运行 `uv run rag-operations-worker`，消费评测与删除队列。

开发环境可设置 `ALLOW_MOCK_LLM=true`；调用真实 Gemini 时设为 `false`，并配置 `GOOGLE_API_KEY` 与 LiteLLM master key。设置 `REQUIRE_AUTH=true` 会禁止匿名聊天，未登录时页面会明确提示登录。

## 自定义模型

前端只提交模型别名。新增模型时同时维护：

1. `infra/litellm/config.yaml` 的 `model_list`，将别名映射到上游模型；
2. Supabase `model_catalog`，控制 UI 可见性与能力元数据。

应用代码不保存供应商密钥，也不直接依赖 Gemini 之外模型的 SDK。Google 原生搜索是唯一例外，因为它是 Gemini 专用 grounding 工具，不能和普通 LangChain function tools 混在同一次调用。

## 关键代码说明

- `packages/rag-core/src/graph.ts`：单一在线状态图。节点顺序是上下文策略、知识库召回、网页搜索、证据融合、原生流式生成。节点之间只传统一 `Evidence`。
- `packages/rag-core/src/context/policy.ts`：中文字符按更保守 token 比例估算；压缩永远排除最近消息和当前工具状态。
- `packages/rag-core/src/persistence/conversation.ts`：只用用户 JWT；`done` 发送前，助手消息、引用和新摘要必须已成功提交。
- `supabase/migrations/202608130006_context_summary_activation.sql`：行锁串行化压缩，校验消息归属、覆盖端点、压缩率和 checksum，再切换唯一 active 版本。
- `workers/ingestion/src/open_rag_ingestion/repository.py`：Worker 以条件更新抢占 job；新版本全部写完才切换 `is_active`，不会向检索暴露半成品索引。
- `workers/ingestion/src/open_rag_ingestion/parser.py`：私有对象用 service role 仅在 Worker 下载，流式限制 100 MiB，临时文件在成功或异常时都清理。

关键业务分支旁都带有中文或中英双语注释，重点解释“为什么这样保证安全/幂等/降级”，而非逐行复述语法。

## 上线前检查

- 将 Docker 镜像从示例 tag 固定为经过扫描的 digest；备份 Supabase 数据库与 Storage。
- 在 CI 执行 `pnpm typecheck && pnpm test && pnpm build`，以及 Worker 的 Ruff、严格 MyPy、Pytest。
- 用真实 Gemini、Firecrawl、TEI 完成 smoke test；当前仓库不包含任何真实 API key。
- 根据业务语料建立 eval dataset，至少监控 Recall@K、MRR/NDCG、引用支持率、忠实度、无答案正确率、P95 延迟与单轮成本。
- 配置队列积压、dead letter、摘要失败、搜索降级和 5xx 告警；定期做跨租户 RLS 回归。

## 许可证注意

本仓库自身应在发布前选择许可证。集成组件需分别遵守其许可证，尤其自托管 Firecrawl 的 AGPL 条款；对外提供网络服务前请让法务确认修改与分发义务。
