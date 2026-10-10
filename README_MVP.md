# RAG MVP

这是一个本地 Hybrid Search RAG 最小原型，包含 TanStack Start 前端、NestJS 业务服务、FastAPI RAG 能力服务和可复用 RAG 核心包。

它会读取当前目录下的 Markdown 文件，完成：

- 文档解析
- 按章节分块
- BM25 关键词检索
- TF-IDF 余弦相似检索
- 检索结果融合
- 基于证据片段生成答案草稿和引用来源

## Web 运行

安装依赖：

```bash
python3 -m pip install -r apps/api/requirements.txt
pnpm install
pnpm run auth:migrate
```

Node.js 服务支持从 `apps/server/.env` 加载环境变量：

```bash
cp apps/server/.env.example apps/server/.env
```

Python RAG 能力服务支持从 `apps/api/.env` 加载 embedding 配置：

```bash
cp apps/api/.env.example apps/api/.env
```

开发模式一条命令启动全部服务：

```bash
pnpm run dev
```

也可以分别启动 3 个进程。先启动 Python RAG 能力服务：

```bash
pnpm run dev:api
```

再启动 NestJS 业务服务：

```bash
pnpm run dev:server
```

最后启动 TanStack Start 前端：

```bash
pnpm run dev:web
```

默认访问前端开发服务：

```text
http://127.0.0.1:3000
```

本地开发统一使用 `127.0.0.1`，不要混用 `localhost`。前端 dev server 会把 `/api` 代理到 NestJS 服务 `http://127.0.0.1:4000`，浏览器侧保持同源请求，Node.js 服务不需要额外开启 CORS。

后台服务提供：

- NestJS: `http://127.0.0.1:4000`
  - `POST /api/auth/sign-up/email`
  - `POST /api/auth/sign-in/email`
  - `POST /api/auth/sign-out`
  - `GET /api/auth/get-session`
  - `POST /api/auth/sign-in/social`
  - `GET /api/auth/callback/github`
  - `GET /api/documents`
  - `POST /api/search`
  - `GET /api/github/stars`
  - `GET /api/github/stars/index`
  - `POST /api/github/stars/sync`
  - `GET /api/github/stars/sync`
  - `POST /api/github/stars/sync/cancel`
  - `POST /api/github/stars/sync/reset`
  - `POST /api/github/stars/repositories/:repoId/reset`
- FastAPI: `http://127.0.0.1:8787`
  - `GET /api/health`
  - `GET /api/documents`
  - `POST /api/search`
  - `POST /api/github/stars/sync`
  - `GET /api/github/stars/sync/{user_id}`
  - `POST /api/github/stars/sync/{user_id}/cancel`
  - `POST /api/github/stars/sync/{user_id}/reset`
  - `GET /api/github/stars/{user_id}`
  - `POST /api/github/stars/{user_id}/repositories/{repo_id}/reset`
  - `POST /api/github/stars/search`

FastAPI 交互文档：

```text
http://127.0.0.1:8787/docs
```

GitHub 登录需要配置 OAuth App：

```env
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."
BETTER_AUTH_URL="http://127.0.0.1:4000"
BETTER_AUTH_SECRET="replace-with-a-long-random-secret"
FRONTEND_ORIGIN="http://127.0.0.1:3000"
GITHUB_STARS_MAX_PAGES=50
GITHUB_STARS_SYNC_INTERVAL_MS=21600000
```

GitHub OAuth App 的 Authorization callback URL 使用：

```text
http://127.0.0.1:4000/api/auth/callback/github
```

这个地址必须和 GitHub OAuth App 后台配置完全一致。`127.0.0.1`、`localhost`、端口、协议和路径任意一处不同，GitHub 都会拒绝并提示 `redirect_uri is not associated with this application`。如果你把 `BETTER_AUTH_URL` 改成了其他地址，callback URL 也要同步改成：

```text
<BETTER_AUTH_URL>/api/auth/callback/github
```

用户通过 GitHub 登录后，页面支持把该用户已 Star 的 GitHub 仓库作为个人外部知识源检索。职责边界是：NestJS 负责登录态、读取 Better Auth 的 GitHub access token、发起/取消同步任务、定时触发同步和代理查询；FastAPI 和 `packages/rag-core` 负责同步任务执行、原始数据存储、README 抽取、embedding、向量库存储和本地 RAG 检索。

GitHub Stars RAG 参照材料中的生产级 RAG 路线实现：

- Sync：后台任务使用 GitHub Stars API 同步用户 Stars 原始数据，前端展示进度并允许取消。
- Pagination：同步按 GitHub `Link` 响应头跟随下一页，`GITHUB_STARS_MAX_PAGES` 只作为安全上限。
- Store Raw：SQLite 持久化 raw repository JSON、README 和同步进度。
- Reset：支持重置全部 GitHub Stars 同步数据，也支持查看已同步数据并重置单个仓库索引。
- Embedding：对仓库元数据与 README chunk 生成 embedding，并写入本地 SQLite 向量库。
- Contextual Chunking：把仓库描述、语言、topics、stars、更新时间和 README 片段写入 chunk。
- Metadata-Filtered RAG：查询支持 `language:python`、`topic:rag`、`owner:xxx` 这类源头过滤。
- Hybrid Search RAG：搜索时不再调用 GitHub API，直接从本地数据库执行 BM25 search + vector search。
- Reranking RAG：先召回更大的候选集，再按查询词覆盖和仓库名命中二次排序。
- Corrective RAG：检索证据不足时拒绝生成无依据答案。

接口会返回 RAG 风格的答案草稿、引用来源、检索明细和 pipeline 信息；该能力依赖 GitHub OAuth token，邮箱密码账号未关联 GitHub 时不可用。

`GITHUB_STARS_SYNC_INTERVAL_MS` 控制 NestJS 定时同步间隔，默认 6 小时；设置为 `0` 可关闭自动同步。GitHub Stars 本地索引数据库位于 `apps/api/data/github_stars.sqlite`，不会提交到 Git。

GitHub Stars embedding 默认使用本地模型 `Qwen/Qwen3-Embedding-0.6B`。即使不创建 `apps/api/.env`，也会按这个本地模型生成向量：

```env
EMBEDDING_PROVIDER=local
LOCAL_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
LOCAL_EMBEDDING_CACHE_DIR=apps/api/data/models
```

如果需要切换为 Voyage text embeddings，可以显式配置：

```env
EMBEDDING_PROVIDER=voyage
VOYAGE_API_KEY="..."
VOYAGE_EMBEDDING_MODEL=voyage-4-lite
```

本地 embedding 依赖 `sentence-transformers`，需要先安装 `apps/api/requirements.txt`。如果本地模型文件不存在，服务会自动下载到 `LOCAL_EMBEDDING_CACHE_DIR`，默认是 `apps/api/data/models`。如果依赖未安装、网络不可用或模型下载失败，同步任务会失败并把错误展示到同步状态中，不会回退到 hash embedding。切换 provider 或 model 后需要重新同步 Stars，才能写入对应模型的新向量；搜索时只会加载当前 provider/model 对应的 chunk embedding。

构建前端：

```bash
pnpm run build:web
```

构建产物会输出到 `apps/web/dist`。本地开发以 TanStack Start dev server 为主；部署时应由前端运行时或反向代理承载 `apps/web`，并将 `/api` 指向 `apps/api` 服务。

只启动前端：

```bash
pnpm run dev:web
```

## CLI 运行

```bash
python3 rag_mvp.py "为什么生产级 RAG 需要混合搜索？"
```

也可以直接以包方式运行：

```bash
PYTHONPATH=packages/rag-core python3 -m rag_core "为什么生产级 RAG 需要混合搜索？"
```

查看检索明细：

```bash
python3 rag_mvp.py "重排序 RAG 解决什么问题？" --show-hits
```

指定知识库文件：

```bash
python3 rag_mvp.py "什么时候需要 SQL + Vector RAG？" --docs "从基础检索到生产级 AI 系统的 10 个 RAG 项目.md"
```

## MVP 边界

当前版本仍未接入外部 LLM，也没有使用独立向量数据库。文档知识库保持 BM25 + TF-IDF 本地检索；GitHub Stars 知识源默认使用本地 Qwen embedding，也可显式切换到 Voyage text embeddings，向量仍持久化在 SQLite 中。

## 代码结构

```text
apps/
  api/
    server.py           # FastAPI RAG 能力服务
    requirements.txt    # 后端依赖
  server/
    src/                # NestJS 业务服务：Better Auth、GitHub OAuth、RAG 转发
    data/               # Better Auth SQLite 数据库
  web/
    src/
      routes/           # TanStack Start 文件路由
      router.tsx        # Router 配置
      styles.css        # 页面样式
    vite.config.ts      # TanStack Start + Vite 配置
    package.json        # 前端依赖和脚本
packages/
  rag-core/
    rag_core/
      cli.py            # 命令行参数、文档加载编排、输出
      documents.py      # 文档发现和加载
      markdown.py       # Markdown 解析和分块
      tokenization.py   # 中英文分词和查询词处理
      retrieval.py      # BM25 + TF-IDF 混合检索索引
      answering.py      # 基于命中片段生成答案草稿和调试输出
      models.py         # Chunk、SearchHit 等共享数据模型
rag_mvp.py              # CLI 兼容入口，保留原运行方式
```

FastAPI 服务默认索引 `materials` 目录下的 Markdown 文件；CLI 默认递归索引当前目录里的 Markdown 文件，并跳过 README 类说明文档。需要精确指定知识库时继续使用 `--docs`。

后续可以按这个顺序演进：

1. 将 Markdown 文档知识库也接入可配置 embedding provider。
2. 将 SQLite 向量存储替换为 FAISS、pgvector 或 Elasticsearch。
3. 在 `build_answer` 后接入真实 LLM，并把命中的 chunk 作为上下文。
4. 增加检索质量评估和更完整的重排序器。
