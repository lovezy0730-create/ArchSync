# ArchSync v1.0 架构说明

> 描述当前**实际实现**的架构。历史设计见 CONSTRUCTION_PLAN.md。

## 总体形态

```
┌────────────────────────────── 同一前端 (apps/web) ──────────────────────────────┐
│  DataProvider 抽象（capabilities 驱动功能启停）                                    │
│   ├─ ServerDataProvider → Fastify REST + WS（本地完整模式）                       │
│   └─ StaticDataProvider  → 构建时 JSON（GitHub Pages 静态模式，零后端请求）        │
└──────────────────────────────────────────────────────────────────────────────┘
        ▲                                        ▲
        │ REST/WS                                │ data/*.json（CI 生成）
┌───────┴────────┐                    ┌──────────┴────────────┐
│ apps/server    │                    │ 构建时管线（CI/本地）    │
│ Fastify 单实例  │                    │ snapshot:generate      │
│ REST/WS/watcher│                    │  ├ 匿名 GitHub API     │
│ auth(code/mock)│                    │  ├ scanProject(本地git) │
└───────┬────────┘                    │  └ buildSnapshot       │
        │                             │ build:pages (vite)     │
┌───────┴──────────────────────┐      │ verify:pages(安全验证)  │
│ packages (共享纯函数核心)      │      │ site-snapshots 分支    │
│ contracts→config→scanner→    │      │ （快照历史持久化）       │
│ graph(状态矩阵/闭包/diff)     │      └───────────────────────┘
└──────────────────────────────┘
```

## 关键技术决策（v1.0）

1. **浏览器安全纯函数入口**：`packages/scanner/src/pure.ts`（glob）与 `packages/graph/src/sha256.ts`（纯 JS SHA-256）无 Node 依赖，使 YAML 导入预览与静态模式共用核心逻辑；`verify:pages` 强制静态 bundle 零 `/api`、`/ws` 引用。
2. **依赖分析三态分类**：`scanner/imports.ts` 保守解析相对 import + monorepo 包名别名（package.json exports 映射）；graph 将观察边与规划边合并为 `planned`（仅 YAML）/ `confirmed`（规划+代码证据）/ `observed`（代码有、规划无 = 漂移）。解析不了的一律 `unresolved`，不虚构。
3. **真实 GitHub 数据与速率预算**：`pages/public-github.ts` 匿名（拒绝 token）拉 issues/PR/PR files/combined status/commits，带请求预算器（默认 40 请求/构建），限流时保留基础数据并显式 `stale`。公开数据需显式 `publishPublicGithubData: true`（允许列表原则）。
4. **快照历史**：生成器把版本化快照写入 `site-snapshots/` 目录；CI 从专用分支恢复历史、构建后归档回分支（contentHash 去重，相同内容不升版本）。前端 HistoryPanel 加载 `data/history/<id>/` 并用 `graph/diff.ts` 纯函数对比。
5. **Agent 与项目视图**：`pnpm agent -- <command>` 进程内构建快照（离线可用，GITHUB_TOKEN 可选升级），输出结构化 JSON；`layout-context`/`layout-validate` 让 Agent 只生成 `.archsync/views.yaml` 的分组与顺序，不生成脆弱像素坐标；`report` 写 `.archsync/agent-reports.jsonl` 且每条带 `authoritative:false` —— Agent 申报永不进入状态计算。
6. **init 向导**：codeload tarball 单请求（不受 API 限流）→ 内置极简 tar 解析 → 目录聚类（≥3 文件）+ import 分析 → 模块建议（置信度分级、未归类清单、层启发式明确标注）→ 输出可通过严格校验的 YAML。
7. **鉴权统一门**：code 模式下 Fastify onRequest 钩子覆盖全部 `/api/v1/*`（除 me/login/logout），修复 v0.1 仅写操作校验的缺口（PR #3）。

## 数据流真值规则（不变）

- 扫描失败 → `unknown`，绝不 `not_detected`
- PR 合并 ≠ 验收；CI 通过 ≠ 完成
- demo / live / unavailable 三态来源全程标注
- 本地未提交变更只进覆盖层，不进共享基线
