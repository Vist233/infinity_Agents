"""pytest 共享 fixtures：独立 SQLite 测试库与样本输出。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps" / "desktop"
if str(DESKTOP) not in sys.path:
    sys.path.insert(0, str(DESKTOP))

FIXTURES = ROOT / "tests" / "fixtures"


@pytest.fixture()
def repo(tmp_path):
    """每个用例独立的 SQLite 数据库 + Repository。"""
    from imagejudge.persistence.db import init_db
    from imagejudge.persistence.repository import Repository

    db_path = tmp_path / "test.db"
    init_db(db_path)
    return Repository(db_path)


@pytest.fixture()
def sample_output() -> dict:
    return json.loads((FIXTURES / "sample_evaluation_output.json").read_text(encoding="utf-8"))


@pytest.fixture()
def sample_output_text(sample_output) -> str:
    return json.dumps(sample_output, ensure_ascii=False)


@pytest.fixture()
def run_with_items(repo, tmp_path):
    """创建一个 DRAFT run 并插入 3 个 PENDING 项。"""
    project_id = repo.create_project(
        name="测试项目",
        reference_path=str(tmp_path / "reference.jpg"),
        reference_sha256="0" * 64,
        prompt_text="判断目标图是否符合参考图特征",
        prompt_version="2.0",
        model_id="qwen3-vl-235b-a22b-instruct",
    )
    run_id = repo.create_run(
        project_id=project_id,
        input_type="folder",
        input_path=str(tmp_path / "inputs"),
        recursive=False,
        output_dir=str(tmp_path / "output"),
        csv_name="results_live.csv",
        timeout_seconds=120.0,
        max_retries=2,
    )
    items = [
        {"path": str(tmp_path / "inputs" / f"img{i}.jpg"), "relative_path": f"img{i}.jpg", "sha256": f"{i}" * 64}
        for i in range(1, 4)
    ]
    repo.insert_items(run_id, items)
    return run_id
