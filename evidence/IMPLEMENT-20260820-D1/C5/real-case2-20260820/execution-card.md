# Execution Card — C5 / real-case2-20260820

唯一可观察结果：真实 Case 2 从线上 Task Center 进入 D1，由本机 v2 Docker Worker 执行到
Claude 输出和 Artifact multipart 阶段；D1 最终将 3 次失去 lease 的 Attempt 置为 failed。

本卡记录失败证据，不把 Claude 生成的报告、中间文件或 Worker 在线状态当作 Artifact 通过。
