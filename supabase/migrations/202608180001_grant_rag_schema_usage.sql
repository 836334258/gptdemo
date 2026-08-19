begin;

-- search_chunks_hybrid 以 security invoker 运行，并在 SQL 中显式调用
-- rag.can_read_knowledge_base。除了函数 EXECUTE，登录用户还必须有 rag schema
-- 的 USAGE；否则文档已索引也会在检索时被 PostgreSQL 拒绝。
grant usage on schema rag to authenticated;

commit;
