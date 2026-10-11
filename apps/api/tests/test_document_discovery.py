from rag_core.documents import default_docs


def test_discovery_ignores_dependencies_and_build_artifacts(tmp_path):
    for directory in [
        "apps/api/.venv/lib/package", "node_modules/package", "build",
        "dist", ".git", "package.egg-info",
    ]:
        path = tmp_path / directory
        path.mkdir(parents=True)
        (path / "third-party.md").write_text("This is not knowledge-base content.")
    materials = tmp_path / "materials"
    materials.mkdir()
    guide = materials / "guide.md"
    guide.write_text("# Knowledge\nReal source content.")
    (materials / "README.md").write_text("Project setup instructions.")
    assert default_docs(tmp_path) == [guide]
