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
