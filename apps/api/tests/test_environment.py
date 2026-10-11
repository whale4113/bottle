"""Verify that commands cannot silently fall back to the system interpreter."""

import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]


def copy_runner(root: Path) -> Path:
    scripts = root / "scripts"
    scripts.mkdir()
    runner = scripts / "python.sh"
    runner.write_text((REPO_ROOT / "scripts" / "python.sh").read_text())
    (root / ".python-version").write_text("0.0.0\n")
    return runner


def test_missing_environment_requires_setup(tmp_path):
    runner = copy_runner(tmp_path)
    result = subprocess.run(["bash", str(runner), "-V"], capture_output=True, text=True)
    assert result.returncode == 1
    assert "pnpm run setup:api" in result.stderr


def test_wrong_python_version_is_rejected(tmp_path):
    runner = copy_runner(tmp_path)
    binaries = tmp_path / "apps" / "api" / ".venv" / "bin"
    binaries.mkdir(parents=True)
    (binaries / "python").symlink_to(sys.executable)
    result = subprocess.run(["bash", str(runner), "-V"], capture_output=True, text=True)
    assert result.returncode == 1
    assert "项目要求 0.0.0" in result.stderr


def test_installed_packages_import_without_repository_on_sys_path(tmp_path):
    result = subprocess.run(
        [sys.executable, "-I", "-c", "import rag_api, rag_core"],
        cwd=tmp_path, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr


def test_runner_uses_isolated_environment_from_another_directory(tmp_path):
    result = subprocess.run(
        ["bash", str(REPO_ROOT / "scripts" / "python.sh"), "-c",
         "import os, shutil, sys; "
         "assert sys.prefix != sys.base_prefix; "
         "assert os.environ['VIRTUAL_ENV'] == sys.prefix; "
         "assert shutil.which('python') == sys.executable"],
        cwd=tmp_path, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
