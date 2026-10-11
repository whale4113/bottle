#!/usr/bin/env bash
# Use the API's isolated interpreter without requiring shell activation.
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
python_version="$(tr -d '[:space:]' < .python-version)"
venv_dir="$repo_dir/apps/api/.venv"
venv_python="$venv_dir/bin/python"

if [[ "${1:-}" == "setup" ]]; then
  pyenv_command="$(command -v pyenv || true)"
  if [[ -z "$pyenv_command" && -x "${PYENV_ROOT:-$HOME/.pyenv}/bin/pyenv" ]]; then
    pyenv_command="${PYENV_ROOT:-$HOME/.pyenv}/bin/pyenv"
  fi
  if [[ -z "$pyenv_command" ]]; then
    echo '未找到 pyenv。请先按 apps/api/README.md 安装 pyenv，再执行 pnpm run setup:api。' >&2
    exit 1
  fi
  "$pyenv_command" install -s "$python_version"
  base_python="$(PYENV_VERSION="$python_version" "$pyenv_command" which python)"
  if [[ ! -e "$venv_dir" ]]; then
    "$base_python" -m venv "$venv_dir"
  fi
fi

if [[ ! -x "$venv_python" ]]; then
  echo 'API 虚拟环境不存在或不完整，请先执行 pnpm run setup:api。' >&2
  exit 1
fi
actual_version="$("$venv_python" -c 'import platform; print(platform.python_version())')"
if [[ "$actual_version" != "$python_version" ]]; then
  echo "API 虚拟环境使用 Python $actual_version，项目要求 $python_version。请移走 apps/api/.venv 后执行 pnpm run setup:api。" >&2
  exit 1
fi

export VIRTUAL_ENV="$venv_dir"
export PATH="$venv_dir/bin:$PATH"

if [[ "${1:-}" == "setup" ]]; then
  "$venv_python" -m pip install --upgrade pip
  "$venv_python" -m pip install -r apps/api/requirements.lock
  "$venv_python" -m pip check
  echo "API 环境已就绪：$venv_python (Python $actual_version)"
else
  exec "$venv_python" "$@"
fi
