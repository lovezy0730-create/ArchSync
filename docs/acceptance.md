# v1.0 Release Candidate 验收记录

> 全部条目为**实际执行**的结果。明确区分四种状态：已实现 / 已自动测试 / 已浏览器实测（本地预览）/ **已生产验证（线上 Pages）**。
> 最后更新：RC 集成验证轮（feat/v1.0 @ merge of feat/deploy-readiness）。

## 自动化命令门禁（集成分支：#3 + #7 合并态）

| 命令 | 结果 | 备注 |
|---|---|---|
| `pnpm lint` | ✅ 0 error | ESLint flat config |
| `pnpm typecheck` | ✅ 6 packages | strict TS |
| `pnpm test` | ✅ **86 用例全绿** | 3 contracts + 15 scanner + 10 config + 20 graph + 7 web + 31 server |
| `pnpm build` | ✅ | 本地模式 bundle |
| `pnpm build:pages` | ✅ | /ArchSync/ base |
| `pnpm verify:pages` | ✅ | 零 /api·/ws 引用、零凭据、schema 校验 |

> 各 PR 单独 CI 的数字：PR #7 分支 71、PR #3 分支 74 —— **86 是两者合并后的集成数字**，对应集成分支真实运行结果。

## 历史归档集成验证（本轮新增，scripts/archive-history.sh）

| 场景 | 结果 |
|---|---|
| 1. 分支不存在 → 孤儿初始化 | ✅ 只提交 history/（index.json + v1.json），**无 main 源码树** |
| 2. 快照变化 → 追加版本 | ✅ v2 新提交，v1 保留 |
| 3. 重复构建（内容无变化） | ✅ 不产生提交（分支 SHA 不变） |
| 4. 推送冲突（他人先推） | ✅ fresh-clone 重试一次成功，history 规范化为生成器输出 |

验证方式：本地 bare remote 上运行**与 CI 完全相同**的 `scripts/archive-history.sh`。
**尚未生产验证**：GitHub 真实远端的 archive job 首跑（需合并后观察 Actions 运行）。

## 鉴权安全回归（PR #3 集成态，本轮实测）

| 项 | 结果 |
|---|---|
| 未登录读 projects/snapshot/module/team | ✅ 全部 401（统一门） |
| 未登录 POST sync | ✅ 401 |
| 未登录 config/validate | ✅ 401 |
| 登录成功 → HttpOnly/SameSite=Lax cookie | ✅（production 加 Secure） |
| 有效会话读取 | ✅ 200 |
| 10 次错误登录后第 11 次（即使正确码） | ✅ 429（IP 限流 15 分钟窗，单测覆盖成功清零/窗口重置） |
| 跨源写（evil origin） | ✅ 403（isSameOrigin）；CORS 拒绝不再 500 |
| WS 无会话 | ✅ close 4003 |
| mock 模式匿名读取 | ✅ 200（仅回环，行为不变） |

## 浏览器实测（本地预览：preview:pages / pnpm dev，Chromium 1600×950）

| 场景 | 结果 |
|---|---|
| 静态 /ArchSync/ 自举项目 | ✅ 「GitHub 实时」徽标、14 模块、三态图例（已确认 12 / 仅规划 11 / 代码漂移 6）、登录框正确跳过 |
| 性能（合成 50 模块/110 边） | ✅ 本轮：切换+渲染 **271ms**、点击高亮 **391ms**、15 节点保持高亮、其余淡出 |
| 历史差异（真实 v1→v2） | ✅ 「Agent 接口：1 → 2 个文件」 |
| YAML 导入 | ✅（v1.0 前轮已验，本轮集成态回归通过） |
| 本地完整模式 | ✅ 「本地服务」徽标、重扫按钮、WS 连接、0 控制台错误（集成态截图 docs/screenshots/integration-*.png） |
| 静态模式交互期网络请求 | ✅ 0 fetch（bundle 零 /api·/ws 字符串，verify:pages 强制） |

## 真实数据链路（此前轮次实测，本轮未重跑在线拉取）

- 匿名 GitHub API：issues/PR/PR files/checks/commits（预算器 40 请求，限流降级 stale）—— 见 git 历史 PR #7 验证记录
- 第三方导入：pmndrs/zustand → 2 模块建议（高置信度、真实 import 边）
- Agent CLI 八命令：snapshot/module/impact（9 下游）/context/validate/layout-context/layout-validate/report

## 未运行 / 尚未生产验证（如实）

- GitHub Actions archive job 在**真实远端**的首跑与 site-snapshots 分支自动创建 —— 待合并后观察
- issues 事件触发线上快照刷新的首跑 —— 待合并后观察
- Playwright CI 内浏览器 E2E —— 以等效 browser-use 真实浏览器验收替代，CI 化列入 known-issues
- T21 光标 p95 基准 —— 未运行
- 生产 Pages 域名上的本轮 UI 验收 —— 本轮验收基于本地 preview；线上是 main 旧版，**合并 #3/#7 后需按 docs/pages-deploy.md 检查步骤线上复核**


---

# v1.1 验收记录（feat/v1.1-local-agent）

| 项 | 状态 | 证据 |
|---|---|---|
| 多仓库注册（不同父目录） | ✅ 已自动测试 | registry.test.ts 8 用例（重复路径拒绝、非 git 拒绝、needsInit、disable/enable、remove 不删源码、路径穿越拒绝） |
| SQLite 持久层 | ✅ 已自动测试 | node:sqlite + 版本化建表；registry/github_etags/github_cache/sync_events |
| GitHub 轮询引擎 | ✅ 已自动测试 | github-worker.test.ts：304 ETag 复用、401/403/404/429/5xx 分类、Retry-After 冷却、预算耗尽快速失败、事件去重（同态零重复）、PR files→模块映射（多模块+未归类诚实）、瞬时失败不清缓存 |
| 文件监听（嵌套根归属） | ✅ 已自动测试 + 本地实测 | watcher.test.ts（.local 祖先场景触发、node_modules 忽略）；实测 zustand 文件变化 → 快照 7→8 自动更新 |
| 真实 GitHub 端到端 | ✅ 本地实测 | pmndrs/zustand 匿名轮询：真实 PR #3333/#3583 + CI pending + 模块映射事件入时间线；Agent CLI projects/timeline 读取 |
| 前端 UI | ✅ 本地浏览器实测 | 添加项目对话框（本地路径 + GitHub 分析双 tab）、注册表切换器、动态时间线面板（过滤 chips）—— docs/screenshots/v11-*.png |
| 鉴权回归 | ✅ 已自动测试 | 47→49 服务端测试，全量 102 用例绿 |

**尚未生产验证**：GitHub Pages 静态站不包含 v1.1（本地 Agent 功能设计上不上 Pages）；v1.1 合并后 Pages 自动化回归由 CI 保证。


---

# v1.1 Sync 正确性轮验收（2026-10-28）

| 场景 | 状态 | 证据（github-worker.test.ts） |
|---|---|---|
| 首次接入建立基线（历史 PR 不误报 opened） | ✅ | baseline 无事件断言 |
| 无变化轮静默 | ✅ | second tick 零事件 |
| open→merged（PR 离开 open 列表） | ✅ 1 次 pr_merged + 5 轮不重复 | state=all 语义 mock |
| open→closed 未合并 | ✅ pr_closed 且无 pr_merged | 语义区分断言 |
| closed→reopened | ✅ pr_reopened | |
| HEAD 推送 → 文件重映射（模块增删） | ✅ auth→auth+payment→payment 三步 | head SHA 缓存失效 |
| renamed 文件（previous_filename） | ✅ ui 模块映射 | |
| CI pending→failure | ✅ ci_status 状态机 + 终态后静默 | combined status + check-runs |
| 304 无 payload 强制重取 | ✅ 200 而非 304 误判 | canonical 缓存键 |
| 分页（Link header） | ✅ 两页合并 | |
| 手动 sync-github 端点 | ✅ 实现完成（registry-routes.ts；completed/completed_no_change/failed/rate_limited 状态） | 端到端验收待真实 token 环境 |
| Registry 写接口安全 | ✅ 7 端点匿名 401 + 跨源 403 + 认证 200 | registry-security.test.ts |
