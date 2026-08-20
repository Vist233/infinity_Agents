# Execution Card C6T — production named Relay Tunnel

唯一可观察结果：以管理员控制的命名 Cloudflare Tunnel 和单层 HTTPS 域名
`relay.zhangyvjing.com` 替换临时 Quick Tunnel，同时保持 Redis、Relay、Edge 和 Docker Worker
正常工作。

本卡不修改 Redis 数据、D1/R2 Task/Attempt/Artifact、Worker credential 或 Claude Runtime。
