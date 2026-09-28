"""Cross-platform application-level workspace policy for the local Worker.

Every claimed attempt gets one directory below ``WORKER_WORK_ROOT``.  The
Worker validates and creates all application-managed paths through this module
and starts Claude with that attempt as its working directory and with a small
environment.

This is deliberately not an operating-system sandbox.  A Claude tool, shell
command, or child process still runs with the current user's permissions and
can access paths outside the attempt.  The policy protects the Worker-owned
file operations, archive collection, and cleanup logic; it must not be
described as a guarantee against malicious commands or symlink races.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from backend.security import SecurityBoundaryError


_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$")
_PATH_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
ATTEMPT_MARKER_NAME = ".infinity-worker-attempt.json"


class WorkerRuntimeUnavailableError(SecurityBoundaryError):
    """Raised when the configured local runtime cannot be used."""


@dataclass(frozen=True)
class AttemptWorkspace:
    """Canonical directories owned by one Worker attempt."""

    work_root: Path
    attempt_root: Path
    input_dir: Path
    spec_dir: Path
    work_dir: Path
    output_dir: Path
    logs_dir: Path
    home_dir: Path
    tmp_dir: Path
    claude_path: Path

    @property
    def cwd(self) -> Path:
        return self.work_dir


def _raw_absolute(value: str | Path, label: str) -> Path:
    raw = Path(os.path.expanduser(str(value)))
    if not raw.is_absolute():
        raise SecurityBoundaryError(f"{label} must be an absolute path")
    if any(component in {".", ".."} for component in raw.parts):
        raise SecurityBoundaryError(f"{label} must not contain . or .. path components")
    if _PATH_CONTROL.search(str(raw)):
        raise SecurityBoundaryError(f"{label} contains control characters")
    return raw


def _assert_no_symlink_components(path: Path, *, label: str) -> None:
    """Reject existing symlink components before resolving a managed path."""

    current = Path(path.anchor)
    for component in path.parts:
        if component == path.anchor:
            continue
        current /= component
        try:
            if current.is_symlink():
                raise SecurityBoundaryError(f"{label} contains a symbolic link")
        except OSError as exc:
            raise SecurityBoundaryError(f"{label} could not be inspected") from exc


def _canonical(value: str | Path, label: str) -> Path:
    raw = _raw_absolute(value, label)
    try:
        resolved = raw.resolve(strict=False)
    except OSError as exc:
        raise SecurityBoundaryError(f"{label} could not be resolved") from exc
    if not resolved.is_absolute():
        raise SecurityBoundaryError(f"{label} did not resolve to an absolute path")
    return resolved


def _set_private_mode(path: Path) -> None:
    # Windows does not implement POSIX mode bits.  The directory is still
    # checked for accessibility below; on POSIX, keep Worker roots private.
    if os.name != "nt":
        try:
            os.chmod(path, 0o700)
        except OSError as exc:
            raise SecurityBoundaryError(f"could not set private permissions on {path}") from exc


def _assert_managed_directory(path: Path, *, label: str) -> None:
    try:
        info = path.lstat()
    except OSError as exc:
        raise SecurityBoundaryError(f"{label} is unavailable") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SecurityBoundaryError(f"{label} must be a real directory")
    if not os.access(path, os.R_OK | os.W_OK | os.X_OK):
        raise SecurityBoundaryError(f"{label} is not accessible by the Worker user")
    if os.name != "nt" and hasattr(os, "getuid"):
        if info.st_uid != os.getuid():
            raise SecurityBoundaryError(f"{label} is not owned by the Worker user")
        if info.st_mode & 0o077:
            raise SecurityBoundaryError(f"{label} must not be group/world accessible")


def ensure_work_root(value: str | Path) -> Path:
    """Create and validate the one fixed Worker work root."""

    raw = _raw_absolute(value, "WORKER_WORK_ROOT")
    _assert_no_symlink_components(raw, label="WORKER_WORK_ROOT")
    root = _canonical(raw, "WORKER_WORK_ROOT")
    try:
        root.mkdir(parents=True, mode=0o700, exist_ok=True)
        _set_private_mode(root)
    except OSError as exc:
        raise SecurityBoundaryError("WORKER_WORK_ROOT could not be created") from exc
    _assert_no_symlink_components(root, label="WORKER_WORK_ROOT")
    _assert_managed_directory(root, label="WORKER_WORK_ROOT")
    return root


def _safe_component(value: str, label: str) -> str:
    candidate = str(value or "")
    if not _SAFE_COMPONENT.fullmatch(candidate) or candidate in {".", ".."}:
        raise SecurityBoundaryError(f"{label} is not a safe workspace component")
    return candidate


def _ensure_directory(path: Path, *, label: str) -> Path:
    _assert_no_symlink_components(path, label=label)
    try:
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
        _set_private_mode(path)
    except OSError as exc:
        raise SecurityBoundaryError(f"{label} could not be created") from exc
    _assert_no_symlink_components(path, label=label)
    _assert_managed_directory(path, label=label)
    return path


def _marker_path(attempt_root: Path) -> Path:
    return attempt_root / ATTEMPT_MARKER_NAME


def _write_or_validate_marker(attempt_root: Path, task_id: str, attempt_id: str) -> None:
    marker = _marker_path(attempt_root)
    if marker.exists() or marker.is_symlink():
        if marker.is_symlink() or not marker.is_file():
            raise SecurityBoundaryError("attempt ownership marker is invalid")
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as exc:
            raise SecurityBoundaryError("attempt ownership marker is unreadable") from exc
        if payload.get("task_id") != task_id or payload.get("attempt_id") != attempt_id:
            raise SecurityBoundaryError("attempt directory belongs to another task")
        return
    payload = {"version": 1, "task_id": task_id, "attempt_id": attempt_id}
    try:
        with marker.open("x", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True)
            stream.write("\n")
        if os.name != "nt":
            os.chmod(marker, 0o600)
    except FileExistsError:
        _write_or_validate_marker(attempt_root, task_id, attempt_id)
    except OSError as exc:
        raise SecurityBoundaryError("could not create attempt ownership marker") from exc


def create_attempt_root(work_root: str | Path, task_id: str, attempt_id: str) -> Path:
    """Create ``WORKER_WORK_ROOT/<attempt-id>`` and record its ownership."""

    root = ensure_work_root(work_root)
    # Validate task_id too, even though only the server-generated attempt ID
    # is used in the filesystem path. This prevents malformed claims from
    # reaching later prompt or log code.
    _safe_component(task_id, "task ID")
    attempt_component = _safe_component(attempt_id, "attempt ID")
    attempt_root = root / attempt_component
    if not attempt_root.is_relative_to(root):
        raise SecurityBoundaryError("attempt workspace escaped WORKER_WORK_ROOT")
    _ensure_directory(attempt_root, label="attempt workspace")
    _write_or_validate_marker(attempt_root, task_id, attempt_id)
    return attempt_root


def _validate_attempt_paths(
    work_root: Path,
    input_dir_value: str | Path,
    output_dir_value: str | Path,
) -> tuple[Path, Path, Path]:
    input_raw = _raw_absolute(input_dir_value, "Worker input directory")
    output_raw = _raw_absolute(output_dir_value, "Worker output directory")
    if input_raw.name != "input" or output_raw.name != "output":
        raise SecurityBoundaryError("Worker task paths must use input/output attempt directories")
    _assert_no_symlink_components(input_raw, label="Worker input directory")
    _assert_no_symlink_components(output_raw, label="Worker output directory")
    if input_raw.parent != output_raw.parent:
        raise SecurityBoundaryError("Worker input and output must share one attempt root")
    attempt_root = _canonical(input_raw.parent, "attempt workspace")
    input_dir = _canonical(input_raw, "Worker input directory")
    output_dir = _canonical(output_raw, "Worker output directory")
    try:
        relative_attempt = attempt_root.relative_to(work_root)
        input_dir.relative_to(attempt_root)
        output_dir.relative_to(attempt_root)
    except ValueError as exc:
        raise SecurityBoundaryError("Worker attempt paths escaped WORKER_WORK_ROOT") from exc
    if len(relative_attempt.parts) != 1:
        raise SecurityBoundaryError("Worker attempt must be a direct child of WORKER_WORK_ROOT")
    if input_dir.parent != attempt_root or output_dir.parent != attempt_root:
        raise SecurityBoundaryError("Worker input/output escaped the attempt workspace")
    return attempt_root, input_dir, output_dir


def _claude_path() -> Path:
    configured = os.getenv("CLAUDE_CLI_PATH", "claude").strip() or "claude"
    candidate = Path(configured)
    if not candidate.is_absolute():
        found = shutil.which(configured)
        if not found:
            raise WorkerRuntimeUnavailableError("Claude Code CLI was not found")
        candidate = Path(found)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise WorkerRuntimeUnavailableError("Claude Code CLI could not be resolved") from exc
    if not resolved.is_file():
        raise WorkerRuntimeUnavailableError("Claude Code CLI is not a regular file")
    if os.name != "nt" and not (resolved.stat().st_mode & 0o111):
        raise WorkerRuntimeUnavailableError("Claude Code CLI is not executable")
    return resolved


def prepare_attempt_workspace(
    work_root: str | Path,
    input_dir: str | Path,
    output_dir: str | Path,
) -> AttemptWorkspace:
    """Validate one server-created attempt and prepare its child directories."""

    root = ensure_work_root(work_root)
    attempt_root, input_path, output_path = _validate_attempt_paths(root, input_dir, output_dir)
    _ensure_directory(attempt_root, label="attempt workspace")
    marker = _marker_path(attempt_root)
    if not marker.is_file() or marker.is_symlink():
        raise SecurityBoundaryError("attempt ownership marker is missing")
    input_path = _ensure_directory(input_path, label="attempt input directory")
    output_path = _ensure_directory(output_path, label="attempt output directory")
    spec_dir = _ensure_directory(attempt_root / "spec", label="attempt spec directory")
    work_dir = _ensure_directory(attempt_root / "work", label="attempt work directory")
    logs_dir = _ensure_directory(attempt_root / "logs", label="attempt log directory")
    home_dir = _ensure_directory(attempt_root / "home", label="attempt home directory")
    tmp_dir = _ensure_directory(attempt_root / "tmp", label="attempt temp directory")
    return AttemptWorkspace(
        work_root=root,
        attempt_root=attempt_root,
        input_dir=input_path,
        spec_dir=spec_dir,
        work_dir=work_dir,
        output_dir=output_path,
        logs_dir=logs_dir,
        home_dir=home_dir,
        tmp_dir=tmp_dir,
        claude_path=_claude_path(),
    )


def validate_claude_command(context: AttemptWorkspace, command: Sequence[str]) -> list[str]:
    """Validate and return a direct, non-shell Claude command.

    No OS-specific wrapper or sandbox is added here. The name is intentionally
    explicit so callers do not mistake this application policy for isolation.
    """

    values = [str(item) for item in command]
    if not values or values[0] != str(context.claude_path):
        raise SecurityBoundaryError("Worker must launch the configured Claude executable directly")
    if any("\x00" in value for value in values):
        raise SecurityBoundaryError("Worker command contains a NUL byte")
    return values


def safe_remove_attempt(work_root: str | Path, attempt_path: str | Path) -> None:
    """Remove only a marked direct child attempt below the fixed work root."""

    root = ensure_work_root(work_root)
    raw = _raw_absolute(attempt_path, "attempt cleanup path")
    _assert_no_symlink_components(raw, label="attempt cleanup path")
    resolved = _canonical(raw, "attempt cleanup path")
    try:
        relative = resolved.relative_to(root)
    except ValueError as exc:
        raise SecurityBoundaryError("attempt cleanup path escaped WORKER_WORK_ROOT") from exc
    if len(relative.parts) != 1 or resolved == root:
        raise SecurityBoundaryError("cleanup is allowed only for one attempt directory")
    _assert_managed_directory(resolved, label="attempt cleanup directory")
    marker = _marker_path(resolved)
    if marker.is_symlink() or not marker.is_file():
        raise SecurityBoundaryError("refusing to remove an unmarked attempt directory")
    # Claude deliberately receives read-only input/spec trees. On POSIX,
    # removing a file requires write permission on its containing directory,
    # so restore only directory owner permissions after the full attempt
    # boundary has been checked. The traversal never follows child symlinks;
    # ``rmtree`` will unlink such a child rather than traversing it.
    directories = [resolved]
    for current, child_names, _file_names in os.walk(resolved, topdown=True, followlinks=False):
        current_path = Path(current)
        for child_name in list(child_names):
            child = current_path / child_name
            try:
                info = child.lstat()
            except OSError as exc:
                raise OSError(f"could not inspect attempt cleanup directory: {child}") from exc
            if stat.S_ISLNK(info.st_mode):
                child_names.remove(child_name)
                continue
            if not stat.S_ISDIR(info.st_mode):
                child_names.remove(child_name)
                continue
            try:
                child.relative_to(resolved)
            except ValueError as exc:
                raise SecurityBoundaryError("attempt cleanup directory escaped the attempt root") from exc
            directories.append(child)
    if os.name != "nt":
        for directory in directories:
            try:
                info = directory.lstat()
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                    raise SecurityBoundaryError("attempt cleanup directory changed during permission recovery")
                os.chmod(directory, stat.S_IMODE(info.st_mode) | stat.S_IRWXU)
            except SecurityBoundaryError:
                raise
            except OSError as exc:
                raise OSError(f"could not make attempt cleanup directory writable: {directory}") from exc
    # shutil.rmtree does not follow child directory symlinks. The boundary is
    # rechecked immediately before deletion, but concurrent replacement cannot
    # be eliminated without an OS-level sandbox or descriptor-based removal.
    shutil.rmtree(resolved)
