# PaperAgent 工具 I/O 规范与限制（2026-02-23）

## 1) 模型配置（已修正）
- Chat 模型：`kimi-k2.5`
  - 来源：`PAPER_AGENT_CHAT_MODEL`
  - 默认：`kimi-k2.5`
  - 兼容映射：若传入 `kimi-k2-thinking-turbo` / `kimi-k2-turbo`，会自动映射到 `kimi-k2.5`
- Vision 模型：`PAPER_AGENT_VISION_MODEL`（未设置时回退到 chat 模型）
- Chat Thinking：默认关闭（`PAPER_AGENT_CHAT_DISABLE_THINKING=1`）

## 2) 通用约定
- 所有工具返回值类型：`string`（JSON 字符串）
- 图片渲染统一使用：`img://...` + `markdown` 字段
- 会话沙箱隔离：工具仅可访问 session 允许目录和共享 cache
- 错误返回：统一包含 `error` 字段，必要时附带 `message` / `hint`

## 3) 工具清单

### A. 文献检索与阅读（`PaperSearchTools`）

#### `search_paper(query, num_results=5)`
- 说明：`search_papers` 别名
- 输入：
  - `query: string`（必填，不能为空）
  - `num_results: int`（自动限制到 `1..25`）
- 输出：
  - 成功：论文数组 JSON（arXiv + PubMed 交错合并）
  - 失败：`{"error": "..."}`
- 关键字段（单篇论文）：
  - `source, title, id, url, pdf_url, authors, summary, published, doi...`
- 限制：
  - 缓存 TTL：3600s（PostgreSQL）
  - 响应字符限制：`max_chars=50000`
  - 结果数量限制：由 `SizeMiddleware.max_articles` 控制（默认跟 `default_num_results` 一致）

#### `search_papers(query, num_results=5)`
- 与 `search_paper` 相同

#### `read_paper(paper_ref, action="cat", pattern=None, start_line=1, max_lines=200, case_sensitive=False)`
- 输入：
  - `paper_ref: string`（支持 arXiv ID/URL，或 `pdf_url`）
  - `action: one of [cat, head, tail, grep, outline]`
  - `pattern: string`（`grep` 时必填）
  - `start_line: int`（自动下限为 1）
  - `max_lines: int`（自动限制到 `1..500`）
  - `case_sensitive: bool`
- 输出：
  - 通用字段：`paper_id, md_path, action, cached, source_status, total_lines`
  - `cat/head/tail`：含 `content`
  - `grep`：含 `pattern, matches[], match_count`
  - `outline`：含 `headings[]`
- 限制与行为：
  - 会话授权校验（只允许读取当前会话已授权文献）
  - 首次读取会触发下载 + PDF 提取 + Markdown 物化
  - `grep` 正则无效时返回 `error: invalid_regex`

### B. 图表工具（`PythonPlottingTools`）

#### `create_chart(code, filename=None, chart_type="matplotlib")`
- 输入：
  - `code: string`
  - `filename: string | null`
  - `chart_type: "matplotlib" | "plotly"`
- 输出：
  - 成功：`success, image_ref, markdown`
  - 可选：`font_info, warning`
  - 失败：`error`
- 限制：
  - 输出格式：PNG
  - blank 图检测：明显空白图会报错

#### `create_bar_chart(data, title, xlabel, ylabel, filename=None)`
#### `create_line_chart(x_data, y_data, title, xlabel, ylabel, filename=None)`
- 输出：`success, image_ref, markdown, font_info[, warning]`

### C. Plotly 可视化（`PlotlyVisualizationTools`）

#### `create_methodology_comparison(paper_reports_json, filename=None)`
- 输入：`paper_reports_json` 必须是 JSON 数组，最大 200 项
- 输出：`success, chart_type, filename, image_path, image_ref, markdown`

#### `create_tool_frequency(paper_reports_json, top_n=15, filename=None)`
- 输入：
  - `paper_reports_json` 必须是 JSON 数组
  - `top_n` 自动限制到 `1..50`
- 输出：同上

#### `create_custom_sunburst(labels, parents, values=None, title="...", filename=None)`
- 输入限制：
  - `labels/parents/values` 必须是 JSON 数组
  - 长度必须一致
  - `labels` 不可为空
  - 节点数最大 500
- 输出：同上

#### `create_custom_bar_chart(data_json, title, xlabel, ylabel, horizontal=False, filename=None)`
- 输入限制：
  - `data_json` 必须是 JSON object
  - key 必须是字符串
  - value 必须为数字
  - 类别数最大 100
- 输出：同上

### D. 文件与图片引用（`FileSystemTools`）

#### `list_files(directory="")`
- 输入：
  - 空字符串：列出允许根目录
  - 相对/绝对路径：仅允许访问白名单目录
- 输出：目录树或错误

#### `read_file(file_path, max_chars=50000)`
- 输入：文本文件路径
- 输出：`file_path, file_name, size_bytes, content, truncated`
- 限制：
  - 二进制文件拒绝读取（提示改用 `read_image`）

#### `read_image(file_path)`
- 输入：图片路径
- 输出：`file_name, size_bytes, mime_type, image_ref, markdown`
- 限制：
  - 支持扩展名：`.png/.jpg/.jpeg/.gif/.webp/.svg/.bmp`

### E. 视觉读图分析（`ImageAnalysisTools`）

#### `analyze_image(image_path, prompt="...", detail="high")`
- 输入：
  - `image_path: string`（仅允许目录白名单）
  - `prompt: string`
  - `detail: low|high|auto`（非法值会回落到 `high`）
- 输出：
  - 成功：
    - `success, model, prompt, detail`
    - `image`（含 `file_path/file_name/size_bytes/mime_type/width/height/mode`）
    - `image_ref, markdown, analysis`
  - 失败：`error, message[, hint], image`
- 限制：
  - 支持扩展名：`.png/.jpg/.jpeg/.gif/.webp/.bmp`
  - 图片大小：最大 20MB
  - 分析文本最大长度：8000 字符（超长截断）

## 4) 当前工具优化建议（后续迭代）
- 统一所有工具的错误结构：`{error, code, message, hint}`
- 为 `read_file(max_chars)` 增加上限 clamp（避免超大读取）
- 给 `search_papers` 返回结构增加 schema_version 字段，便于前端兼容升级
- 增加 `analyze_image_batch`（批量图像摘要）以支持多图论文方法对比
