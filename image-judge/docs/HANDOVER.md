# ImageJudge 项目交接文档

> 本地视觉批量判定客户端（依据《本地视觉批量判定客户端_软件设计与开发任务文档 v0.2》实现）
> 交接日期：2026-08-03

---

## 1. 项目是什么

ImageJudge 是一个 **Windows 桌面客户端 + Cloudflare Worker 平台服务**的组合：

- 用户指定一张**参考图**和一个图片文件夹（或单文件），客户端把每张目标图与参考图一起发给千问视觉模型 `qwen3-vl-235b-a22b-instruct`（阿里云百炼），批量得到 **CLASSIFIED / UNKNOWN / REVIEW** 结构化分类结论。
- 模型输出使用 2.0 Schema：预测类别、离散状态、spotting features、候选类别、图片质量、可见依据摘要和 Review 原因；不要求模型伪造数字 score/confidence。
- **SQLite 是唯一事实源**；CSV（UTF-8 BOM、CRLF）是可重建的外部投影，通过 outbox + 原子快照同步，保证崩溃不丢结果。
- 两种认证模式：
  - **平台登录**：Zhang Auth OIDC（`https://auth.zhangyvjing.com`）→ Infinity Edge Worker 的 `/image-judge/*` 命名空间（`https://infinity.zhangyvjing.com/image-judge`）→ 平台代理调用模型。客户端永不接触平台 DashScope Key。约束：每用户每日 30 次（UTC 切分）、每用户并发 1。
  - **BYOK**：用户填自己的百炼 API Key，客户端直连百炼，无额度限制。

## 2. 目录结构

```
image-judge/
├── pyproject.toml / requirements.txt      # Python 依赖与 pytest 配置
├── apps/
│   ├── desktop/
│   │   ├── main.py                        # 启动脚本（python main.py）
│   │   ├── imagejudge.spec                # PyInstaller onedir 规格
│   │   └── imagejudge/                    # 客户端包
│   │       ├── config.py                  # 全部常量（模型ID、URL、额度、超时、错误码）
│   │       ├── log.py                     # 日志（token/key 正则脱敏）
│   │       ├── app.py                     # AppController：启动编排、恢复、CSV线程桥接
│   │       ├── session.py                 # AppSession：按模式创建网关
│   │       ├── main.py                    # 程序入口
│   │       ├── core/                      # state_machine、scanner、image_preprocess、prompting、task_engine
│   │       ├── persistence/               # db、models、repository + alembic migrations
│   │       ├── model/                     # schemas(Pydantic)、gateway、dashscope_gateway、worker_gateway
│   │       ├── export/                    # csv_sync：原子快照 + outbox 消费线程
│   │       ├── auth/                      # 进程内会话凭据、cloudflare_login(OIDC)、byok
│   │       └── ui/                        # login_window、main_window、result_table_model、dialogs
│   └── worker/
│       ├── wrangler.jsonc                 # 路由/vars/D1/KV/DO 绑定（含 secret 说明）
│       ├── migrations/0001_init.sql       # D1：users/usage_daily/sessions/idempotency
│       └── src/
│           ├── index.ts                   # 路由入口 + 标准错误兜底
│           ├── auth.ts                    # 桌面授权桥接 5 端点
│           ├── evaluate.ts                # /api/v1/evaluate 模型代理（额度+并发+幂等）
│           ├── ratelimit.ts               # D1 每日额度 + UserConcurrencyLock DO
│           ├── tokens.ts                  # HMAC 平台令牌 + ES256 id_token 校验
│           └── types.ts                   # Env、errorResponse 等
├── installer/
│   ├── imagejudge.iss                     # Inno Setup 安装脚本
└── tests/
    ├── conftest.py                        # 独立 SQLite 测试库 fixture
    ├── fixtures/sample_evaluation_output.json
    ├── unit/                              # schemas、state_machine、repository、csv_sync
    └── integration/test_flow.py           # 端到端：扫描→去重→领取→校验→落库→CSV→崩溃恢复
```

## 3. 架构关键设计（接手必读）

### 3.1 "双写"的正确理解
SQLite 与 CSV 不可能同事务。实现为：结果 + 一条 `UPSERT_CSV_ROW` outbox 事件在**同一 SQLite 事务**提交（`repository.save_result_and_enqueue_export`），提交后 `CSVSyncThread` 消费事件，全量重建 CSV 快照（tmp 文件 → fsync → `os.replace` 原子替换）。CSV 写失败只影响投影，不影响结果，outbox 指数退避重试（验收 A05/A06）。

### 3.2 状态机
`core/state_machine.py` 集中定义 RunStatus / ItemStatus / OutboxStatus 及合法迁移表，Repository 层在事务中执行迁移并校验。终态、断点续跑（STOPPED→RUNNING）、重试失败（FAILED→PENDING）、启动回收（PROCESSING→PENDING）都在这里。

### 3.3 任务引擎
`core/task_engine.py` 是 QThread，内部跑 asyncio 事件循环 + Semaphore(1)。`pause/resume/stop` 通过 `loop.call_soon_threadsafe` 投递。可重试错误进 RETRY_WAIT（优先 Retry-After，否则指数退避）；`QUOTA_EXCEEDED` / `AUTH_EXPIRED` 直接中止整个 run；模型输出 Pydantic 校验失败会带 `repair=True` 修复重试 1 次，仍失败标 `MODEL_OUTPUT_INVALID`。

### 3.4 双图顺序（验收 A03）
image[0] = REFERENCE，image[1] = TARGET，客户端与 Worker 两端都固定此顺序，不得交换。

### 3.5 Worker 额度与并发
- 每日额度：D1 `usage_daily`，`(user_sub, quota_date)` 唯一，`ON CONFLICT DO UPDATE RETURNING` 原子递增，超限 429 `QUOTA_EXCEEDED` + `Retry-After`（到下一 UTC 日）。
- 并发：Durable Object `UserConcurrencyLock` 按 `userSub` 做 lease（最长 5 分钟防死锁），占用中 429 `CONCURRENCY_LIMIT` + `Retry-After`。
- 幂等：KV `idem:{sub}:{client_request_id}` 缓存 1 天，重放直接返回缓存结果。
- 模型调用内部失败重试 1 次，属同一逻辑请求，不额外扣额度。

### 3.6 认证安全边界
- Zhang Auth 的 `client_secret` 只存在 Worker Secrets，客户端不接触。
- 双层 PKCE：OIDC 层（Worker↔Zhang Auth，nonce/state 存 KV）+ 桌面层（客户端↔Worker，code_verifier/S256 校验）。
- 回调白名单：仅 `http://127.0.0.1|localhost` loopback 或 `imagejudge://auth/callback`。
- 平台令牌为 HMAC-SHA256 签名的 `payload.sig`，access 15 分钟、refresh 30 天（wrangler vars 可调）。
- BYOK Key 只由用户手动填写，保存在当前进程内存；不接触系统钥匙串，不落 SQLite/CSV/日志（验收 A09/A10）。

### 3.7 时间戳约定
SQLite 一律 **naive UTC**（`models.utcnow()`）。曾因 `DateTime(timezone=True)` 在 SQLite 驱动下丢失 tzinfo 导致比较异常，勿改回。

## 4. 本地开发

### 4.1 桌面客户端（macOS 可开发，功能验证需 Windows）
```bash
cd image-judge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt        # 注意：PySide6 需目标 Python 版本有 wheel
python apps/desktop/main.py            # 启动 GUI（登录窗）
```
- 环境变量覆盖：`IMAGEJUDGE_WORKER_BASE_URL`、数据目录等见 `config.py`；默认平台地址为 `https://infinity.zhangyvjing.com/image-judge`。
- 数据目录（Windows）：`%LOCALAPPDATA%\ImageJudge`（SQLite + 日志）。
- 数据库迁移：alembic 配置在 `apps/desktop/alembic.ini`，迁移脚本在 `imagejudge/persistence/migrations/`；首装等价于 `init_db()` 建全表。

### 4.2 运行测试（当前 46 个用例全部通过）
```bash
cd image-judge
.venv/bin/python -m pytest tests -q
```
测试不依赖 Qt 与网络：单元（schema 校验、状态机、Repository 事务、CSV 同步）+ 集成（端到端流程与崩溃恢复）。

### 4.3 Worker 本地开发
```bash
cd image-judge/apps/worker
npm install
npm run typecheck          # tsc --noEmit（已通过）
npm run dev                # wrangler dev（需本地 D1/KV 与 secrets）
```

## 5. 部署清单

### 5.1 Worker 部署状态
ImageJudge 已合并部署到现有 `infinity-agents-edge` Worker，路径前缀为 `/image-judge`，使用独立资源：

- D1 `image-judge-db`（`fc8f0491-3d57-48d8-bae8-96f633d7dc8d`），绑定 `IMAGE_JUDGE_DB`。
- KV `image-judge-state`（`fe1f3e47f5a94e4ca2b375ff3f9b2c79`），绑定 `IMAGE_JUDGE_KV`。
- Durable Object `ImageJudgeUserConcurrencyLock`，绑定 `IMAGE_JUDGE_USER_LOCK`。

已执行远端迁移并登记 Zhang Auth OIDC 客户端 `image-judge-desktop`，回调为 `https://infinity.zhangyvjing.com/image-judge/auth/callback`。

生产合并 Worker 使用以下 Secrets（**绝不能写进 vars**）：

```bash
wrangler secret put IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET
wrangler secret put IMAGE_JUDGE_TOKEN_SIGNING_SECRET
wrangler secret put IMAGE_JUDGE_DASHSCOPE_API_KEY  # 本轮未配置；本地 BYOK 已验证
```

原始独立 Worker 配置仍保留作源码参考；不要再把它部署为第二个生产服务。

### 5.2 原始独立 Worker 配置（历史参考）
若需要在隔离环境中运行原始 Worker，创建资源：`wrangler d1 create image-judge-api`、`wrangler kv namespace create KV`，再填入独立配置。

旧版独立部署所需的 Secrets（**绝不能写进 vars**）：
   ```bash
   wrangler secret put DASHSCOPE_API_KEY
   wrangler secret put ZHANG_AUTH_CLIENT_SECRET
   wrangler secret put TOKEN_SIGNING_SECRET
   ```
验证：`GET https://infinity.zhangyvjing.com/image-judge/healthz` 返回 `{"ok":true}`。

### 5.3 Windows 安装包
1. Windows 机器 + Python 3.12 环境，`pip install -r requirements.txt pyinstaller`。
2. `cd apps/desktop && pyinstaller imagejudge.spec --noconfirm`。
3. Inno Setup 6 编译 `installer/imagejudge.iss`（或 `iscc imagejudge.iss`），产物在 `installer/output/`。
4. 按文档 T028：在干净 Windows 10/11 虚拟机验证缺失 DLL、中文路径、无 Excel 场景（验收 A11）。
5. 正式发行前启用 iss 中被注释的 SignTool 代码签名。

## 6. 已知事项与注意事项

| 事项 | 说明 |
|------|------|
| 开发环境 Python 版本 | 本机测试用 Python 3.14；产品基线为 3.12（PySide6 wheel 覆盖更好），打包务必用 3.12 |
| iCloud Drive 副作用 | 工作区在 iCloud 目录下，编辑偶发"保存失败/内容残留"，曾导致 repository.py 尾部重复代码（已修复）；改动大文件后建议跑一次 `python -m compileall apps/desktop tests` |
| 额度与并发参数 | 每日 30 次、并发 1、令牌 TTL 都在 `wrangler.jsonc` vars，改后重新 deploy 即生效 |
| 模型输出 Schema | 固定为 `model/schemas.py` 的 2.0 分类 Schema（`extra="forbid"`）；不兼容旧 1.0 输出，改字段需同步升 `OUTPUT_SCHEMA_VERSION` |
| 提示词版本 | `config.PROMPT_VERSION`，写入每条结果用于审计；改提示词须升版本 |
| Worker 测试 | ImageJudge Worker 已有 OIDC/令牌契约测试；合并后的 Infinity Edge Worker 已通过 `/image-judge/healthz` 与平台未配置场景 smoke test。 |
| 未做项 | Windows loopback 回调安装态实测、代码签名、WebEngine 备用登录视图（文档标注 QWebEngineView 仅备用，当前实现用系统浏览器） |

## 7. 验收对照（文档 §21）

- A01/A02：主界面支持参考图 + 文件夹选择、递归扫描、中文路径、自然排序（`scanner.py`，集成测试覆盖）
- A03：双图顺序固定（`task_engine` + `evaluate.ts`）
- A04：`parse_evaluation_output` 100% Pydantic 校验后才 SUCCEEDED（`test_schemas.py`）
- A05/A06：outbox 同事务 + 原子快照 + 退避重试（`test_csv_sync.py`、集成测试）
- A07：暂停/继续/启动恢复（`task_engine` + `recover_on_startup`，集成测试覆盖）
- A08：429/5xx/超时重试，401 引导重登录（两个 gateway 的错误映射）
- A09/A10：平台 Key 不下发；BYOK Key 仅本次进程内存；日志脱敏在 `log.py`
- A11：CSV 纯标准库生成，不依赖任何表格软件

## 8. 常见问题排查

| 现象 | 排查方向 |
|------|----------|
| 平台登录卡在等待回调 | 检查 loopback 端口（30000-50000 随机）是否被防火墙拦截；Worker `/desktop/authorize` 的 KV 状态 TTL 仅 600 秒 |
| 429 QUOTA_EXCEEDED | 正常限流，次日 UTC 重置；确认 `usage_daily` 计数 |
| 429 CONCURRENCY_LIMIT 频繁 | 检查 DO lease 是否未释放（最长 5 分钟自动过期）；客户端崩溃不会死锁 |
| CSV 不同步 | 查看 UI 的同步积压提示与日志；文件被占用会 RETRY_WAIT 退避重试；可手动"重建 CSV" |
| MODEL_OUTPUT_INVALID | 模型连续两次输出不合规；查看结果详情中的原始文本，必要时升提示词版本 |
| 启动后任务"消失" | 属正常：启动恢复把 RUNNING run 转 PAUSED、PROCESSING 项回收为 PENDING，提示用户续跑 |
