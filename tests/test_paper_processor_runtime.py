import re

from backend.paper_processor.client import (
    PaperProcessorProtocolError,
    _validate_edge_url,
    from_environment,
)


def test_processor_edge_url_is_the_fixed_https_control_plane():
    assert _validate_edge_url("https://infinity.zhangyvjing.com/") == "https://infinity.zhangyvjing.com"


def test_processor_edge_url_rejects_unapproved_hosts_and_url_parts():
    for value in (
        "http://infinity.zhangyvjing.com",
        "https://example.com",
        "https://infinity.zhangyvjing.com:443",
        "https://infinity.zhangyvjing.com/api",
        "https://user@infinity.zhangyvjing.com",
        "https://infinity.zhangyvjing.com/?redirect=example.com",
    ):
        try:
            _validate_edge_url(value)
        except PaperProcessorProtocolError as error:
            assert str(error) == "Paper Processor Edge URL is not the fixed control plane"
        else:
            raise AssertionError(f"unapproved Edge URL was accepted: {value}")


def test_processor_generates_a_unique_boot_and_process_scoped_instance_id(monkeypatch):
    monkeypatch.setenv("PAPER_PROCESSOR_EDGE_URL", "https://infinity.zhangyvjing.com")
    monkeypatch.setenv("PAPER_PROCESSOR_ID", "paper-processor-zhangbot-v1")
    monkeypatch.setenv("PAPER_PROCESSOR_TOKEN", "test-only-token")
    monkeypatch.delenv("PAPER_PROCESSOR_INSTANCE_ID", raising=False)

    first = from_environment()
    second = from_environment()

    assert first._instance_id != second._instance_id
    assert re.fullmatch(r"zhangbot-[a-z0-9-]+-[0-9]+-[0-9a-f]{16}", first._instance_id)
