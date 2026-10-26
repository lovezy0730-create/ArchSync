# 已知问题与限制（v1.0）

## 功能边界（设计如此，非缺陷）

- **静态模式无实时协作**：WebSocket 光标/在线状态/备注保存仅在本地完整模式；静态模式 UI 明确禁用并标注（"无实时协作"徽标），不伪装支持。
- **依赖分析仅 TS/JS**：Python/Go/Rust 等语言不解析；`dependencyAnalysis` 如实输出 `partial`。解析不了的 import 记为 unresolved，不虚构边。
- **Agent 报告 ≠ 事实**：`.archsync/agent-reports.jsonl` 每条 `authoritative:false`，不参与快照状态计算。
- **init 向导的层分配是启发式**：目录名匹配 + 组件文件探测，输出中明确标注「请人工确认」；依赖建议来自真实 import（非猜测）。

## 已知限制

1. **匿名 GitHub API 限流 60 req/h/IP**：PR files/checks 按预算拉取（默认前 12 个 PR：open 优先），超出预算的 PR 保持 `checks=unknown`、`changedFiles=[]` 并整体标注 stale。私有大仓库建议用本地模式 + GITHUB_TOKEN。
2. **本地模式的快照历史未持久化多版本**：状态存储仍为 JSON 文件（单当前版本 + 备注修订）；SQLite 历史库属后续任务（静态模式已有多版本 + 差异）。
3. **live 模式（token）不逐 PR 拉变更文件**：模块↔PR 关联依赖配置 issues 映射与路径（changedFiles 为空）。静态匿名管线反而有 PR files。
4. **静态 bundle 体积 ~570KB（gzip ~180KB）**：YAML 导入功能把 yaml+zod+graph 打入前端；可按需 code-split 优化。
5. **import 分析为正则解析**：覆盖 import/export from/require/dynamic import 常见形态；动态拼接的导入无法覆盖（记为 external）。
6. **CI 内浏览器 E2E 未部署**：本轮以等效 browser-use 真实浏览器验收；Playwright 进 CI 待做。
7. **快照历史分支首跑**：`site-snapshots` 分支在首次 CI 运行时由 bot 创建；若仓库禁用了 Actions 推送，需要手动建分支。
8. **移动端为可用级适配**（侧栏收起、画布可操作），未针对触控手势深度优化。

## 安全限制

- 访问码为单一共享码（无个人账户体系）；会话 12h。登录按 IP 限流（15 分钟窗口 10 次失败 → 429），但 per-IP 计数在直连/标准代理下可信（取 socket peer IP），若前置代理改写连接来源需重新评估。适合小团队/个人公网演示，不适合多租户。
- CSRF 防护为双层：SameSite=Lax cookie + 写操作 same-origin 断言；未引入 CSRF token（同源 JSON API 威胁模型下可接受，多租户时必须重审）。
- 静态站点一旦发布即公开：务必只用 `publishStatic: true` + 公开数据，敏感仓库绝不开启。

## 归档与同步边界（2026-10-26 RC 轮更新）

- `site-snapshots` 归档 job 的逻辑已在与 CI 相同的脚本上用本地 bare remote 验证四种场景（初始化/追加/无变化/冲突重试），**尚未在 GitHub 真实远端首跑**——合并后需观察第一次 Actions 运行。
- PR 创建/更新事件只触发 PR 检查（preview artifact），**不发布、不写历史**；公开协作数据的刷新通道为 main push / issues 事件 / 每周对账 / 手动触发。PR 合并即 push → 立即发布。
- 静态站显示的 GitHub 协作数据是**构建时获取**（顶栏标「构建时数据」），非实时 WebSocket；实时协作仅在本地完整模式。


---

# v1.1 已知问题（2026-10-26）

1. **Windows 文件监听默认 polling**：Windows fs.watch 在嵌套 watch root 下会静默丢事件（已实测），故 Windows 默认启用 polling（interval 1.2s）；`ARCHSYNC_WATCH_POLLING=0` 可关闭。CPU 成本随仓库规模上升，超大树建议缩小监听范围。
2. **node:sqlite 为实验性内置**：Node ≥22.5 提供；升级 Node 大版本时需回归 db.ts。JSON 状态文件仍是快照/备注的真值来源（SQLite 目前承载注册表/ETag/事件，双存储将在后续统一）。
3. **GitHub 轮询对私有仓库需 GITHUB_TOKEN 环境变量**（本地服务进程注入）；Token 不入库不落盘。UI 内配置 Token 的安全存储属后续任务。
4. **事件时间线无自动清理**：sync_events 无限增长（MVP）；后续加保留窗口。
5. **add-github-remote 为只读分析**：不自动克隆；克隆+初始化的手动流程已写 README。
