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
- Agent CLI 六命令：snapshot/module/impact（9 下游）/context/validate/report

## 未运行 / 尚未生产验证（如实）

- GitHub Actions archive job 在**真实远端**的首跑与 site-snapshots 分支自动创建 —— 待合并后观察
- issues 事件触发线上快照刷新的首跑 —— 待合并后观察
- Playwright CI 内浏览器 E2E —— 以等效 browser-use 真实浏览器验收替代，CI 化列入 known-issues
- T21 光标 p95 基准 —— 未运行
- 生产 Pages 域名上的本轮 UI 验收 —— 本轮验收基于本地 preview；线上是 main 旧版，**合并 #3/#7 后需按 docs/pages-deploy.md 检查步骤线上复核**
