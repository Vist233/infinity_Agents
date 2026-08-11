# ImageJudge（Trait Extraction）桌面端分发设计与实施计划

> 文档状态：设计基线（不包含本次代码或工作流修改）
>
> 适用范围：`image-judge` 桌面端、官网下载安装入口、GitHub Release 发布链路
>
> 目标：让 Windows、Linux、macOS 的安装包可发现、可校验、可签名、可更新，并把本地处理与远程推理的数据边界清楚告诉用户。
>
> 若由 GPT-5.6 Luna 或千问 Max 实施，本文件决定分发目标与验收，[`MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md`](./MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md) 决定所选单一模型的拆卡、checkpoint、证据和外部发布授权。

## 1. 结论摘要

1. Linux 下载失败的历史根因已经从 Git 历史中确认：旧工作流直接发布脚本生成的版本化文件 `ImageJudge_<version>_amd64.deb`，而前端使用固定链接请求 `ImageJudge-linux-amd64.deb`。GitHub 的 `/releases/latest/download/<asset-name>` 要求资产名精确匹配，因此返回 404。
2. 当前仓库工作流已经在发布前将 `.deb` 重命名为 `ImageJudge-linux-amd64.deb`，所以**未来新发布**可以匹配当前前端链接；但旧的线上 `latest` Release 不会因代码提交自动改变。2026-08-09 实测 `releases/latest` 仍指向 `imagejudge-v0.2.0`，该 Release 只有 `ImageJudge-windows-x64.zip` 和 `ImageJudge_0.2.0_amd64.deb`，固定 Linux URL 最终返回 404。眼前修复动作是从包含重命名修复的提交发布一个版本一致的新 tag，不需要再改一次下载器。
3. 当前没有可交付的 macOS 打包配置：发布工作流只有 Windows 和 Linux；PyInstaller spec 没有 macOS `BUNDLE`、图标、entitlements、签名或 notarization；前端也没有 macOS 下载入口。代码中的 Darwin 数据目录兼容只代表运行时代码考虑过 macOS，不代表已有 macOS 安装包。
4. 正式分发不应只依赖前端硬编码 GitHub 资产地址。建议由 CI 生成一个签名的 `latest.json` manifest，以 manifest 作为下载与更新的唯一事实来源；GitHub Release 存放二进制，Cloudflare 只提供稳定入口、短缓存和 302 跳转，不默认中转大文件。
5. macOS 第一阶段推荐分别发布 Apple Silicon 与 Intel 两个原生安装包。等所有 Python、PySide6、Pillow 等二进制依赖都能稳定产出双架构切片后，再切换为 universal2。

## 2. 当前仓库证据

### 2.1 Linux 固定链接失败的根因

当前 Linux 打包脚本仍然生成带版本号的内部产物：

- `image-judge/scripts/package_linux_deb.sh:20-31` 从 `pyproject.toml` 读取版本并计算输出名。
- `image-judge/scripts/package_linux_deb.sh:71` 输出 `ImageJudge_${version}_amd64.deb`。
- Debian control 中 `Architecture` 当前固定为 `amd64`（`image-judge/scripts/package_linux_deb.sh:44-53`）。

旧版 `.github/workflows/imagejudge-package.yml` 直接上传 `package/ImageJudge_*.deb`，于是 Release 中实际资产名类似：

```text
ImageJudge_0.2.0_amd64.deb
```

前端却一直请求：

```text
https://github.com/Vist233/infinity_Agents/releases/latest/download/ImageJudge-linux-amd64.deb
```

该地址定义在 `frontend/app/image-judge/page.tsx:10-14`。GitHub 的 `latest/download` 不是通配符解析，它会在最新正式 Release 中寻找完全同名的资产。因此“Release 有 `.deb` 文件”与“固定链接可下载”并不是一回事。

提交 `fe7fda9` 已在现有工作流中加入重命名步骤：

```text
ImageJudge_<version>_amd64.deb
        -> ImageJudge-linux-amd64.deb
```

对应 `.github/workflows/imagejudge-package.yml:93-103`。这修复的是下一次由该工作流创建的 Release。

2026-08-09 的线上实测已经确认当前故障仍然存在：

1. `https://github.com/Vist233/infinity_Agents/releases/latest` 通过 302 指向 `imagejudge-v0.2.0`。
2. 该 Release API 返回的资产只有 `ImageJudge-windows-x64.zip` 与 `ImageJudge_0.2.0_amd64.deb`。
3. 前端固定 Linux URL 先被解析到该 tag，随后因 Release 内不存在 `ImageJudge-linux-amd64.deb` 而返回 404。

因此，短期修复不应继续修改下载器或再发明一个资产名。应先统一下一版本号，从已经包含 `fe7fda9` 重命名逻辑的提交发布一个新的 `imagejudge-vX.Y.Z` tag，让工作流真正上传 `ImageJudge-linux-amd64.deb`，再执行发布后下载与校验测试。

即使新 tag 修复了眼前 404，直接依赖仓库级 `/releases/latest/download/...` 仍然脆弱。这个仓库承载多个产品；GitHub 的 `latest` 是整个仓库的最新正式 Release，不会按 `imagejudge-v` tag 前缀替客户端筛选。未来若其他产品发布了更晚的正式 Release 且没有 ImageJudge 资产，同一个固定链接可能再次 404。长期必须改为按产品与 channel 维护的签名 manifest；stable 指针只接受 `imagejudge-v<semver>`，不能把仓库级 `latest` 当成 ImageJudge 专属频道。

此外，`image-judge/README.md:32-35` 仍将 Linux Release 文件描述为 `ImageJudge_<version>_amd64.deb`，与当前对外稳定名不一致，后续实现阶段需要同步更新文档。

### 2.2 当前 macOS 状态

目前只能说“部分代码可能在 macOS 上运行”，不能说“已经支持 macOS 分发”：

- `.github/workflows/imagejudge-package.yml:18-103` 只有 Windows 与 Linux 构建任务。
- Release 任务只依赖 `[windows, linux]`，没有 macOS 产物。
- `image-judge/apps/desktop/imagejudge.spec:44-60` 的 `target_arch`、`codesign_identity`、`entitlements_file` 都为空。
- spec 中没有 macOS 所需的 `BUNDLE(...)`，也没有 `.app`、`.icns`、entitlements、DMG 或 PKG 配置。
- `frontend/app/image-judge/page.tsx:16` 只识别 `windows | linux | other`，下载卡片也只有 Windows 与 Linux。
- `image-judge/apps/desktop/imagejudge/config.py:83-91` 使用了 macOS 的 `~/Library/Application Support/ImageJudge` 数据目录，这是运行时路径兼容，不是打包能力。
- `image-judge/docs/HANDOVER.md:91-100` 仍将 macOS 定位为开发环境，并说明正式功能验证需要 Windows。

因此，macOS 需要完整新增一条原生构建、签名、公证、打包与验证链路。

### 2.3 其他发布一致性问题

当前版本号没有完全单一来源：

- `image-judge/pyproject.toml`：`0.2.0`
- `image-judge/apps/desktop/imagejudge/config.py`：`0.2.0`
- `image-judge/installer/imagejudge.iss`：`0.1.0`

Windows Inno Setup 签名配置目前也是注释状态。发布实现时，tag、Python 包版本、应用显示版本、安装器版本、manifest 版本必须由 CI 强制一致；任何一处不一致都应阻止 Release 发布。

## 3. 分发架构

推荐将“发现最新版本”和“下载大文件”分离：

```text
官网 / 桌面端更新检查
        |
        | GET /downloads/imagejudge/stable/latest.json
        v
Cloudflare 稳定入口（校验、短缓存、无用户文件）
        |
        | 读取 CI 生成并签名的 manifest
        v
GitHub Release API / Release Asset
        |
        | 返回版本、平台资产、SHA-256、签名与下载地址
        v
客户端选择正确 OS/架构
        |
        | 302 或直接下载 browser_download_url
        v
GitHub Release 二进制资产
```

关键边界：

- Cloudflare 不接触用户选择的图像目录、SQLite 数据库、CSV 结果、模型密钥或推理输入。
- 默认不通过 Worker 反向代理安装包内容，避免不必要的流量、超时和成本；Worker 返回 manifest 或 302 到 GitHub/R2。
- manifest 是下载与自动更新的事实来源；前端硬编码 URL 只能作为临时兼容回退。
- 每个已发布版本的 manifest 与资产应不可变。`latest.json` 只是指向当前稳定版本的可变指针。

## 4. 稳定 manifest 与 latest API

### 4.1 推荐 manifest

CI 在 Release 发布前根据真实产物生成 `ImageJudge-latest.json`，同时保留一份带版本号的不可变副本，例如 `ImageJudge-0.2.1.json`。

建议最小结构：

```json
{
  "schema_version": 1,
  "product": "ImageJudge",
  "channel": "stable",
  "version": "0.2.1",
  "release_tag": "imagejudge-v0.2.1",
  "published_at": "2026-08-09T00:00:00Z",
  "minimum_supported_version": "0.2.0",
  "release_notes_url": "https://github.com/Vist233/infinity_Agents/releases/tag/imagejudge-v0.2.1",
  "artifacts": {
    "windows-x86_64-installer": {
      "file": "ImageJudge-windows-x86_64-setup.exe",
      "url": "https://github.com/Vist233/infinity_Agents/releases/download/imagejudge-v0.2.1/ImageJudge-windows-x86_64-setup.exe",
      "size": 123456789,
      "sha256": "<64 lowercase hex characters>",
      "signature": "authenticode"
    },
    "linux-x86_64-deb": {
      "file": "ImageJudge-linux-x86_64.deb",
      "url": "https://github.com/Vist233/infinity_Agents/releases/download/imagejudge-v0.2.1/ImageJudge-linux-x86_64.deb",
      "size": 123456789,
      "sha256": "<64 lowercase hex characters>",
      "signature": "manifest"
    },
    "macos-arm64-dmg": {
      "file": "ImageJudge-macos-arm64.dmg",
      "url": "https://github.com/Vist233/infinity_Agents/releases/download/imagejudge-v0.2.1/ImageJudge-macos-arm64.dmg",
      "size": 123456789,
      "sha256": "<64 lowercase hex characters>",
      "signature": "developer-id-notarized",
      "minimum_os": "13.0"
    },
    "macos-x86_64-dmg": {
      "file": "ImageJudge-macos-x86_64.dmg",
      "url": "https://github.com/Vist233/infinity_Agents/releases/download/imagejudge-v0.2.1/ImageJudge-macos-x86_64.dmg",
      "size": 123456789,
      "sha256": "<64 lowercase hex characters>",
      "signature": "developer-id-notarized",
      "minimum_os": "13.0"
    }
  }
}
```

manifest 还应作为整体生成 detached signature，例如：

```text
ImageJudge-latest.json
ImageJudge-latest.json.minisig
SHA256SUMS
SHA256SUMS.minisig
```

客户端内置发布公钥，只信任签名正确、schema 受支持、产品名正确、渠道匹配的 manifest。私钥只存在于受保护的发布环境。

### 4.2 latest API 规则

建议稳定入口：

```text
GET https://<product-domain>/downloads/imagejudge/stable/latest.json
GET https://<product-domain>/downloads/imagejudge/beta/latest.json
```

处理规则：

1. stable 只接受非 draft、非 prerelease、tag 满足 `imagejudge-v<semver>` 的 Release。
2. beta 不能依赖 GitHub `/releases/latest`，因为该接口面向最新正式 Release；beta 应由独立 manifest 或明确 tag/channel 指针维护。
3. Worker 只接受预定义的 GitHub owner/repo、资产名、HTTPS 下载域和 manifest schema，不能接受客户端传入任意上游 URL。
4. 对 GitHub API 结果做短缓存并使用 ETag；上游不可用时可返回最近一次已验证的 manifest，但必须带 `stale` 或缓存时间信息。
5. 若 manifest 签名错误、版本/tag 不一致、资产缺失、同一平台资产重复或 SHA-256 缺失，则 fail closed，不返回可安装版本。
6. 二进制下载优先返回 302，避免 Worker 成为大文件流量中转。
7. 响应不设置基于用户身份的下载差异，不记录用户图像或本地文件信息。

GitHub 官方提供 `GET /repos/{owner}/{repo}/releases/latest` 来获取最新正式 Release，并在响应的 `assets` 中返回资产名、下载地址、大小等元数据。实现时可使用该 API 做上游发现，但仍应以 CI 生成且签名的 manifest 为最终发布契约：

- <https://docs.github.com/en/rest/releases/releases#get-the-latest-release>
- <https://docs.github.com/en/rest/releases/assets#get-a-release-asset>

## 5. 资产命名规范

### 5.1 统一格式

对外文件名使用明确的 OS、CPU 架构与封装格式：

```text
ImageJudge-windows-x86_64-setup.exe
ImageJudge-windows-x86_64-portable.zip
ImageJudge-linux-x86_64.deb
ImageJudge-linux-aarch64.deb
ImageJudge-macos-arm64.dmg
ImageJudge-macos-x86_64.dmg
ImageJudge-macos-universal2.dmg
```

每个 Release 内可以使用上述稳定文件名，版本由 Release tag 与 manifest 表达。若需要人工下载时一眼看到版本，可额外生成版本化显示名，但不得让官网或更新器靠猜测版本化文件名工作。

### 5.2 Linux 架构映射

不同生态的架构名称不一致，应在构建脚本中显式映射：

| CPU | manifest / 资产名 | Debian `Architecture` | 常见 `uname -m` |
|---|---|---|---|
| Intel/AMD 64-bit | `x86_64` | `amd64` | `x86_64` |
| ARM 64-bit | `aarch64` | `arm64` | `aarch64` / `arm64` |

当前 Linux job 在 `ubuntu-latest` 上构建，control 固定 `amd64`，因此它只能声明为 x86_64/amd64。不能把 x86_64 PyInstaller 产物简单改名成 arm64；每个架构必须使用对应原生 runner 或经过验证的交叉构建环境重新冻结所有二进制依赖。

迁移建议：

- 新规范主文件使用 `ImageJudge-linux-x86_64.deb`。
- 当前 `ImageJudge-linux-amd64.deb` 可在一个过渡版本内保留兼容别名，随后由 manifest 引导到新名称。
- Linux 构建应基于所支持范围内最老的 glibc 环境，避免在新 runner 构建后无法在旧发行版运行。
- MVP 验证 Ubuntu 22.04、Ubuntu 24.04、Debian 12，覆盖 X11 与 Wayland 会话以及 Qt xcb 依赖。
- AppImage 可作为后续便携格式，不是第一阶段阻塞项。

## 6. macOS 打包策略

### 6.1 第一阶段：双原生架构（推荐）

分别在原生 runner 上构建：

```text
macOS arm64 runner  -> ImageJudge-macos-arm64.dmg
macOS x86_64 runner -> ImageJudge-macos-x86_64.dmg
```

这样可避免仅主程序是 universal2、但 PySide6/Pillow/其他 native extension 缺少某个架构切片的“伪 universal”问题，也便于逐架构做启动测试。

所需配置：

- PyInstaller spec 新增 macOS `BUNDLE(...)`。
- 固定 bundle id，例如 `com.zhangyvjing.imagejudge`。
- 使用 `.icns` 图标与正确的 `Info.plist`。
- 应用版本、短版本与构建号由 `pyproject.toml`/tag 单一生成。
- 明确 `LSMinimumSystemVersion`，第一版建议以实际依赖验证结果决定，不在未测试前承诺旧系统。
- 将 `.app` 放入签名并公证的 DMG；如需企业批量安装，再增加 PKG。

### 6.2 第二阶段：universal2

只有满足以下条件时才发布 `ImageJudge-macos-universal2.dmg`：

1. 使用支持 universal2 的 Python 运行时。
2. PyInstaller 使用 `target_arch="universal2"`。
3. PySide6、shiboken6、Pillow 和所有 Mach-O 扩展都含 `arm64` 与 `x86_64` 切片。
4. CI 对 `.app` 内每个 Mach-O 文件执行架构检查；任一依赖缺少切片即失败。
5. 在 Intel Mac 与 Apple Silicon Mac（包括 Rosetta 未参与的原生启动）分别做启动和最小任务验证。

如果 Intel 构建资源不可持续，可明确只支持 Apple Silicon，但官网与 manifest 必须把该限制写清楚，不能让 Intel 用户下载后才发现不能运行。

## 7. 签名与 macOS notarization

### 7.1 macOS

发布顺序应固定为：

```text
构建 .app
  -> 先签内部 dylib/framework/helper
  -> 签整个 .app（Hardened Runtime）
  -> 验证签名
  -> 制作并签名 DMG
  -> notarytool 提交并等待结果
  -> staple 公证票据
  -> Gatekeeper 与 staple 离线验证
```

要求：

- 使用 `Developer ID Application` 证书与 hardened runtime。
- entitlements 保持最小化；网络客户端权限按实际推理/API 访问需要开启，不要默认加入调试、任意 JIT 或关闭 library validation 等高风险权利。
- CI 使用 App Store Connect API key 或 Apple 官方支持的凭据方式调用 `xcrun notarytool`。
- 证书 P12、密码、Team ID、notarization 凭据放在 GitHub Environment secrets；fork PR 不获得这些 secrets。
- 发布前执行 `codesign --verify --deep --strict`、`spctl --assess --type execute` 与 `xcrun stapler validate`。

### 7.2 Windows

- 使用 Authenticode 对主程序和最终安装器签名，并使用可信时间戳服务。
- 当前 Inno Setup 文件中的签名命令是注释状态，正式发布前必须启用实际签名步骤。
- 如果同时提供 portable ZIP，ZIP 中的 EXE 也必须已签名。
- SmartScreen reputation 不能仅靠代码解决，但稳定证书、稳定 publisher 和持续签名可逐步建立信誉。

### 7.3 Linux 与跨平台完整性

- 每个资产生成 SHA-256，写入 `SHA256SUMS` 和 manifest。
- 对 manifest/SHA256SUMS 做 detached signature（例如 minisign，或采用符合团队密钥管理能力的等价方案）。
- OS 原生签名与 SHA-256 解决不同问题，两者都保留：原生签名确认发布者身份，哈希确认下载内容未变化。
- HTTPS 不能替代资产校验。
- 发布密钥不得存入仓库、桌面端、普通构建 artifact 或 PR 日志。

## 8. 自动更新设计

当前仓库没有桌面端自动更新实现。建议分两期，避免 MVP 一开始就引入高风险的自更新安装权限。

### 8.1 MVP：只检查、不静默安装

- 启动后延迟检查或由用户点击“检查更新”。
- 请求签名 manifest，使用 ETag、合理超时和指数退避。
- 本地按 semantic version 比较 stable/beta 对应版本。
- 只显示新版本、说明、文件大小、目标架构和隐私提示。
- 用户确认后由系统浏览器下载或打开官方安装页。
- 正在执行图片分析任务时不弹窗抢占，也不启动大文件下载。
- 离线、上游故障或签名失败不影响现有本地功能；签名失败必须提示安全错误并拒绝下载。

### 8.2 后续：受控下载与安装

- 仅在用户明确同意后后台下载到应用专用临时目录。
- 依次校验 manifest 签名、资产 SHA-256、平台原生签名。
- 防止降级安装；只有显式恢复模式才能安装较旧版本。
- 下载完成后提示“退出并安装”，不在任务运行中替换进程文件。
- 保留上一版本或至少保留可回滚安装器；更新失败不得破坏用户 SQLite、设置和结果 CSV。
- Windows 使用已签名安装器；macOS 使用已公证 `.app`/DMG 与专用 helper；Linux `.deb` 默认提示用户通过系统包管理流程安装，不让应用静默获取 sudo 权限。
- stable 与 beta 使用独立 manifest，切换频道需要用户显式操作。

更新检查的最小请求信息应限制为：产品名、当前版本、OS、CPU 架构、更新频道。不要发送设备唯一 ID、用户名、图像路径、目录名、SQLite 内容、图片或模型密钥。提供“关闭自动检查”的设置。

## 9. GitHub Release CI 设计

### 9.1 触发与权限

- 只允许格式严格匹配 `imagejudge-vX.Y.Z` 的 tag 触发正式发布。
- PR 与普通分支只构建测试 artifact，不创建 Release，不接触签名 secrets。
- 构建 job 保持只读权限；只有最终 release job 使用最小化的 `contents: write`。
- 第三方 GitHub Actions 应固定到审核过的 commit SHA，降低供应链漂移风险。

### 9.2 推荐流水线

```text
tag 校验
  -> 版本一致性校验
  -> 单元/集成测试
  -> 原生 OS/架构矩阵构建
  -> 产物启动与版本 smoke test
  -> OS 原生签名
  -> 打包
  -> SHA-256 / SBOM / provenance
  -> 创建 Draft Release
  -> 上传全部资产
  -> 从真实资产生成 manifest 并签名
  -> 校验 manifest 中每个 URL/size/hash
  -> 发布 Release
  -> latest API 与官网链接发布后 smoke test
```

建议矩阵：

| 平台 | 架构 | 第一阶段产物 | 备注 |
|---|---|---|---|
| Windows | x86_64 | signed setup EXE；可选 portable ZIP | 当前 ZIP 路线可保留，但安装器版本要同步 |
| Linux | x86_64/amd64 | DEB | 当前已有基础，需改为显式架构契约 |
| Linux | aarch64/arm64 | DEB | 有真实 runner 和依赖验证后加入 |
| macOS | arm64 | signed/notarized DMG | 第一阶段必做 |
| macOS | x86_64 | signed/notarized DMG | 有 Intel runner 时第一阶段做 |
| macOS | universal2 | signed/notarized DMG | 双架构依赖完全验证后替代双包 |

### 9.3 发布阻断条件

以下任一情况都必须让 CI 失败，不能发布不完整 Release：

- tag、`pyproject.toml`、应用显示版本、安装器版本不一致。
- 预期平台资产缺失或同一平台出现多个冲突资产。
- 资产名不符合规范。
- SHA-256、manifest 签名或 OS 原生签名验证失败。
- macOS notarization 或 staple 失败。
- manifest URL 与实际 Release tag/资产不一致。
- 发布后 `latest.json`、每个稳定下载入口或校验下载失败。
- 应用 smoke test 无法启动或报告错误版本。

## 10. 隐私说明要求

ImageJudge 的分发页和桌面端首次使用说明必须区分“本地资产管理”和“远程模型推理”。不能笼统宣称“图片永不离开设备”，因为当前产品能力会将图片交给用户选择的远程视觉模型或平台代理进行判断。

建议公开说明至少包含：

### 10.1 保持在本地的数据

- 用户选择的图片目录本身。
- 本地 SQLite 数据库、任务状态和导出的 CSV。
- 尚未提交远程推理的文件。
- 下载/更新过程不会扫描或上传图片目录。

### 10.2 可能发送到远程服务的数据

- 参考图片。
- 当前待判断的目标图片，可能经过本地缩放或预处理。
- 任务提示词、标签规则和完成推理所需的请求元数据。
- BYOK 模式发送到用户配置的模型服务；平台模式发送到 Infinity Worker，再由其调用模型提供商。

用户在首次启用远程推理前应看到目标服务、发送内容类别和密钥处理方式，并做明确确认。更新检查本身不应发送图片、图片路径或模型密钥。

### 10.3 日志、崩溃报告与删除

- 崩溃报告默认关闭或明确 opt-in，上传前对路径、文件名、prompt、token 和密钥做脱敏。
- 文档写明本地数据实际目录，以及卸载应用是否保留数据库和结果。
- 提供“仅删除应用”和“同时删除本地数据”的明确选择或操作指引。
- CDN/Worker 下载日志只保留常规安全与容量所需信息，不添加跨站用户标识，不与图像分析记录关联。

## 11. 验收矩阵

### 11.1 发布与链接

| 编号 | 场景 | 验收标准 |
|---|---|---|
| R-01 | 发布新 stable tag | Release 包含 manifest 声明的全部资产，无重复平台键 |
| R-02 | 官网下载 | 每个按钮根据实际 OS/arch 选择正确资产，返回 200 或受控 302 |
| R-03 | Linux 历史回归 | 不再假设 `ImageJudge_<version>_amd64.deb`；稳定入口可下载并校验 |
| R-04 | 旧 Release 共存 | 新版 latest 不受旧版本化资产名影响；旧版本固定 tag URL仍可访问 |
| R-05 | manifest | JSON schema、签名、size、SHA-256 与真实资产完全一致 |
| R-06 | 发布缺包 | 删除任一预期资产后，CI 必须阻止发布 |
| R-07 | 版本错位 | 修改任一应用/安装器版本使其与 tag 不同，CI 必须失败 |
| R-08 | prerelease | beta 不覆盖 stable `latest.json`，stable 用户不会收到 prerelease |

### 11.2 平台安装与运行

| 平台 | 最低验证环境 | 安装/启动 | 最小功能 | 升级/卸载 |
|---|---|---|---|---|
| Windows x86_64 | Windows 10、11 | 签名有效，无损安装与首次启动 | 选目录、加载参考图、完成一个小任务、导出 CSV | 升级保留数据库；卸载行为符合说明 |
| Linux x86_64 | Ubuntu 22.04、24.04；Debian 12 | DEB 架构正确，依赖清晰，X11/Wayland 可启动 | 同上，覆盖 Unicode/空格/长路径 | 包管理器升级保留用户数据 |
| Linux aarch64 | 支持后使用真实 ARM64 环境 | 不允许将 x86_64 产物改名冒充 | 同上 | 同上 |
| macOS arm64 | macOS 13、14、15 | Gatekeeper 接受，签名/公证/staple 有效 | 原生启动并完成小任务 | 更新后数据保留，DMG 卸载说明清楚 |
| macOS x86_64 | 实际承诺支持的 Intel macOS | 不依赖 Rosetta 冒充原生包 | 同上 | 同上 |
| macOS universal2 | 进入第二阶段后 | 所有 Mach-O 同时含两种架构 | 两类机器均原生通过 | 同上 |

### 11.3 安全与更新

| 编号 | 测试 | 验收标准 |
|---|---|---|
| S-01 | 篡改二进制一个字节 | SHA-256 校验失败，禁止安装 |
| S-02 | 篡改 manifest | 签名校验失败，禁止解析下载地址 |
| S-03 | 替换为非 allowlist 域名 | Worker/客户端拒绝 |
| S-04 | 降级攻击 | 非恢复模式拒绝低版本 |
| S-05 | 签名证书异常 | Windows/macOS 安装被 CI 或客户端阻断 |
| S-06 | 更新时任务运行中 | 仅提示或延后，不中断任务、不替换运行文件 |
| S-07 | 更新失败/断网 | 当前版本仍可启动，用户数据不损坏 |
| S-08 | 无网络启动 | 本地功能可用，更新检查快速降级且不反复弹窗 |
| S-09 | 更新隐私抓包 | 请求中无图像、图像路径、目录名、prompt、模型密钥或唯一设备 ID |
| S-10 | Release secrets | PR/fork 日志与 artifact 中不存在签名或 notarization 凭据 |

### 11.4 下载入口与交互

- macOS 下载卡片能识别 Apple Silicon 与 Intel；识别失败时让用户明确选择，并解释查看架构的方法。
- Linux 页面使用“x86_64（Debian/Ubuntu）”等用户能理解的文案，不只显示内部 `amd64` 名称。
- 页面显示版本、发布日期、包大小、支持系统、SHA-256 查看入口和隐私说明。
- 不支持的平台不伪装成可下载；提供源码/等待列表或明确状态。
- 下载按钮最终选择来自 manifest，不在多个前端页面复制资产 URL。

## 12. 分阶段实施顺序

### Phase 0：修复线上 Linux 可用性

1. 以 2026-08-09 的线上核验结果为基线：latest 为 `imagejudge-v0.2.0`，缺少 `ImageJudge-linux-amd64.deb`，当前固定 Linux URL 返回 404。
2. 统一并提升下一版本号，确保 tag、`pyproject.toml`、应用显示版本和安装器版本一致。
3. 从已经包含 `fe7fda9` 重命名修复的提交发布一个新的 `imagejudge-vX.Y.Z` tag；短期不再修改下载器。
4. 发布后从未登录环境验证固定链接、文件大小、DEB 架构和 SHA-256，并验证 `latest` 当前确实指向这个新 Release。
5. 同步 README 中过时的版本化资产名。

### Phase 1：建立发布契约

1. 确定单一版本来源和规范资产名。
2. CI 生成 SHA256SUMS、不可变版本 manifest 和 `latest.json`。
3. 官网改为读取 manifest，并保留短期硬编码回退。
4. 添加发布后下载 smoke test。
5. 将 GitHub Release job 收紧到最小权限和固定 action 版本。

### Phase 2：macOS 双架构发布

1. 添加 `.app` BUNDLE、图标、Info.plist 和最小 entitlements。
2. 分别构建 arm64/x86_64。
3. 配置 Developer ID 签名、notarytool、staple 与 Gatekeeper 验证。
4. 发布两个 DMG 并在 manifest/前端按架构分流。
5. 在真实 Apple Silicon 与 Intel 设备完成验收矩阵。

### Phase 3：更新体验与供应链加固

1. 桌面端加入“检查更新”，先只提示和打开官方下载页。
2. 对 manifest 和 SHA256SUMS 做签名验证。
3. 生成 SBOM/provenance，并完善依赖与签名审计。
4. 评估受控后台下载、退出安装和回滚。
5. 依赖条件成熟后评估 macOS universal2、Linux arm64 与 AppImage。

## 13. 本次审查边界

本文件基于当前本地仓库、相关 Git 历史、GitHub 官方 Release API 语义，以及 2026-08-09 对线上 Release 和固定下载 URL 的实测结果形成。本次只新增和更新设计文档，没有修改 ImageJudge 代码、前端下载逻辑、打包脚本或 GitHub Actions。

本地代码与 Git 历史证明了资产命名冲突和当前工作流中的重命名修复；线上实测进一步证明修复尚未通过新 tag 发布：`releases/latest` 仍指向 `imagejudge-v0.2.0`，它只有 Windows ZIP 与版本化 Linux DEB，固定 Linux URL 仍为 404。只有完成 Phase 0 的新 Release 与发布后测试，才能宣告当前线上故障关闭。随后仍应完成 manifest 迁移，以消除仓库级 `latest` 被其他产品 Release 改变的长期风险。
