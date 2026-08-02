"""
test_search_papers.py  —  模拟真实 Agent 调用体验的工具可用性测试

完全复刻 paperAgent.py 中的工具初始化方式:
  - PapersRepoPG (PostgreSQL 论文仓库)
  - DatabaseCacheMiddleware
  - SizeMiddleware
  - PaperSearchTools (含 search_papers + read_paper)

测试内容:
  Part 1: search_papers × 3 queries, 验证各渠道返回数量
  Part 2: read_paper 对搜索到的论文逐一测试所有 action 模式
"""
import sys
import os
import json
import uuid
import hashlib
from pathlib import Path
from collections import Counter
from typing import Optional
from datetime import datetime, timezone
import pytest

# ── 确保项目根目录在 sys.path ──
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# ── 加载 .env ──
env_path = PROJECT_ROOT / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

# This file deliberately exercises live paper sources, PDF downloads, and a
# PostgreSQL-backed cache.  Keep it out of the deterministic unit-test suite.
if os.getenv("RUN_INTEGRATION_TESTS") != "1":
    pytest.skip(
        "requires PostgreSQL and live paper-source access; set RUN_INTEGRATION_TESTS=1 to run",
        allow_module_level=True,
    )

# ── 导入项目模块 ──
from agent.papers_repo_pg import PapersRepoPG
from agent.tools.paper_search import PaperSearchTools, SizeMiddleware

# ═══════════════════════════════════════════════════════════════
#  DatabaseCacheMiddleware (直接复刻自 paperAgent.py)
# ═══════════════════════════════════════════════════════════════

class DatabaseCacheMiddleware:
    """Middleware for caching API responses in PostgreSQL table."""

    def __init__(self, db: PapersRepoPG, ttl_seconds: int = 3600):
        self.db = db
        self.ttl_seconds = ttl_seconds

    def _get_cache_key(self, func_name: str, *args, **kwargs) -> str:
        key_data = f"{func_name}:{args}:{sorted(kwargs.items())}"
        return hashlib.md5(key_data.encode()).hexdigest()

    def get(self, func_name: str, *args, **kwargs) -> Optional[str]:
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        row = self.db.get_cache(cache_key)
        if row:
            expires_at = row["expires_at"]
            if isinstance(expires_at, str):
                expires_at = datetime.fromisoformat(expires_at)
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if datetime.now(tz=timezone.utc) < expires_at:
                return row["data"]
            self.db.delete_cache(cache_key)
        return None

    def set(self, func_name: str, result: str, *args, **kwargs) -> None:
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        self.db.set_cache(cache_key, func_name, result, self.ttl_seconds)


# ═══════════════════════════════════════════════════════════════
#  工具初始化 (与真实 Agent 完全一致)
# ═══════════════════════════════════════════════════════════════

GLOBAL_PAPERS_CACHE_ROOT = PROJECT_ROOT / "papers" / "cache"
GLOBAL_PAPERS_CACHE_ROOT.mkdir(parents=True, exist_ok=True)

TEST_SESSION_ID = str(uuid.uuid4())
print(f"🔧 测试 session_id: {TEST_SESSION_ID}")

papers_db = PapersRepoPG(session_id=TEST_SESSION_ID)
cache_middleware = DatabaseCacheMiddleware(papers_db, ttl_seconds=3600)
size_middleware = SizeMiddleware(max_chars=50000, max_articles=10)

tools = PaperSearchTools(
    enable_search=True,
    enable_read=True,
    cache_middleware=cache_middleware,
    size_middleware=size_middleware,
    papers_db=papers_db,
    download_dir=GLOBAL_PAPERS_CACHE_ROOT / "downloads",
    shared_cache_root=GLOBAL_PAPERS_CACHE_ROOT,
)

# ═══════════════════════════════════════════════════════════════
#  测试配置
# ═══════════════════════════════════════════════════════════════

QUERIES = [
    "Attention is all you need",
    "Brassica",
    "Genome",
]
NUM_RESULTS = 10  # 期望每个 query 返回 10 篇 (每渠道各 ~5)

SEP = "=" * 72


# ═══════════════════════════════════════════════════════════════
#  Part 1: search_papers 测试
# ═══════════════════════════════════════════════════════════════

def test_search():
    print(f"\n{SEP}")
    print("Part 1: search_papers 测试 (真实网络调用)")
    print(SEP)

    all_papers = []  # 收集所有论文用于 Part 2

    for query in QUERIES:
        print(f"\n▶ Query: '{query}'  (num_results={NUM_RESULTS})")
        print("-" * 60)

        raw = tools.search_papers(query=query, num_results=NUM_RESULTS)
        results = json.loads(raw) if isinstance(raw, str) else raw

        # --- 基本类型检查 ---
        if isinstance(results, dict) and "error" in results:
            print(f"  ✗ 返回了 error: {results['error']}")
            continue

        assert isinstance(results, list), f"Expected list, got {type(results)}"

        # --- 数量统计 ---
        total = len(results)
        source_counts = Counter(p.get("source", "unknown") for p in results)
        arxiv_n = source_counts.get("arxiv", 0)
        pubmed_n = source_counts.get("pubmed", 0)

        status = "✓" if total >= 1 else "✗"
        print(f"  {status} 总数: {total}  |  arxiv: {arxiv_n}  |  pubmed: {pubmed_n}")

        if total != NUM_RESULTS:
            print(f"  ⚠ 期望 {NUM_RESULTS} 篇，实际 {total} 篇")

        # --- 逐篇简要输出 ---
        for i, paper in enumerate(results, 1):
            src = paper.get("source", "?").upper()
            title = paper.get("title", "N/A")[:70]
            pid = paper.get("id", "?")
            pdf = "✓ PDF" if paper.get("pdf_url") else "✗ No PDF"
            print(f"  [{i:2d}] [{src:6s}] {pid:>14s}  {pdf}  {title}")

        all_papers.extend(results)

    return all_papers


# ═══════════════════════════════════════════════════════════════
#  Part 2: read_paper 全模式测试
# ═══════════════════════════════════════════════════════════════

READ_ACTIONS = [
    {"action": "outline", "desc": "显示论文 Markdown headings 大纲"},
    {"action": "head",    "desc": "读取前 30 行",    "max_lines": 30},
    {"action": "tail",    "desc": "读取末尾 30 行",  "max_lines": 30},
    {"action": "cat",     "desc": "读取第 1-50 行",   "start_line": 1, "max_lines": 50},
    {"action": "grep",    "desc": "正则搜索 'method|model'", "pattern": "method|model", "max_lines": 20},
]


def test_read(all_papers):
    print(f"\n\n{SEP}")
    print("Part 2: read_paper 全模式测试 (真实 PDF 下载 + 解析)")
    print(SEP)

    if not all_papers:
        print("  ⚠ 没有搜索结果，跳过 read_paper 测试")
        return

    # 去重：按 (source, id) 去掉重复论文
    seen = set()
    test_papers = []
    for p in all_papers:
        key = (p.get("source", ""), p.get("id", ""))
        if key not in seen:
            seen.add(key)
            test_papers.append(p)

    # ── 手动注册授权，确保 read_paper 能通过权限检查 ──
    # 这复刻了 Agent 中 search → read 的完整流程
    print(f"\n🔑 注册 {len(test_papers)} 篇论文的会话访问授权...")
    all_refs = []
    for p in test_papers:
        for key in ("id", "entry_id", "pdf_url", "url"):
            val = p.get(key)
            if isinstance(val, str) and val.strip():
                all_refs.append(val.strip())
        # 同时 link paper_id → session
        pid = p.get("id", "")
        if pid:
            papers_db.link_paper_to_session(
                TEST_SESSION_ID, pid,
                source_ref=p.get("entry_id") or p.get("pdf_url") or p.get("url") or pid,
            )
    papers_db.register_authorized_refs(all_refs, source="test_search")
    print(f"   ✓ 已注册 {len(all_refs)} 个 refs")

    print(f"\n📋 将测试全部 {len(test_papers)} 篇论文 × {len(READ_ACTIONS)} 种阅读模式:")
    for i, p in enumerate(test_papers, 1):
        pid = p.get("id", "?")
        has_pdf = "✓ PDF" if p.get("pdf_url") else "✗ No PDF"
        print(f"   {i:2d}. [{p.get('source','?').upper():6s}] {has_pdf}  id={pid}")

    for paper in test_papers:
        # 使用 paper ID 作为 ref (ArXiv 短 ID 或 PubMed 纯数字 PMID)
        # 这是 read_paper 能正确解析的格式
        paper_ref = paper.get("id", "")

        title = paper.get("title", "N/A")[:60]
        source = paper.get("source", "?").upper()
        print(f"\n{'─' * 60}")
        print(f"[{source}] 论文 ref: {paper_ref}")
        print(f"标题: {title}")
        print(f"{'─' * 60}")

        for act_info in READ_ACTIONS:
            action = act_info["action"]
            desc = act_info["desc"]
            kwargs = {
                "paper_ref": paper_ref,
                "action": action,
            }
            if "pattern" in act_info:
                kwargs["pattern"] = act_info["pattern"]
            if "start_line" in act_info:
                kwargs["start_line"] = act_info["start_line"]
            if "max_lines" in act_info:
                kwargs["max_lines"] = act_info["max_lines"]

            print(f"\n  ▶ action='{action}'  ({desc})")
            try:
                raw = tools.read_paper(**kwargs)
                result = json.loads(raw) if isinstance(raw, str) else raw

                # 错误检查
                if isinstance(result, dict) and result.get("error"):
                    err = result["error"]
                    msg = result.get("message", "")
                    print(f"    ✗ error: {err}")
                    if msg:
                        print(f"      message: {msg}")
                    continue

                # 成功 - 根据 action 打印摘要
                cached = result.get("cached", False)
                source_status = result.get("source_status", "?")
                cache_tag = f"[cached={cached}, status={source_status}]"

                if action == "outline":
                    headings = result.get("headings", [])
                    print(f"    ✓ 共 {len(headings)} 个 heading  {cache_tag}")
                    for h in headings[:8]:
                        print(f"      L{h['line']:>4d}: {h['heading']}")
                    if len(headings) > 8:
                        print(f"      ... 还有 {len(headings) - 8} 个")

                elif action == "grep":
                    matches = result.get("matches", [])
                    print(f"    ✓ 匹配 {result.get('match_count', len(matches))} 行  {cache_tag}")
                    for m in matches[:5]:
                        print(f"      L{m['line']:>4d}: {m['match'][:80]}")
                    if len(matches) > 5:
                        print(f"      ... 还有 {len(matches) - 5} 处匹配")

                else:  # cat / head / tail
                    content = result.get("content", "")
                    total = result.get("total_lines", "?")
                    lines = content.splitlines()
                    print(f"    ✓ 返回 {len(lines)} 行 (总计 {total} 行)  {cache_tag}")
                    for line in lines[:5]:
                        print(f"      | {line[:90]}")
                    if len(lines) > 5:
                        print(f"      ... (省略 {len(lines) - 5} 行)")

                # 显示提取的图片信息
                images = result.get("images_by_page", [])
                if images:
                    total_imgs = sum(len(pg.get("image_paths", [])) for pg in images)
                    print(f"    📷 提取到 {total_imgs} 张图片 (分布在 {len(images)} 页)")

            except Exception as e:
                print(f"    ✗ 异常: {type(e).__name__}: {e}")


# ═══════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print(f"\n{SEP}")
    print("🚀 PaperSearchTools 真实可用性测试")
    print(f"   DATABASE_URL: {os.environ.get('DATABASE_URL', '未设置')[:50]}...")
    print(f"   缓存根目录: {GLOBAL_PAPERS_CACHE_ROOT}")
    print(SEP)

    all_papers = test_search()
    test_read(all_papers)

    print(f"\n{SEP}")
    print("✅ 测试完成！")
    print(SEP)
