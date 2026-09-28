from __future__ import annotations

import os
import io
import gzip
import signal
import subprocess
import tarfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def _run_script(
    script: str,
    env_file: Path,
    *,
    input_text: str = "",
    extra_env: dict[str, str] | None = None,
    args: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["ENV_FILE"] = str(env_file)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["bash", str(REPO_ROOT / "scripts" / script), *(args or [])],
        cwd=REPO_ROOT,
        env=env,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )


def test_destroy_rejects_an_unmarked_ancestor_without_touching_sentinel(tmp_path: Path) -> None:
    sentinel = tmp_path / "must-survive.txt"
    sentinel.write_text("preserve", encoding="utf-8")
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={tmp_path}\n"
        f"WORKER_WORK_ROOT={tmp_path / 'worker'}\n"
        "POSTGRES_DB=unused\n",
        encoding="utf-8",
    )

    result = _run_script("destroy-local.sh", env_file, input_text="y\n")

    assert result.returncode != 0
    assert sentinel.read_text(encoding="utf-8") == "preserve"


def test_destroy_rejects_dotdot_path_without_touching_target(tmp_path: Path) -> None:
    parent = tmp_path / "parent"
    target = parent / "target"
    target.mkdir(parents=True)
    sentinel = target / "must-survive.txt"
    sentinel.write_text("preserve", encoding="utf-8")
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={parent / 'target' / '..' / 'target'}\n"
        f"WORKER_WORK_ROOT={tmp_path / 'worker'}\n",
        encoding="utf-8",
    )

    result = _run_script("destroy-local.sh", env_file, input_text="y\n")

    assert result.returncode != 0
    assert sentinel.read_text(encoding="utf-8") == "preserve"


def test_start_rejects_existing_unmarked_data_root_without_adding_marker(tmp_path: Path) -> None:
    data_root = tmp_path / "existing-data"
    data_root.mkdir()
    sentinel = data_root / "must-survive.txt"
    sentinel.write_text("preserve", encoding="utf-8")
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={data_root}\n"
        f"WORKER_WORK_ROOT={tmp_path / 'worker'}\n"
        "START_FRONTEND=0\n",
        encoding="utf-8",
    )

    start_result = _run_script("start-local.sh", env_file, extra_env={"PATH": "/usr/bin:/bin"})
    destroy_result = _run_script("destroy-local.sh", env_file, input_text="y\n")

    assert start_result.returncode != 0
    assert "startup marker" in start_result.stderr
    assert not (data_root / ".infinity-agents-root").exists()
    assert destroy_result.returncode != 0
    assert sentinel.read_text(encoding="utf-8") == "preserve"


def test_start_marks_only_a_new_empty_root(tmp_path: Path) -> None:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    for command in ("pg_isready", "psql", "curl", "claude"):
        path = fake_bin / command
        path.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        path.chmod(0o700)
    fake_ps = fake_bin / "ps"
    fake_ps.write_text(
        "#!/usr/bin/env bash\n"
        "case \" $* \" in\n"
        "  *lstart=*) echo 'Mon Jan 1 00:00:00 2024' ;;\n"
        "  *) exit 0 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    fake_ps.chmod(0o700)
    fake_python = fake_bin / "python"
    fake_python.write_text(
        "#!/usr/bin/env bash\n"
        "case \" $* \" in\n"
        "  *\" -m backend.db_migrate \"*) exit 0 ;;\n"
        "  *\" -m uvicorn backend.app:app \"*) exec -a \"python -m uvicorn backend.app:app\" /bin/sleep 60 ;;\n"
        "  *) exit 0 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    fake_python.chmod(0o700)

    data_root = tmp_path / "new-data"
    work_root = tmp_path / "new-worker"
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={data_root}\n"
        f"WORKER_WORK_ROOT={work_root}\n"
        "START_FRONTEND=0\n"
        "WORKER_1_ID=\n"
        "WORKER_1_CREDENTIAL=\n",
        encoding="utf-8",
    )
    extra_env = {"PATH": f"{fake_bin}{os.pathsep}/usr/bin:/bin"}
    api_pid: int | None = None
    try:
        result = _run_script("start-local.sh", env_file, extra_env=extra_env)
        assert result.returncode == 0, result.stdout + result.stderr
        data_marker = data_root / ".infinity-agents-root"
        work_marker = work_root / ".infinity-agents-root"
        assert data_marker.read_text(encoding="utf-8").splitlines()[-1] == "kind=data"
        assert work_marker.read_text(encoding="utf-8").splitlines()[-1] == "kind=worker"
        api_pid = int((data_root / ".runtime" / "pids" / "api.pid").read_text(encoding="utf-8").splitlines()[0])
        os.kill(api_pid, signal.SIGKILL)
    finally:
        if api_pid is not None:
            try:
                os.kill(api_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def _write_data_root_with_objects(tmp_path: Path) -> tuple[Path, Path, Path]:
    data_root = tmp_path / "data"
    object_root = data_root / "objects"
    object_root.mkdir(parents=True)
    (data_root / ".infinity-agents-root").write_text(
        f"infinity-agents-root-v1\npath={data_root}\nkind=data\n",
        encoding="utf-8",
    )
    sentinel = tmp_path / "outside-sentinel.txt"
    sentinel.write_text("preserve", encoding="utf-8")
    return data_root, object_root, sentinel


def test_restore_rejects_archive_traversal_before_database_restore(tmp_path: Path) -> None:
    data_root, object_root, sentinel = _write_data_root_with_objects(tmp_path)
    (object_root / "existing.txt").write_text("keep", encoding="utf-8")
    archive = tmp_path / "objects.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        payload = b"must not escape"
        info = tarfile.TarInfo("objects/../../outside-sentinel.txt")
        info.size = len(payload)
        tar.addfile(info, io.BytesIO(payload))
    db_backup = tmp_path / "db.sql.gz"
    with gzip.open(db_backup, "wb") as stream:
        stream.write(b"SELECT 1;\n")
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={data_root}\n"
        f"LOCAL_OBJECT_ROOT={object_root}\n"
        "DATABASE_URL=postgresql://unused\n",
        encoding="utf-8",
    )

    result = _run_script(
        "restore-db.sh",
        env_file,
        input_text="y\n",
        args=[str(db_backup), str(archive)],
    )

    assert result.returncode != 0
    assert "archive" in result.stderr.lower()
    assert sentinel.read_text(encoding="utf-8") == "preserve"
    assert (object_root / "existing.txt").read_text(encoding="utf-8") == "keep"


def test_restore_rejects_archive_symlink_before_replacement(tmp_path: Path) -> None:
    data_root, object_root, sentinel = _write_data_root_with_objects(tmp_path)
    (object_root / "existing.txt").write_text("keep", encoding="utf-8")
    archive = tmp_path / "objects.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        directory = tarfile.TarInfo("objects")
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o700
        tar.addfile(directory)
        link = tarfile.TarInfo("objects/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "/"
        tar.addfile(link)
    db_backup = tmp_path / "db.sql.gz"
    with gzip.open(db_backup, "wb") as stream:
        stream.write(b"SELECT 1;\n")
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={data_root}\n"
        f"LOCAL_OBJECT_ROOT={object_root}\n"
        "DATABASE_URL=postgresql://unused\n",
        encoding="utf-8",
    )

    result = _run_script(
        "restore-db.sh",
        env_file,
        input_text="y\n",
        args=[str(db_backup), str(archive)],
    )

    assert result.returncode != 0
    assert "non-regular" in result.stderr
    assert sentinel.read_text(encoding="utf-8") == "preserve"
    assert (object_root / "existing.txt").read_text(encoding="utf-8") == "keep"


def test_restore_replaces_objects_only_after_safe_staging(tmp_path: Path) -> None:
    data_root, object_root, _sentinel = _write_data_root_with_objects(tmp_path)
    (object_root / "existing.txt").write_text("replace", encoding="utf-8")
    archive = tmp_path / "objects.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        directory = tarfile.TarInfo("objects")
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o700
        tar.addfile(directory)
        payload = b"restored"
        info = tarfile.TarInfo("objects/new.txt")
        info.size = len(payload)
        info.mode = 0o600
        tar.addfile(info, io.BytesIO(payload))
    db_backup = tmp_path / "db.sql.gz"
    with gzip.open(db_backup, "wb") as stream:
        stream.write(b"SELECT 1;\n")
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    fake_psql = fake_bin / "psql"
    fake_psql.write_text("#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n", encoding="utf-8")
    fake_psql.chmod(0o700)
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={data_root}\n"
        f"LOCAL_OBJECT_ROOT={object_root}\n"
        "DATABASE_URL=postgresql://unused\n",
        encoding="utf-8",
    )

    result = _run_script(
        "restore-db.sh",
        env_file,
        input_text="y\n",
        args=[str(db_backup), str(archive)],
        extra_env={"PATH": f"{fake_bin}{os.pathsep}/usr/bin:/bin"},
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert (object_root / "new.txt").read_text(encoding="utf-8") == "restored"
    assert not (object_root / "existing.txt").exists()
    assert not list(data_root.glob(".restore-*"))


def test_restore_database_failure_leaves_existing_objects_untouched(tmp_path: Path) -> None:
    data_root, object_root, _sentinel = _write_data_root_with_objects(tmp_path)
    (object_root / "existing.txt").write_text("keep", encoding="utf-8")
    archive = tmp_path / "objects.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        directory = tarfile.TarInfo("objects")
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o700
        tar.addfile(directory)
        payload = b"must not publish"
        info = tarfile.TarInfo("objects/new.txt")
        info.size = len(payload)
        info.mode = 0o600
        tar.addfile(info, io.BytesIO(payload))
    db_backup = tmp_path / "db.sql.gz"
    with gzip.open(db_backup, "wb") as stream:
        stream.write(b"SELECT 1;\n")
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    fake_psql = fake_bin / "psql"
    fake_psql.write_text("#!/usr/bin/env bash\ncat >/dev/null\nexit 1\n", encoding="utf-8")
    fake_psql.chmod(0o700)
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={data_root}\n"
        f"LOCAL_OBJECT_ROOT={object_root}\n"
        "DATABASE_URL=postgresql://unused\n",
        encoding="utf-8",
    )

    result = _run_script(
        "restore-db.sh",
        env_file,
        input_text="y\n",
        args=[str(db_backup), str(archive)],
        extra_env={"PATH": f"{fake_bin}{os.pathsep}/usr/bin:/bin"},
    )

    assert result.returncode != 0
    assert "Restore complete" not in result.stdout
    assert (object_root / "existing.txt").read_text(encoding="utf-8") == "keep"
    assert not (object_root / "new.txt").exists()
    assert not list(data_root.glob(".restore-*"))


def test_restore_rejects_truncated_database_backup_before_any_changes(tmp_path: Path) -> None:
    data_root, object_root, _sentinel = _write_data_root_with_objects(tmp_path)
    (object_root / "existing.txt").write_text("keep", encoding="utf-8")
    archive = tmp_path / "objects.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        directory = tarfile.TarInfo("objects")
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o700
        tar.addfile(directory)
        payload = b"must not publish"
        info = tarfile.TarInfo("objects/new.txt")
        info.size = len(payload)
        info.mode = 0o600
        tar.addfile(info, io.BytesIO(payload))
    db_backup = tmp_path / "db.sql.gz"
    with gzip.open(db_backup, "wb") as stream:
        stream.write(b"SELECT 1;\n")
    db_backup.write_bytes(db_backup.read_bytes()[:-8])
    db_state = tmp_path / "db-state.txt"
    db_state.write_text("keep", encoding="utf-8")
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    fake_psql = fake_bin / "psql"
    fake_psql.write_text(
        '#!/usr/bin/env bash\n'
        'printf changed > "$DB_STATE"\n'
        "cat >/dev/null\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake_psql.chmod(0o700)
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={data_root}\n"
        f"LOCAL_OBJECT_ROOT={object_root}\n"
        "DATABASE_URL=postgresql://unused\n",
        encoding="utf-8",
    )

    result = _run_script(
        "restore-db.sh",
        env_file,
        input_text="y\n",
        args=[str(db_backup), str(archive)],
        extra_env={
            "DB_STATE": str(db_state),
            "PATH": f"{fake_bin}{os.pathsep}/usr/bin:/bin",
        },
    )

    assert result.returncode != 0
    assert "complete gzip" in result.stderr
    assert db_state.read_text(encoding="utf-8") == "keep"
    assert (object_root / "existing.txt").read_text(encoding="utf-8") == "keep"
    assert not (object_root / "new.txt").exists()
    assert not list(data_root.glob(".restore-*"))


def test_backup_rejects_output_inside_marked_data_root(tmp_path: Path) -> None:
    data_root, object_root, _sentinel = _write_data_root_with_objects(tmp_path)
    (object_root / "input.txt").write_text("data", encoding="utf-8")
    env_file = tmp_path / "env"
    env_file.write_text(
        f"LOCAL_DATA_ROOT={data_root}\n"
        f"LOCAL_OBJECT_ROOT={object_root}\n"
        f"BACKUP_DIR={data_root / 'backups'}\n",
        encoding="utf-8",
    )

    result = _run_script("backup-db.sh", env_file)

    assert result.returncode != 0
    assert "BACKUP_DIR" in result.stderr
    assert not (data_root / "backups").exists()


def test_stop_does_not_kill_a_pid_file_with_wrong_identity(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    data_root.mkdir()
    marker = data_root / ".infinity-agents-root"
    marker.write_text(
        f"infinity-agents-root-v1\npath={data_root}\nkind=data\n",
        encoding="utf-8",
    )
    pid_dir = data_root / ".runtime" / "pids"
    pid_dir.mkdir(parents=True)

    child = subprocess.Popen(["sleep", "10"])
    try:
        (pid_dir / "api.pid").write_text(f"{child.pid}\nnot-the-process-start\n", encoding="utf-8")
        env_file = tmp_path / "env"
        env_file.write_text(f"LOCAL_DATA_ROOT={data_root}\n", encoding="utf-8")

        result = _run_script("stop-local.sh", env_file)

        assert result.returncode == 0
        assert child.poll() is None
    finally:
        child.terminate()
        child.wait(timeout=5)
