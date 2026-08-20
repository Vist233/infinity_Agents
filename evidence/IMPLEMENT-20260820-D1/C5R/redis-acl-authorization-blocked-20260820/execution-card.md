# Execution Card C5R — Redis Relay ACL authorization boundary

唯一可观察结果：在不修改 zhangbot Redis、Relay、凭证或无关服务的前提下，记录 C5R 所需的
最小授权及当前阻塞原因。

本卡不重跑 Case 2、不创建 Case 3、不手工修改 D1/R2，也不尝试猜测、泄露、轮换或扩大 Redis ACL。
