import asyncio
import uuid

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module
from backend.auth import Principal, require_user
from agent.tools.pdf_extractor import ExtractedContent


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    uploaded_store = {}

    async def fake_init_db(app):
        app.state.db_pool = object()
        app.state.session_agents = {}
        app.state.session_meta = {}

    async def fake_close_db(app):
        return None

    async def fake_get_all_sessions(_pool, _user_id):
        return []

    async def fake_insert_session(_pool, _session_id, _user_id, storage_mode="sandboxed"):
        return storage_mode

    async def fake_get_or_create_session_agent(_session_id):
        return object()

    async def fake_get_session(_pool, _session_id, _user_id=None):
        return {
            "session_id": _session_id,
            "title": "New chat",
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
            "storage_mode": "sandboxed",
        }

    async def fake_resolve_global_paper_id_by_path(_pool, _file_path):
        return None

    async def fake_session_can_access_paper(_pool, _session_id, _paper_id):
        return True

    async def fake_upsert_session_paper_link(_pool, _session_id, _paper_id, source_ref=None):
        return bool(_session_id and _paper_id)

    async def fake_insert_session_uploaded_paper(
        _pool=None,
        session_id=None,
        paper_id=None,
        original_filename="",
        stored_pdf_path="",
        canonical_md_path="",
        images_dir=None,
        page_count=0,
        image_count=0,
        status="completed",
        **_kwargs,
    ):
        item = {
            "paper_id": paper_id,
            "original_filename": original_filename,
            "stored_pdf_path": stored_pdf_path,
            "canonical_md_path": canonical_md_path,
            "images_dir": images_dir,
            "page_count": page_count,
            "image_count": image_count,
            "status": status,
            "created_at": "2026-01-01T00:00:00+00:00",
        }
        uploaded_store.setdefault(session_id, [])
        uploaded_store[session_id] = [item] + [x for x in uploaded_store[session_id] if x["paper_id"] != paper_id]
        return item

    async def fake_list_session_uploaded_papers(_pool, session_id):
        return uploaded_store.get(session_id, [])

    monkeypatch.setattr(backend_app_module, "init_db", fake_init_db)
    monkeypatch.setattr(backend_app_module, "close_db", fake_close_db)
    monkeypatch.setattr(backend_app_module, "get_all_sessions", fake_get_all_sessions)
    monkeypatch.setattr(backend_app_module, "insert_session", fake_insert_session)
    monkeypatch.setattr(backend_app_module, "_get_or_create_session_agent", fake_get_or_create_session_agent)
    monkeypatch.setattr(backend_app_module, "get_session", fake_get_session)
    monkeypatch.setattr(backend_app_module, "resolve_global_paper_id_by_path", fake_resolve_global_paper_id_by_path)
    monkeypatch.setattr(backend_app_module, "session_can_access_paper", fake_session_can_access_paper)
    monkeypatch.setattr(backend_app_module, "upsert_session_paper_link", fake_upsert_session_paper_link)
    monkeypatch.setattr(backend_app_module, "insert_session_uploaded_paper", fake_insert_session_uploaded_paper)
    monkeypatch.setattr(backend_app_module, "list_session_uploaded_papers", fake_list_session_uploaded_papers)

    async def fake_require_user():
        return Principal(user_id="test-user")

    backend_app_module.app.dependency_overrides[require_user] = fake_require_user

    with TestClient(backend_app_module.app) as test_client:
        yield test_client
    backend_app_module.app.dependency_overrides.clear()


def test_list_sessions_returns_json_list(client: TestClient):
    response = client.get("/api/sessions")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_create_session_returns_uuid(client: TestClient):
    response = client.post("/api/sessions")
    assert response.status_code == 200
    payload = response.json()
    session_id = payload.get("session_id")
    assert isinstance(session_id, str)
    uuid.UUID(session_id)


def test_get_session_messages_invalid_uuid_returns_400(client: TestClient):
    response = client.get("/api/sessions/not-a-uuid/messages")
    assert response.status_code == 400
    assert response.json().get("detail") == "Invalid session ID format"


def test_upload_session_pdf_success(client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(backend_app_module, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(backend_app_module, "_SESSIONS_ROOT", tmp_path / "papers" / "sessions")
    monkeypatch.setattr(backend_app_module, "_SHARED_PAPERS_CACHE_ROOT", tmp_path / "papers" / "cache")

    class FakeExtractor:
        def __init__(self, output_base_dir):
            self.output_base_dir = output_base_dir

        def extract(self, _pdf_path, paper_id=None):
            images_dir = self.output_base_dir / paper_id / "images"
            images_dir.mkdir(parents=True, exist_ok=True)
            (images_dir / "page1_img1.png").write_bytes(b"fake-image")
            return ExtractedContent(
                text="Uploaded paper text",
                pages=[{"page_num": 1, "text": "Uploaded paper text", "image_paths": [f"extracted/{paper_id}/images/page1_img1.png"]}],
                images_dir=images_dir,
                image_count=1,
                page_count=1,
            )

    monkeypatch.setattr(backend_app_module, "PDFExtractor", FakeExtractor)
    session_id = str(uuid.uuid4())
    response = client.post(
        f"/api/sessions/{session_id}/uploads/papers",
        files={"file": ("paper.pdf", b"%PDF-1.4\nfake\n", "application/pdf")},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["paper_id"].startswith("upload_")
    assert payload["stored_pdf_path"].startswith("papers/sessions/")
    assert payload["canonical_md_path"].startswith("papers/sessions/")
    assert payload["images_dir"].startswith("papers/sessions/")
    assert payload["page_count"] == 1
    assert payload["image_count"] == 1
    assert payload["status"] == "completed"

    listed = client.get(f"/api/sessions/{session_id}/uploads/papers")
    assert listed.status_code == 200
    items = listed.json()
    assert len(items) == 1
    assert items[0]["paper_id"] == payload["paper_id"]


def test_upload_session_pdf_rejects_non_pdf(client: TestClient):
    session_id = str(uuid.uuid4())
    response = client.post(
        f"/api/sessions/{session_id}/uploads/papers",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 400
    assert response.json().get("detail") == "Only PDF uploads are supported"


def test_upload_session_pdf_rejects_large_file(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    session_id = str(uuid.uuid4())
    monkeypatch.setattr(backend_app_module, "_MAX_UPLOAD_PDF_BYTES", 8)
    response = client.post(
        f"/api/sessions/{session_id}/uploads/papers",
        files={"file": ("paper.pdf", b"%PDF-123456789", "application/pdf")},
    )
    assert response.status_code == 413


def test_upload_session_pdf_rejects_when_session_limit_reached(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    async def fake_list_session_uploaded_papers(_pool, _session_id):
        return [{"paper_id": f"upload_{i}"} for i in range(20)]

    monkeypatch.setattr(backend_app_module, "list_session_uploaded_papers", fake_list_session_uploaded_papers)
    session_id = str(uuid.uuid4())
    response = client.post(
        f"/api/sessions/{session_id}/uploads/papers",
        files={"file": ("paper.pdf", b"%PDF-1.4\nfake\n", "application/pdf")},
    )
    assert response.status_code == 400
    assert "Upload limit exceeded" in response.json().get("detail", "")


def test_update_title_empty_returns_400(client: TestClient):
    session_id = str(uuid.uuid4())
    response = client.patch(f"/api/sessions/{session_id}/title", json={"title": "   "})
    assert response.status_code == 400
    assert response.json().get("detail") == "Title cannot be empty"


def test_shared_cache_file_requires_session_access(client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path):
    session_id = str(uuid.uuid4())
    shared_root = tmp_path / "cache"
    file_path = shared_root / "downloads" / "2103_03404.pdf"
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(b"pdf")

    monkeypatch.setattr(backend_app_module, "_SHARED_PAPERS_CACHE_ROOT", shared_root)
    monkeypatch.setattr(backend_app_module, "_SESSIONS_ROOT", tmp_path / "sessions")

    async def fake_resolve_global_paper_id_by_path(_pool, _file_path):
        return "2103_03404"

    async def fake_session_can_access_paper(_pool, _session_id, _paper_id):
        return False

    monkeypatch.setattr(backend_app_module, "resolve_global_paper_id_by_path", fake_resolve_global_paper_id_by_path)
    monkeypatch.setattr(backend_app_module, "session_can_access_paper", fake_session_can_access_paper)

    response = client.get(f"/api/sessions/{session_id}/files/downloads/2103_03404.pdf")
    assert response.status_code == 403


def test_resolve_image_ref_supports_nested_img_path(monkeypatch: pytest.MonkeyPatch, tmp_path):
    root = tmp_path / "papers"
    nested = root / "extracted" / "2103_03404" / "images" / "page1_img1.png"
    nested.parent.mkdir(parents=True, exist_ok=True)
    nested.write_bytes(b"fake-image")

    monkeypatch.setattr(backend_app_module, "_LEGACY_ALLOWED_FILE_DIRS", [root])
    resolved = backend_app_module._resolve_image_ref("extracted/2103_03404/images/page1_img1.png")
    assert resolved == nested


def test_resolve_relative_in_dirs_supports_dot_slash_path(tmp_path):
    root = tmp_path / "root"
    nested = root / "extracted" / "paper_x" / "images" / "fig.png"
    nested.parent.mkdir(parents=True, exist_ok=True)
    nested.write_bytes(b"fake-image")

    resolved = backend_app_module._resolve_relative_in_dirs("./extracted/paper_x/images/fig.png", [root])
    assert resolved == nested


def test_resolve_image_ref_supports_dot_slash_path(monkeypatch: pytest.MonkeyPatch, tmp_path):
    root = tmp_path / "papers"
    nested = root / "extracted" / "2103_03404" / "images" / "page1_img1.png"
    nested.parent.mkdir(parents=True, exist_ok=True)
    nested.write_bytes(b"fake-image")

    monkeypatch.setattr(backend_app_module, "_LEGACY_ALLOWED_FILE_DIRS", [root])
    resolved = backend_app_module._resolve_image_ref("./extracted/2103_03404/images/page1_img1.png")
    assert resolved == nested


def test_resolve_image_ref_basename_fallback_searches_recursively(monkeypatch: pytest.MonkeyPatch, tmp_path):
    root = tmp_path / "papers"
    nested = root / "cache" / "imgs" / "same_name.png"
    nested.parent.mkdir(parents=True, exist_ok=True)
    nested.write_bytes(b"fake-image")

    monkeypatch.setattr(backend_app_module, "_LEGACY_ALLOWED_FILE_DIRS", [root])
    resolved = backend_app_module._resolve_image_ref("same_name.png")
    assert resolved == nested


def test_replace_image_refs_with_base64_supports_nested_img_path(monkeypatch: pytest.MonkeyPatch, tmp_path):
    root = tmp_path / "papers"
    nested = root / "extracted" / "paper_x" / "images" / "fig.png"
    nested.parent.mkdir(parents=True, exist_ok=True)
    nested.write_bytes(b"fake-image-content")

    monkeypatch.setattr(backend_app_module, "_LEGACY_ALLOWED_FILE_DIRS", [root])
    converted = backend_app_module._replace_image_refs_with_base64(
        "图如下：![fig](img://extracted/paper_x/images/fig.png)"
    )
    assert "data:image/png;base64," in converted


def test_replace_image_refs_with_base64_supports_dot_slash_img_path(monkeypatch: pytest.MonkeyPatch, tmp_path):
    root = tmp_path / "papers"
    nested = root / "extracted" / "paper_x" / "images" / "fig.png"
    nested.parent.mkdir(parents=True, exist_ok=True)
    nested.write_bytes(b"fake-image-content")

    monkeypatch.setattr(backend_app_module, "_LEGACY_ALLOWED_FILE_DIRS", [root])
    converted = backend_app_module._replace_image_refs_with_base64(
        "图如下：![fig](img://./extracted/paper_x/images/fig.png)"
    )
    assert "data:image/png;base64," in converted


def test_should_trigger_context_compression_threshold():
    assert backend_app_module._should_trigger_context_compression(0.929, 0.93) is False
    assert backend_app_module._should_trigger_context_compression(0.93, 0.93) is True


def test_extract_retrieval_records_from_tool_result_json():
    payload = [
        {
            "source": "arxiv",
            "id": "2401.00001",
            "url": "https://arxiv.org/abs/2401.00001",
            "title": "Paper A",
            "summary": "Abstract A",
        },
        {
            "source": "pubmed",
            "pmid": "123456",
            "url": "https://pubmed.ncbi.nlm.nih.gov/123456/",
            "title": "Paper B",
            "abstract": "Abstract B",
        },
    ]
    records = backend_app_module._extract_retrieval_records_from_tool_result(
        tool_name="search_paper",
        tool_result=payload,
    )
    assert len(records) == 2
    assert records[0]["url"] == "https://arxiv.org/abs/2401.00001"
    assert records[0]["title"] == "Paper A"
    assert records[0]["abstract"] == "Abstract A"
    assert records[0]["paper_id"] == "2401.00001"


def test_merge_retrieval_records_dedupe_by_paper_id_and_url():
    merged = backend_app_module._merge_retrieval_records(
        existing=[
            {
                "url": "https://arxiv.org/abs/2401.00001",
                "title": "A",
                "abstract": "old",
                "paper_id": "2401.00001",
                "source_tool": "search_paper",
            }
        ],
        new_items=[
            {
                "url": "https://arxiv.org/abs/2401.00001",
                "title": "A newer",
                "abstract": "new",
                "paper_id": "2401.00001",
                "source_tool": "search_paper",
            },
            {
                "url": "https://pubmed.ncbi.nlm.nih.gov/123456/",
                "title": "P",
                "abstract": "x",
                "source_tool": "search_paper",
            },
            {
                "url": "https://pubmed.ncbi.nlm.nih.gov/123456/",
                "title": "P duplicate",
                "abstract": "y",
                "source_tool": "search_paper",
            },
        ],
    )
    assert len(merged) == 2
    assert merged[0]["paper_id"] == "2401.00001"
    assert merged[1]["url"] == "https://pubmed.ncbi.nlm.nih.gov/123456/"


def test_build_effective_prompt_includes_compressed_block_and_recent_tools():
    prompt = backend_app_module._build_effective_prompt(
        messages=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "ok"}],
        user_index=2,
        user_query="next",
        compressed_block={
            "retrieval_records": [
                {
                    "url": "https://arxiv.org/abs/2401.00001",
                    "title": "Paper A",
                    "abstract": "Abstract A",
                    "source_tool": "search_paper",
                }
            ]
        },
        recent_tool_calls=[
            {
                "tool_name": "read_paper",
                "tool_args": {"paper_ref": "2401.00001"},
                "tool_result_summary": "read done",
            }
        ],
    )
    assert "[Compressed Retrieval Memory]" in prompt
    assert "[Recent Tool Calls]" in prompt
    assert "User: next" in prompt


def test_build_effective_prompt_includes_uploaded_papers_block():
    prompt = backend_app_module._build_effective_prompt(
        messages=[{"role": "user", "content": "请总结"}],
        user_index=1,
        user_query="开始",
        compressed_block={},
        recent_tool_calls=[],
        uploaded_papers=[
            {
                "paper_id": "upload_abc123",
                "original_filename": "paper.pdf",
                "page_count": 12,
                "canonical_md_path": "papers/sessions/s1/md/upload_abc123.md",
            }
        ],
    )
    assert "[Uploaded Papers]" in prompt
    assert "uploaded://upload_abc123" in prompt


def test_compress_context_memory_merges_incremental_retrieval_records(monkeypatch: pytest.MonkeyPatch):
    async def fake_keep_from_id(_pool, _session_id, keep_recent):
        assert keep_recent == 3
        return 8

    async def fake_candidates(_pool, _session_id, after_id, before_id):
        assert after_id == 5
        assert before_id == 8
        return [
            {
                "id": 6,
                "retrieval_records": [
                    {
                        "url": "https://arxiv.org/abs/2401.00002",
                        "title": "Paper B",
                        "abstract": "Abstract B",
                        "paper_id": "2401.00002",
                        "source_tool": "search_paper",
                    }
                ],
            },
            {
                "id": 7,
                "retrieval_records": [
                    {
                        "url": "https://pubmed.ncbi.nlm.nih.gov/123456/",
                        "title": "Paper P",
                        "abstract": "Abstract P",
                        "source_tool": "search_paper",
                    }
                ],
            },
        ]

    captured = {}

    async def fake_update(_pool, **kwargs):
        captured["compressed_block"] = kwargs["compressed_block"]
        captured["last_id"] = kwargs["last_compressed_tool_call_id"]
        captured["window"] = kwargs["context_window_tokens"]
        captured["ratio"] = kwargs["threshold_ratio"]
        return True

    monkeypatch.setattr(backend_app_module, "get_recent_tool_calls_keep_from_id", fake_keep_from_id)
    monkeypatch.setattr(backend_app_module, "get_tool_calls_for_compression", fake_candidates)
    monkeypatch.setattr(backend_app_module, "update_session_context_compression_state", fake_update)

    block, changed = asyncio.run(
        backend_app_module._compress_context_memory(
            pool=object(),
            session_id="00000000-0000-0000-0000-000000000000",
            compression_state={
                "compressed_block": {
                    "retrieval_records": [
                        {
                            "url": "https://arxiv.org/abs/2401.00001",
                            "title": "Paper A",
                            "abstract": "Abstract A",
                            "paper_id": "2401.00001",
                            "source_tool": "search_paper",
                        }
                    ]
                },
                "last_compressed_tool_call_id": 5,
            },
            keep_recent=3,
            context_window_tokens=128000,
            threshold_ratio=0.93,
        )
    )
    assert changed is True
    assert len(block["retrieval_records"]) == 3
    assert captured["last_id"] == 7

