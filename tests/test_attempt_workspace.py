from __future__ import annotations

import sys
from pathlib import Path

import pytest

from backend.code_agent.worker.attempt_workspace import (
    ATTEMPT_MARKER_NAME,
    create_attempt_root,
    ensure_work_root,
    prepare_attempt_workspace,
    safe_remove_attempt,
    validate_claude_command,
)
from backend.security import SecurityBoundaryError


def test_attempt_is_a_marked_direct_child_and_uses_canonical_paths(tmp_path, monkeypatch):
    work_root = tmp_path / "worker-root"
    monkeypatch.setenv("CLAUDE_CLI_PATH", sys.executable)
    attempt = create_attempt_root(work_root, "task-1", "attempt-1")

    workspace = prepare_attempt_workspace(work_root, attempt / "input", attempt / "output")

    assert workspace.attempt_root == work_root.resolve() / "attempt-1"
    assert workspace.cwd == workspace.work_dir
    assert (attempt / ATTEMPT_MARKER_NAME).is_file()
    assert workspace.claude_path == Path(sys.executable).resolve()
    assert validate_claude_command(workspace, [str(workspace.claude_path), "--print"])[0] == str(workspace.claude_path)


def test_attempt_paths_cannot_escape_or_use_symlinks(tmp_path, monkeypatch):
    work_root = tmp_path / "worker-root"
    monkeypatch.setenv("CLAUDE_CLI_PATH", sys.executable)
    attempt = create_attempt_root(work_root, "task-2", "attempt-2")
    input_dir = attempt / "input"
    output_dir = attempt / "output"

    with pytest.raises(SecurityBoundaryError):
        prepare_attempt_workspace(work_root, work_root / "outside" / "input", output_dir)

    outside = tmp_path / "outside"
    outside.mkdir()
    escaped_input = attempt / "input-link"
    try:
        escaped_input.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symbolic links are unavailable on this host")
    with pytest.raises(SecurityBoundaryError):
        prepare_attempt_workspace(work_root, escaped_input / "input", output_dir)

    with pytest.raises(SecurityBoundaryError):
        prepare_attempt_workspace(work_root, input_dir, work_root.parent / "output")


def test_cleanup_requires_a_marked_attempt_and_preserves_external_sentinel(tmp_path):
    work_root = tmp_path / "worker-root"
    attempt = create_attempt_root(work_root, "task-3", "attempt-3")
    (attempt / "output").mkdir()
    sentinel = tmp_path / "sentinel.txt"
    sentinel.write_text("keep", encoding="utf-8")

    safe_remove_attempt(work_root, attempt)

    assert not attempt.exists()
    assert sentinel.read_text(encoding="utf-8") == "keep"

    unmarked = work_root / "unmarked"
    unmarked.mkdir()
    with pytest.raises(SecurityBoundaryError):
        safe_remove_attempt(work_root, unmarked)


def test_cleanup_restores_read_only_input_and_spec_directories(tmp_path, monkeypatch):
    work_root = tmp_path / "worker-root"
    monkeypatch.setenv("CLAUDE_CLI_PATH", sys.executable)
    attempt = create_attempt_root(work_root, "task-readonly", "attempt-readonly")
    input_dir = attempt / "input"
    spec_dir = attempt / "spec"
    nested_input = input_dir / "nested"
    nested_spec = spec_dir / "method_sources"
    nested_input.mkdir(parents=True)
    nested_spec.mkdir(parents=True)
    (nested_input / "method.md").write_text("method", encoding="utf-8")
    (nested_spec / "task_spec.json").write_text("{}", encoding="utf-8")

    if sys.platform != "win32":
        for directory in (input_dir, nested_input, spec_dir, nested_spec):
            directory.chmod(0o555)
        for file_path in (nested_input / "method.md", nested_spec / "task_spec.json"):
            file_path.chmod(0o444)

    safe_remove_attempt(work_root, attempt)

    assert not attempt.exists()


def test_work_root_must_be_absolute_and_not_a_symlink(tmp_path):
    with pytest.raises(SecurityBoundaryError):
        ensure_work_root("relative-worker-root")

    target = tmp_path / "real-root"
    target.mkdir()
    link = tmp_path / "linked-root"
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symbolic links are unavailable on this host")
    with pytest.raises(SecurityBoundaryError):
        ensure_work_root(link)
