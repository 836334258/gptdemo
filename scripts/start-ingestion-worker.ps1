[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$workerDirectory = Join-Path $projectRoot "workers\ingestion"
$storageContainer = "supabase_storage_open-rag-chat"

# 索引依赖 embedding；如果模型还在首次下载，先停下，避免消费队列后把任务标记为失败。
try {
    $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:8081/health"
    if ($health.StatusCode -ne 200) {
        throw "embedding health returned HTTP $($health.StatusCode)"
    }
}
catch {
    throw "Embedding 尚未就绪。请先运行 docker compose --profile models up -d，并等待 http://127.0.0.1:8081/health 返回 200。"
}

# 本地 Supabase CLI 把 service role key 注入 Storage 容器。这里只在内存中取值，
# 不打印密钥、不修改 .env，也不会让密钥进入 Next.js 浏览器代码。
$serviceLine = docker inspect $storageContainer --format '{{range .Config.Env}}{{println .}}{{end}}' |
    Where-Object { $_ -like "SERVICE_KEY=*" } |
    Select-Object -First 1

if (-not $serviceLine) {
    throw "无法从 $storageContainer 获取 SERVICE_KEY，请先启动本地 Supabase。"
}

$previousServiceKey = $env:SUPABASE_SERVICE_ROLE_KEY
$env:SUPABASE_SERVICE_ROLE_KEY = $serviceLine.Substring("SERVICE_KEY=".Length)

try {
    Push-Location $workerDirectory
    uv run rag-ingestion-worker
}
finally {
    Pop-Location
    # Worker 停止后清理脚本进程的敏感环境变量。
    if ($null -eq $previousServiceKey) {
        Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
    }
    else {
        $env:SUPABASE_SERVICE_ROLE_KEY = $previousServiceKey
    }
}
