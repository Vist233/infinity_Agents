# Worker 接入说明（Cloudflare Deploy）

本分支的 Cloudflare 版本使用 Cloudflare Worker 作为控制面；实际执行发生在
受信任的 Mac 或 Windows Docker Worker 中。控制面保存 D1/R2 任务事实，Worker
通过 HTTPS 反向握手、领取 Attempt、下载输入并上传结果。zhangbot 上已有 Redis
保持不变，不启动第二个 Redis。

## 注册

1. 登录 `https://infinity.zhangyvjing.com/code-agent/`，打开任务中心的“添加
   Worker”卡片。
2. 只填写 Namespace 并创建。服务器生成新的 Worker ID 和持久 credential；同一
   Namespace 可以创建任意多个不同 Worker。
3. 将 credential 只保存到目标机器的本地 env 文件。不要提交 Git、写入镜像或
   放入浏览器 Local Storage。

只有超级用户得到 `owner_trusted`；普通用户和学生都是一般机构信任。一个 credential
只绑定一个 Worker ID，同一凭证不能同时连接两个活动实例。

## Worker B 本地容器

本轮 Case 2/3 只使用新建的本地 Worker B；不要修改、重启或撤销现有远程 Worker。
复制 `worker.cloudflare.env.example` 为 `worker-b.cloudflare.env`，填写控制面、
Worker ID、Namespace、持久 credential 和本机 Claude 配置，然后运行：

```sh
docker compose -f docker-compose.cloudflare-workers.yml up -d --build worker-b
docker compose -f docker-compose.cloudflare-workers.yml logs -f worker-b
```

Compose 不启动 PostgreSQL、Redis 或 verifier，也不挂载 Docker socket。Claude Code
直接在该容器内运行；任务目录清理后容器继续在线等待下一个任务。Mac 连接 zhangbot
现有 Redis 时使用：

```sh
zsh -ic 'bash scripts/run_local_cloudflare_workers.sh'
```

该脚本只建立 SSH 隧道并临时覆盖 Redis 地址，不打印或写入 Redis 密码；Windows
可使用 OpenSSH 隧道，并将受保护的 Redis URL 放入本地 env 文件。

## Case 2 / Case 3 闸门

每个执行文档和 ZIP 数据集都必须不超过 25MB。任务完成链路必须为：

```text
connect → heartbeat → poll → accept → download → Claude Code
→ upload → finalize → Task succeeded + Artifact published
```

下载 Artifact 后重新计算 SHA-256，确认与任务详情一致；确认 Worker B 仍在线且
任务目录已清理。不能用手工生成的结果冒充 Worker 执行结果。测试结束只停止本地
Worker B，不删除线上 D1/R2 记录，也不动现有远程 Worker。
