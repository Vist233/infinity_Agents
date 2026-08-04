# Infinity Agents

## 体验地址

[打开 Infinity Agents](https://infinity.zhangyvjing.com)

## 这个项目能做什么

- **PaperAgent**：检索、阅读和整理论文，支持 PubMed、Europe PMC、arXiv 等公开来源。
- **ImageJudge**：使用参考图和自然语言规则，对目标图片进行结构化分类，并导出 CSV / SQLite 结果。
- **CodeAgent**：提供 Codex 的安装、登录和使用入口。

## 文档

- [技术架构与本地运行](docs/LOCAL_DEVELOPMENT.md)
- [ImageJudge 桌面端说明](image-judge/README.md)
- [Cloudflare 部署说明](https://github.com/Vist233/infinity_Agents/blob/cloudflare-deploy/cloudflare-worker/README.md)

`main` 是完整产品源码；`cloudflare-deploy` 在相同源码之上增加 Cloudflare Worker、Wrangler 配置和线上资源绑定。
