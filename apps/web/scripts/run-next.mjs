import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryEnv = resolve(scriptDirectory, "../../../.env");

// Web 与 Docker 共用仓库根目录配置。用 loadEnvFile 而不是 Node CLI 参数，
// 避免 --env-file 被 Next.js 构建 Worker 继承后触发 ERR_WORKER_INVALID_EXEC_ARGV。
if (existsSync(repositoryEnv)) process.loadEnvFile(repositoryEnv);

const command = process.argv[2];
if (!command) throw new Error("Next.js command is required (dev, build or start)");
process.argv = [process.execPath, "next", command, ...process.argv.slice(3)];
await import("next/dist/bin/next");
