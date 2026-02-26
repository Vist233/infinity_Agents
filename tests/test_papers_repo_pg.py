from datetime import date, datetime, timezone
import uuid

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


def test_insert_session_uploaded_paper_passes_datetime_objects(fake_repo, monkeypatch: pytest.MonkeyPatch):
    repo, _calls = fake_repo
    captured = {}

    def _fake_fetchrow_sync(_database_url, query, *args):
        if "INSERT INTO session_uploaded_papers" in query:
            captured["args"] = args
            return {
                "session_id": uuid.UUID(repo.session_id),
                "paper_id": "upload_1",
                "original_filename": "paper.pdf",
                "stored_pdf_path": "papers/sessions/s1/uploads/upload_1.pdf",
                "canonical_md_path": "papers/sessions/s1/md/upload_1.md",
                "images_dir": "papers/sessions/s1/extracted/upload_1/images",
                "page_count": 12,
                "image_count": 8,
                "status": "completed",
                "created_at": datetime(2026, 2, 23, 9, 59, 22, tzinfo=timezone.utc),
            }
        return None

    monkeypatch.setattr(papers_repo_pg_module, "fetchrow_sync", _fake_fetchrow_sync)
    result = repo.insert_session_uploaded_paper(
        session_id=repo.session_id,
        paper_id="upload_1",
        original_filename="paper.pdf",
        stored_pdf_path="papers/sessions/s1/uploads/upload_1.pdf",
        canonical_md_path="papers/sessions/s1/md/upload_1.md",
        images_dir="papers/sessions/s1/extracted/upload_1/images",
        page_count=12,
        image_count=8,
        status="completed",
        created_at="2026-02-23T09:59:22.425399+00:00",
    )

    assert result is not None
    assert result["paper_id"] == "upload_1"
    # SQL args: ... status at index 8, created_at at index 9
    assert isinstance(captured["args"][9], datetime)
    assert captured["args"][9].tzinfo is not None


def test_list_and_get_session_uploaded_papers(fake_repo, monkeypatch: pytest.MonkeyPatch):
    repo, _calls = fake_repo

    def _fake_fetch_sync(_database_url, query, *args):
        if "FROM session_uploaded_papers" in query:
            return [
                {
                    "paper_id": "upload_2",
                    "original_filename": "b.pdf",
                    "stored_pdf_path": "papers/sessions/s1/uploads/upload_2.pdf",
                    "canonical_md_path": "papers/sessions/s1/md/upload_2.md",
                    "images_dir": "papers/sessions/s1/extracted/upload_2/images",
                    "page_count": 3,
                    "image_count": 1,
                    "status": "completed",
                    "created_at": datetime(2026, 2, 24, 0, 0, tzinfo=timezone.utc),
                }
            ]
        return []

    def _fake_fetchrow_sync(_database_url, query, *args):
        if "FROM session_uploaded_papers" in query:
            return {
                "paper_id": "upload_2",
                "original_filename": "b.pdf",
                "stored_pdf_path": "papers/sessions/s1/uploads/upload_2.pdf",
                "canonical_md_path": "papers/sessions/s1/md/upload_2.md",
                "images_dir": "papers/sessions/s1/extracted/upload_2/images",
                "page_count": 3,
                "image_count": 1,
                "status": "completed",
                "created_at": datetime(2026, 2, 24, 0, 0, tzinfo=timezone.utc),
            }
        return None

    monkeypatch.setattr(papers_repo_pg_module, "fetch_sync", _fake_fetch_sync)
    monkeypatch.setattr(papers_repo_pg_module, "fetchrow_sync", _fake_fetchrow_sync)

    listed = repo.list_session_uploaded_papers(repo.session_id)
    assert listed and listed[0]["paper_id"] == "upload_2"

    got = repo.get_session_uploaded_paper(repo.session_id, "upload_2")
    assert got is not None
    assert got["paper_id"] == "upload_2"
