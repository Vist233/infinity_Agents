# Worker 新机器接入清单

当前 Cloudflare 版本以 D1 + zhangbot 上现有 Redis 为中心。学生或普通用户
不需要 Cloudflare、D1、Redis、PostgreSQL 账号，也不需要把数据库连接串放进
Worker；Worker 只访问 HTTPS Worker Control API。

## 在任务中心创建注册

1. 打开 `https://infinity.zhangyvjing.com/code-agent/`。
2. 在右侧展开“添加 Worker”；默认情况下这块保持折叠。
3. 只填写 Namespace 并提交。Namespace 是可复用的工作范围，同一范围可以
   添加多个不同的 Worker ID。
4. 页面返回服务器生成的 Worker ID 和持久凭证。凭证原文只在创建结果中显示；
   D1 的 `worker_registrations` 只保存 SHA-256 摘要。

信任级别由登录权限生成，不能在浏览器中手动选择：只有 superuser 是
`owner_trusted`，普通用户和学生都是 `institution_trusted`。每台机器的凭证
可以单独撤销，不影响同一 Namespace 下的其他 Worker。

## macOS / Windows 配置

在目标机器上使用 Node 18+ 的无依赖客户端：

```sh
export INFINITY_WORKER_CREDENTIAL='从任务中心复制的持久凭证'
node cloudflare-worker/worker-client.mjs configure \
  --control-url https://infinity.zhangyvjing.com \
  --worker-id '<任务中心返回的 Worker ID>' \
  --namespace '<任务中心填写的 Namespace>'
node cloudflare-worker/worker-client.mjs health
node cloudflare-worker/worker-client.mjs poll
```

Windows 将 `INFINITY_WORKER_CREDENTIAL` 放入 Worker 服务的环境变量，并用
Windows ACL 限制配置文件只对该服务账号可读。客户端配置文件默认写入用户目录
并设置为 0600（Windows 由 ACL 管理）。控制 API 强制 HTTPS。

## 接入边界

- Worker 不直接连接 Cloudflare D1、R2、Redis 或 PostgreSQL。
- Cloudflare Worker 不绑定 zhangbot 的 Redis；Redis 继续由受信服务使用。
- Worker 只轮询自己的授权任务、领取 Attempt、读取精确资源并上传隔离结果。
- Worker finalize 后结果仍处于 `verification_pending`，不能自行把结果提升为用户可见的 succeeded。
- 如果丢失持久凭证，不能从 D1 列表中恢复原文；撤销原 Worker 后重新创建一台即可。

## 旧版本地 Worker

仓库中的旧 Docker/Redis/PostgreSQL Worker 只用于本地兼容测试，不是
`infinity.zhangyvjing.com` 的接入方式。不要把旧版 `worker.env`、数据库密码或
Provider Key 放入学生电脑。
