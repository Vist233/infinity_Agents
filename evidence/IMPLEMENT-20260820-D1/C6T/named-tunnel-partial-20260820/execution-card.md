# Execution Card C6T — named Relay Tunnel replacement preflight

唯一可观察结果：创建并安全配置 Cloudflare 管理的 Relay Tunnel，但只在 DNS、远端 connector、
Edge Relay URL 与健康检查都完成后才替换 Quick Tunnel。

不修改 Redis ACL、D1/R2、Task、Worker credential 或现有 Quick Tunnel；没有 DNS 记录和端到端
健康检查时绝不切换生产 Relay URL。
