from pathlib import Path
from unittest.mock import Mock


def test_runner_binds_session_workspace_and_cleans_up(monkeypatch, tmp_path):
    from agent import paperAgent as paper_agent_module

    captured = {}
    fake_agent = Mock()
    fake_session_repo = Mock()
    fake_session_repo.create_session = lambda _user_id, storage_mode="sandboxed": "sess_123"
    fake_session_repo.delete_session = lambda _user_id, _session_id: True

    class FakePapersRepo:
        def __init__(self, session_id):
            self.session_id = session_id

    def fake_create_paper_agent(**kwargs):
        captured.update(kwargs)
        return fake_agent

    monkeypatch.setattr(paper_agent_module, "SessionRepoPG", lambda: fake_session_repo)
    monkeypatch.setattr(paper_agent_module, "PapersRepoPG", FakePapersRepo)
    monkeypatch.setattr(paper_agent_module, "create_paper_agent", fake_create_paper_agent)

    runner = paper_agent_module.PaperAgentRunner(api_key="test-key")
    runner.sessions_root = tmp_path / "sessions"
    runner.sessions_root.mkdir(parents=True, exist_ok=True)

    session_id = runner.start_session()
    assert session_id == "sess_123"

    expected_root = runner.sessions_root / "sess_123"
    assert expected_root.exists()
    assert captured["session_id"] == "sess_123"
    assert captured["session_root"] == expected_root
    assert captured["storage_mode"] == "sandboxed"
    assert captured["papers_db"].session_id == "sess_123"

    (expected_root / "dummy.txt").write_text("x", encoding="utf-8")

    assert runner.delete_session("sess_123") is True
    assert not expected_root.exists()
