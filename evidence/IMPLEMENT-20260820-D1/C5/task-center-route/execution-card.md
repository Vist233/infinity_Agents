# Execution Card — C5/task-center-route

唯一可观察结果：Task Center 直接创建必须调用 `/api/tasks/direct`，并携带
`agent_confirmation=false`；Analysis 的确认创建继续调用 `/api/tasks`。

根因：前端 `createTask({ direct: true })` 只修改了请求体，却仍调用了普通 `/api/tasks`；
Edge 将该组合按错误来源拒绝，导致任务未创建，随后详情导航出现 `Task Not Found`。

范围：前端 API client、Task Center 浏览器用例和本卡证据。没有修改 D1 数据、历史任务或
Worker credential。
