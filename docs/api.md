# ArchSync MVP API 参考

基础路径：`/api/v1`（健康检查在 `/healthz`）。全部 JSON；时间 ISO-8601 UTC。
身份（仅 mock 模式）：请求头 `x-archsync-user: <encodeURIComponent(显示名)>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活探针 |
| GET | `/api/v1/projects` | 项目列表（含演示数据标记、当前版本） |
| GET | `/api/v1/projects/:id/snapshot` | 当前快照；`ETag`/`If-None-Match` 304；首次访问触发构建 |
| GET | `/api/v1/projects/:id/modules/:moduleId` | 模块详情（含备注与修订号） |
| GET | `/api/v1/projects/:id/team` | 成员列表（演示项目来自 fixture） |
| PATCH | `/api/v1/projects/:id/modules/:moduleId/annotation` | 备注乐观锁更新；冲突返回 `409 annotation_conflict` + 当前内容 |
| POST | `/api/v1/projects/:id/sync` | 入队重扫，`202 {jobId}` |
| GET | `/api/v1/jobs/:jobId` | 任务状态 `queued/running/done/error` |
| POST | `/api/v1/config/validate` | `{config: string}` → 定位化校验结果 |
| GET | `/ws?projectId=&user=` | WebSocket presence（见下） |

## 快照语义

- `scope: "local-workspace"` — 快照始终描述**本机工作区**（git 基线 + 磁盘文件），不是远端主线镜像。
- `githubSource`: `live`（配置了令牌并成功）| `demo`（fixture）| `unavailable`（不可用，`freshness=stale`）。
- 内容哈希不变时不发布新版本（无意义版本去重）。
- `implementation` 与 `workflow` 判定矩阵见 `packages/graph/src/index.ts` 顶部注释与测试。

## WebSocket 消息

客户端 → 服务端：`presence.update {cursor?, selectedModuleId?, editingField?, mode?}`、`presence.ping`。
服务端 → 客户端：`hello`、`presence.roster`、`presence.changed`、`presence.left`、`snapshot.published`、`server.error`。

约束：单会话 10 msg/s、8 KiB 上限、非法坐标丢弃；45 s 无心跳判定离线；断线指数退避重连（客户端）。坐标为 React Flow 画布坐标。
