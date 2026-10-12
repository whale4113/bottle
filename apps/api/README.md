# Python API 开发

Python 版本由仓库根目录的 `.python-version` 固定，pyenv 管理解释器，
`apps/api/.venv` 隔离依赖。启动脚本直接调用虚拟环境中的 Python，不需要先 `activate`。
当前脚本支持 Linux / macOS / WSL 的 Bash 环境。

## 首次初始化

先按 [pyenv 安装文档](https://github.com/pyenv/pyenv#installation) 安装 pyenv，
并按文档安装操作系统的 Python 编译依赖。
如果尚未安装 pyenv，可以从官方仓库安装：

```bash
git clone https://github.com/pyenv/pyenv.git ~/.pyenv
```

在 `~/.bashrc`（Zsh 使用 `~/.zshrc`）中添加：

```bash
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
```

重新打开终端，在仓库根目录运行：

```bash
pnpm run setup:api
```

此命令会安装 `.python-version` 指定的 Python、创建 `.venv`，
以 editable 模式安装 `rag-core` 和 API（含测试依赖），最后运行 `pip check`。
也可直接执行 `bash scripts/python.sh setup`，无需先安装 Node 依赖。
脚本可识别 PATH 中的 pyenv，以及 `${PYENV_ROOT:-$HOME/.pyenv}/bin/pyenv`。

如果提示 pyenv 不支持项目要求的版本或 `definition not found`，需要更新 pyenv 的安装定义。
Homebrew 安装执行 `brew update && brew upgrade pyenv`；Git 安装执行
`git -C "${PYENV_ROOT:-$HOME/.pyenv}" pull`。更新后重新执行 `pnpm run setup:api`。

已有环境会复用，不会被自动删除。Python 版本变更后，先移走旧 `.venv`，再重新初始化。
依赖版本范围声明在两个 Python 包的 `pyproject.toml` 中；`requirements.lock` 固定直接及传递依赖版本，初始化默认按锁文件安装。
锁文件包含平台条件，当前已在 Linux + Python 3.12 上验证。
`requirements.txt` 是锁文件的输入，两个文件都须从仓库根目录使用。
修改依赖后，可用维护工具 uv 重新生成锁文件（日常启动不需要 uv）：

```bash
uv pip compile --python apps/api/.venv/bin/python --python-version 3.12 --universal \
  apps/api/requirements.txt --output-file apps/api/requirements.lock --upgrade
pnpm run setup:api
```

本地模型所需的 `sentence-transformers` / PyTorch 依赖较大，首次安装需要网络和足够磁盘空间。

## 开发与检查

```bash
pnpm run dev:api      # 监听 API 与 rag-core 代码变更，端口 8787
pnpm run api          # 不启用 reload
pnpm run check:api    # 项目 Python 文件语法检查，排除虚拟环境
pnpm run test:api     # 临时文档与数据库上的 API 冒烟测试
pnpm run cli "为什么需要混合检索？"
```

Python API 采用 `src/rag_api` 包结构，入口为 `rag_api.server:app`。
`rag-core` 通过正常包安装导入，不再依赖 API 修改 `sys.path`。
editable 安装会直接使用本地源码；当前服务仍依赖本仓库的 `materials`、`.env` 和数据目录，
应在仓库检出目录中运行。

应用配置位于 `apps/api/.env`，可复制 `.env.example` 后编辑。
默认文档位于 `materials`，数据位于 `apps/api/data`。

## VS Code

命令面板执行 `Tasks: Run Task` → `初始化：Python API 环境`，完成后使用 `启动全部服务`。
API 任务始终调用 `.venv` 的 Python，与终端是否激活虚拟环境无关。
工作区设置已配置解释器和 pytest；若以前手动选择过其他解释器，
执行 `Python: Select Interpreter`，选择 `apps/api/.venv/bin/python`。

本地嵌入模型在 macOS 默认使用 CPU，避免 PyTorch MPS 原生崩溃导致 API 进程退出。
可通过 API 的 `LOCAL_EMBEDDING_DEVICE` 显式选择设备；其他系统默认自动检测。
NestJS 的 `RAG_API_TIMEOUT_MS` 控制 Python 请求超时（默认 120000 毫秒），连接失败时返回 503，GET 请求最多重试一次。

搜索使用 `SEARCH_MIN_SCORE` 配置最终 score 的最低阈值（默认 `0.5`）。
本地文档与 GitHub Stars 均只返回 `score >= 阈值` 的结果，引用和回答上下文同步过滤；
全部低于阈值时返回空结果和未找到相关上下文的提示。score 是混合排序分数，不是概率。

搜索性能：CPU 模型使用 float32，避免 Apple CPU 上 bfloat16 软件矩阵运算的高开销。
模型优先使用已下载的本地缓存，缺失时才访问网络；首次搜索按批次计算本地文档向量，
相同配置和查询的向量在进程内复用（最多 128 条）。页面会先显示已完成的数据源结果。

嵌入输入默认统一清理换行、多余空白、零宽字符和正文 HTML 注释，保留代码缩进及代码中的注释。
原始文档、检索片段和引用不被改写，处理后的文本仅用于生成向量。

在个人 Settings 的 LLM model 中配置共享模型；Answer generation 和 Embedding source summaries 分别控制回答与文档总结，没有全局 LLM 开关，互不依赖。任意功能开启时都需要有效的模型配置。按场景编辑 GitHub 或本地文档提示词。旧 enabled 字段仅兼容回答开关，新客户端使用 answer_enabled。
预处理会生成不超过 100 个英文单词的纯文本摘要，再用摘要生成向量；原文用于展示和引用。
摘要不得包含链接、HTML 或 Markdown。调用失败或无效输出时回退到清理后的原文。
提示词、场景、原文和 LLM 配置共同决定缓存；修改配置会使后续处理使用新摘要。
默认关闭摘要功能，启用后会增加首次处理耗时和 LLM 费用，并向配置的 LLM 服务发送待摘要内容。
旧的 `EMBEDDING_LLM_FILTER_ENABLED` 环境开关不再使用，改为个人配置。
旧 GitHub 索引需在 Library 删除对应索引并重新导入；普通导入仍会跳过已存在的兼容索引。

启用摘要时，GitHub README 和本地文档先按整篇内容生成摘要，再检查摘要是否超过 1200 字符。
短摘要只生成一个向量，超长摘要才按 1200 字符、160 字符重叠拆分。摘要失败时回退原文分块。
Library 每个仓库和文档提供 View embeddings：可查看实际输入、原文、模型、维度和完整向量，按 20 个分块分页。
GitHub 嵌入持久保存；本地文档向量在搜索后进入用户隔离的内存缓存，重启或缓存淘汰后需重新搜索。
已有 GitHub 索引需重新导入才能使用整篇摘要策略。

混合检索采用 80% Vector Search、20% BM25 Search 的分数融合。正余弦相似度 s 使用固定映射 2.2s/(1+1.2s)，BM25 除以当前候选最高分后融合；保留关键词覆盖和标识符精确匹配加分。最终 score 是融合检索分数，不是原始余弦相似度或相关概率；SEARCH_MIN_SCORE 在融合后过滤。
语义分数不按当前候选最大值归一化，也不使用排名冒充相关性，避免无关查询的第一名自动获得高分。权重调整无需重建索引；更换嵌入模型后应重新评估阈值。

Qwen3-Embedding 查询使用任务检索指令（本地及 OpenAI-compatible 接口），文档保持无指令编码。指令侧重软件仓库与技术文档的主题、功能及使用场景，避免将查询当作普通文本比较。查询编码调整不改变已有文档向量，无需重新导入；模型名称需符合 Qwen3-Embedding 系列名称才能自动应用。分数映射为启发式，默认 0.5 阈值下纯语义命中约需余弦相似度 0.431；不同模型及数据集仍应独立评估阈值。

配置 LLM 模型后，搜索默认启用查询意图重排，可在 Settings 的 Search relevance 单独关闭，与回答和文档总结无关。混合检索先过滤低分候选，再最多向 LLM 发送 20 个候选（优先使用嵌入摘要，每条限制约 3000 字符），一次批量重排后再次应用 SEARCH_MIN_SCORE 并取 Top K。重排分数是模型对查询意图相关性的判断，不是余弦相似度；通过阈值的结果必须附带可在候选正文核对的原文证据。成功响应缓存最多 128 组，模型请求最多等待 5 秒；未配置模型、调用失败或结果格式无效时回退混合排序。首次搜索会增加 LLM 请求、延迟和可能的服务费用，不保证所有误召回都能消除。
