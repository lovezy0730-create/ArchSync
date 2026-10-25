# ArchSync MVP 运行手册

## 启动 / 停止

- 启动：`pnpm dev`（或 `pnpm start` 直接起服务；`pnpm dev --rebuild` 强制重建前端）。
- 停止：前台运行 Ctrl+C；后台运行时结束 node/tsx 进程即可。
- 端口：默认 4310，可用 `.env` 的 `PORT` 覆盖。绑定非回环地址时 mock 身份自动禁用，服务启动即失败（安全约束）。

## 数据与状态

- 状态文件：`DATABASE_PATH`（默认 `.local/archsync-state.json`）— 快照、备注修订、同步任务。损坏时服务会备份为 `*.corrupt-<ts>` 并以空状态启动（控制台有明确报错）。
- 该文件不入库（`.gitignore` 已含 `.local/`）。删除它等于完全重置（下次访问自动重建 v1 快照）。

## 常见问题

| 现象 | 处置 |
|---|---|
| 页面空白 / 404 | 确认 `apps/web/dist/index.html` 存在；不存在则 `pnpm --filter @archsync/web build` |
| `未发现任何有效的 .archsync/project.yaml` | 仓库根或 `examples/*` 下缺少合法配置；用 `POST /api/v1/config/validate` 定位 YAML 错误 |
| 协作数据显示 `GitHub 未接入` | 未配置 `GITHUB_TOKEN` 且项目无 `collab.demo.json`；两者有其一即有数据 |
| 演示徽标不消失 | 项目带 `collab.demo.json` 时始终标记演示；接入真实数据需配置令牌，不会静默混用 |
| 未提交变更数与实际不符 | commit 后 watcher 会在 ≤1s 内自动重扫（监听 `.git/index`、`HEAD`、`refs/`）；或点 `⟳ 重新扫描` |
| WS 断开 | 客户端指数退避自动重连；重连后重新拉取 roster 与最新快照，无需手动刷新 |

## 安全边界（MVP 实装）

- mock 身份仅限 `127.0.0.1`/`::1` 绑定；否则启动失败。
- 令牌只存在于服务端进程环境；API 响应不含令牌，页面不含令牌。
- 扫描器只调用固定 git 子命令白名单（`rev-parse` / `branch --show-current` / `ls-tree` / `status`），不执行仓库内任何脚本；不跟随符号链接。
- WS 房间按 projectId 隔离，Origin 校验限本机；消息 8 KiB / 10 Hz 限流。
- 备注写入做控制字符清洗与 2000 字上限；乐观锁拒绝静默覆盖。

## 已知限制

见 README「当前限制」。快照历史/SQLite、webhook、PR 变更文件关联、调用链分析均属后续任务包。
