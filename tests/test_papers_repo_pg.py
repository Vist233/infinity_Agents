from datetime import date, datetime, timezone

import pytest

import agent.papers_repo_pg as papers_repo_pg_module
from agent.papers_repo_pg import PaperRecord, PapersRepoPG


@pytest.fixture
def fake_repo(monkeypatch: pytest.MonkeyPatch):
    calls = []

    def _fake_exec_sync(_database_url, query, *args):
        calls.append((query, args))
        return "OK"

    monkeypatch.setattr(papers_repo_pg_module, "exec_sync", _fake_exec_sync)
    repo = PapersRepoPG(
        session_id="00000000-0000-0000-0000-000000000123",
        database_url="postgresql://user:pass@localhost:5432/test_db",
    )
    # Ignore bootstrap SQL calls.
    calls.clear()
    return repo, calls


@pytest.mark.parametrize(
    "raw",
    [
        "2026-02-23T09:59:22.425399+00:00",
        "2026-02-23T09:59:22Z",
        "2026-02-23 09:59:22+00:00",
        "2026-02-23 09:59:22+0000",
        "2026-02-23 09:59:22",
        "2026/02/23 09:59:22",
        "Sun, 23 Feb 2026 09:59:22 GMT",
        "20260223T095922Z",
        "2026-02-23",
        "2026/02/23",
        "20260223",
        "2026-Feb",
        "2026-February",
        1771840762,
        1771840762.123,
        "1771840762",
        datetime(2026, 2, 23, 10, 30, 0),
        datetime(2026, 2, 23, 10, 30, 0, tzinfo=timezone.utc),
        date(2026, 2, 23),
    ],
)
def test_coerce_timestamptz_accepts_multiple_formats(fake_repo, raw):
    repo, _calls = fake_repo
    fallback = datetime(2030, 1, 1, tzinfo=timezone.utc)
    parsed = repo._coerce_timestamptz(raw, fallback=fallback)

    assert isinstance(parsed, datetime)
    assert parsed.tzinfo is not None


def test_coerce_timestamptz_invalid_uses_fallback(fake_repo):
    repo, _calls = fake_repo
    fallback = datetime(2030, 1, 1, tzinfo=timezone.utc)
    parsed = repo._coerce_timestamptz("not-a-time", fallback=fallback)
    assert parsed == fallback


def test_upsert_passes_datetime_objects_to_sql(fake_repo):
    repo, calls = fake_repo
    record = PaperRecord(
        paper_id="paper_1",
        source_url="https://example.com/paper.pdf",
        created_at="2026-02-23T09:59:22.425399+00:00",
        updated_at="2026-02-23",
        status="processing",
    )

    repo.upsert(record)

    insert_calls = [
        (query, args)
        for query, args in calls
        if "INSERT INTO paper_records_global" in query
    ]
    assert insert_calls, "Expected paper_records_global upsert call"
    _query, args = insert_calls[0]

    # $12/$13 in SQL are created_at/updated_at
    assert isinstance(args[11], datetime)
    assert isinstance(args[12], datetime)
    assert args[11].tzinfo is not None
    assert args[12].tzinfo is not None
