# ArchSync v1.0 Roadmap

> 本文件随实际开发更新，不预先勾选。最后更新：2026-10-26（RC 集成验证轮：#3+#7 合并态 86 测试全绿、归档脚本四场景验证、鉴权限流加固；**待人工合并 #3/#7 后线上复核**）。

## 当前状态总览

| 领域 | v0.x 已有 | v1.0 新增（本分支） | 状态 |
|---|---|---|---|
| 双运行模式 | 静态/本地 DataProvider | — | ✅ |
| 真实 GitHub 数据 | demo fixture 为主 | 匿名公开 API（issues/PR/PR files/checks/commits）+ 速率预算 | ✅ |
| 自举（真实项目） | 仅 demo | ArchSync 自描述项目发布真实 PR/代码数据 | ✅ |
| 代码依赖分析 | 无 | TS/JS import 分析 → planned/confirmed/observed 三态边 | ✅ |
| 快照历史 | 无 | site-snapshots 分支持久化 + 差异对比 UI | ✅ |
| 项目导入 | 仅 YAML 手写 | `archsync:init` 向导（tarball 单请求 + import 聚类 + 置信度） | ✅ |
| Agent 接口 | 无 | `pnpm agent` CLI（snapshot/module/impact/context/validate/report） | ✅ |
| 事件驱动同步 | push 触发 | + issues 事件 / 周期对账 / 历史版本归档 | ✅（待 CI 首跑验证） |
| 访问码鉴权 | PR #3 | 统一 API 读取鉴权门 + 登录限流 + 同源写断言（审查修复） | ✅（PR #3 待合并） |
| 性能 | 10-14 模块 | 50 模块/110 边实测 958ms | ✅ |

## 任务分解与依赖

### 阶段 A：消除 Demo 依赖 ✅
- A1 自描述项目 `publishStatic + publishPublicGithubData` ✅
- A2 public-github 增强（PR files / checks / commits / budget）✅
- A3 生成器版本化与历史持久化 ✅

### 阶段 B：自动化同步 ✅
- B1 Actions 触发器（push/issues/schedule/dispatch）✅
- B2 快照版本去重（contentHash）✅（测试守护）
- B3 限流降级与 stale 标注 ✅

### 阶段 C：架构差异分析 ✅
- C1 TS/JS import 分析器（保守解析 + 别名解析）✅
- C2 三态边分类 + UI 图例 ✅
- C3 快照差异纯函数 + 历史对比 UI ✅

### 阶段 D：协作与 Agent ✅（本地模式协作沿用 v0.x 并加固）
- D1 Agent CLI 六命令 ✅
- D2 可审计 agent-reports（authoritative:false）✅
- D3 init 向导 ✅

### 阶段 E：验收（RC 轮完成，待线上复核）
- E1 全命令门禁 ✅（集成态 86 用例）
- E2 双模式浏览器回归 ✅（本地预览；线上 Pages 为 main 旧版，合并后需复核）
- E3 性能压测 ✅（本轮：50 模块渲染 271ms、高亮 391ms）
- E4 文档五件套 ✅
- E5 历史归档权限拆分与四场景验证 ✅（远端首跑待合并后观察）

## 未完成 / 后续版本

- SQLite 快照历史库（本地服务模式多版本 UI；静态模式已有）
- PR 变更文件在本地 live 模式的关联（token 模式逐 PR 拉取）
- Python/Go/Rust import 分析插件
- MCP Server（stdio JSON-RPC 封装现有 CLI；CLI 已可用作过渡）
- Playwright CI E2E（当前用等效浏览器自动化验收，见 acceptance.md）
