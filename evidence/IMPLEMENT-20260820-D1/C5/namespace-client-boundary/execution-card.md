# Execution Card — C5/namespace-client-boundary

唯一可观察结果：凭证取回和轮换请求只提交服务端分配的 Worker ID，不再把 Namespace 作为
客户端 query 参数发送；Namespace 仍由 D1 policy 和服务器响应提供。

范围：前端 Worker credential API client、调用方和单元测试。没有修改 D1 schema、Worker
credential、Pool 或线上 Redis。
