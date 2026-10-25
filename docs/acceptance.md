# v1.0 验收记录

> 全部条目为**实际执行**的结果；未执行的项目明确标注「未运行」。

## 自动化命令门禁（feat/v1.0 分支）

| 命令 | 结果 | 备注 |
|---|---|---|
| `pnpm lint` | ✅ 0 error | ESLint flat config |
| `pnpm typecheck` | ✅ 6 packages | strict TS |
| `pnpm test` | ✅ 86 用例全绿 | 见下表分解 |
| `pnpm build` | ✅ | 本地模式 bundle |
| `pnpm build:pages` | ✅ | /ArchSync/ base |
| `pnpm verify:pages` | ✅ | 零 /api·/ws 引用、零凭据、schema 校验 |

测试分解：contracts 3 / scanner 15（含 imports 8）/ config 10 / graph 20（含三态分类、diff、sha256 向量）/ server 16（含鉴权统一门、快照历史）/ web 7。

## 真实数据链路验收

| 项目 | 证据 |
|---|---|
| 自举真实 GitHub 数据 | `pnpm snapshot:generate`（在线）：archsync 项目 `githubSource=live`，拉取 6 个真实 PR；预算 40 用 15 |
| PR files → 模块关联 | PR #4 改动文件命中 `static-snapshots`/`workbench-ui` 等模块 globs（快照 pullRequestNumbers 非空） |
| import 三态分类 | archsync 快照：14 planned / 9 confirmed / 6 observed（真实代码 import 证据） |
| 第三方仓库导入 | `pnpm archsync:init -- pmndrs/zustand`：132 文件 → 2 模块建议（src 高置信度，含真实 import 依赖边），生成 YAML 通过严格校验（循环依赖正确警告） |
| Agent CLI | 六命令实测：snapshot（14 模块统计）、module、impact（config-contracts → 9 个下游）、context、validate、report（authoritative:false 落盘） |

## 浏览器验收（等效 E2E，ZCode browser-use / Chromium）

| 场景 | 结果 |
|---|---|
| 静态 /ArchSync/ 子路径加载 | ✅ 1600×950 与 390×844 |
| 50 模块/110 边渲染 | ✅ 切换+渲染 958ms；点击高亮+抽屉 <1s；图例「已确认 55 仅规划 55」 |
| 历史/差异 UI | ✅ 静态模式打开历史面板、加载基线版本、显示差异（真实双版本验证见下） |
| 双版本差异（真实） | 本地连续两次 generate 产生 v1→v2 后 HistoryPanel 正确列出（截图 docs/screenshots/） |
| YAML 导入预览 | ✅（v0.4 已验，回归通过：合法 YAML 内存快照 + 实现状态诚实「未知」） |
| 本地模式回归 | ✅ dev 徽标/重扫/WS/登录流（见下） |
| 控制台 | ✅ 0 报错；静态模式交互期间 0 网络请求 |

## 安全验收

| 项 | 结果 |
|---|---|
| 静态 bundle 泄漏扫描 | ✅ PAT/AUTH_CODE/私钥模式零命中（生成器 + verify:pages 双重） |
| 私有数据保护 | ✅ 未开启 publishStatic 的项目不进 bundle（测试守护）；生成器拒绝 token |
| 鉴权统一门 | ✅ code 模式 GET×5 + POST validate 匿名 401；healthz 公开；有效会话 200 |
| WS 握手 | ✅ 无会话 close 4003 |
| 令牌边界 | ✅ GITHUB_TOKEN 仅服务端进程；静态管线零 token |

## 未运行项（如实记录）

- GitHub Actions 新触发器（issues 事件 / site-snapshots 归档）在真实仓库的首次运行 —— 待 PR 合并后观察（本地已验证工作流 YAML 与脚本逻辑）。
- Playwright CI 内浏览器 E2E —— 本轮用等效 browser-use 真实浏览器验收替代；CI 化列入 known-issues。
- T21 光标 p95 延迟基准 —— 未运行。
