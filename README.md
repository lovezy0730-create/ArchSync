# ArchSync

基于浏览器的**架构可视化与团队协作工作台**：从 `.archsync/project.yaml` 规划文件生成交互式分层架构图，用本地工作区扫描判定真实实现状态，叠加（可选的）GitHub 协作数据，并提供多会话实时在线协作。

> **状态：MVP v0.1（功能分支 `feat/mvp-workbench` 开发中）。** 本 README 描述的功能以当前分支代码为准；主线 `main` 目前只包含施工文档。

## 60 秒启动（Windows 11 / macOS / Linux）

前置：Node.js ≥ 22、pnpm ≥ 10（`corepack enable` 可自动获取）。

```powershell
git clone https://github.com/lovezy0730-create/ArchSync.git
cd ArchSync
pnpm install
pnpm dev          # 首次会自动构建前端，然后启动服务
```

打开 **http://127.0.0.1:4310** 即可。无需任何令牌或配置。

- 服务单端口承载 REST API、WebSocket 与构建好的前端。
- 无 `GITHUB_TOKEN` 时，自带示例项目使用**明确标记的演示协作数据**（界面显示 `DEMO 数据` 徽标）。

## 两个内置项目

| 项目 | 数据来源 | 用途 |
|---|---|---|
| `ArchSync 工作台（本仓库自描述）` | **真实**：扫描本仓库工作区 + git 基线；无协作数据 | 看 ArchSync 自己的架构与真实扫描 |
| `Windows 便签 (Sticky Notes)`（示例） | 真实扫描 `examples/sticky-notes/` + **演示** Issue/PR/成员（`collab.demo.json`） | 体验全部状态与协作场景 |

示例项目刻意覆盖了完整状态矩阵：已完成并验收（绿）、待审核（紫）、开发中（蓝）、已阻塞（红）、未开始/未检测到代码（灰）。

## 界面功能

- **交互式架构图**：按层分列、缩放/拖拽/适应视图、小地图、点击节点查看详情。
- **依赖高亮**：选中模块后高亮其全部上下游传递路径，其余淡出。
- **搜索与筛选**：按名称/负责人搜索；按任务状态、实现状态、层级筛选；刷新后保持选择。
- **模块详情**：负责人/执行者/贡献者、规划路径与实际匹配文件、关联 Issue/PR、证据链、协作备注（乐观锁）。
- **真实状态判定**：`未检测到代码 ≠ 功能不存在`；扫描失败显示 `未知`；规划边与已验证调用严格区分（MVP 不做 AST，`dependencyAnalysis: not_supported`）。
- **本地覆盖层**：未提交的增/删/改只计入本机视图并明确标注，不会混入主线。
- **实时协作**：同项目多会话在线列表、画布光标、正在查看的模块、备注编辑状态；断线自动重连。

## 连接你自己的项目

在仓库根目录或任意子目录放一个 `.archsync/project.yaml`（服务会自动发现根目录与 `examples/*`）：

```yaml
schemaVersion: 1
project:
  id: my-project
  name: 我的项目
  github:
    owner: your-org
    repo: your-repo
    defaultBranch: main
  root: "."
layers:
  - { id: web, label: 前端, order: 1 }
  - { id: api, label: 服务, order: 2 }
modules:
  - id: web-app
    label: Web 应用
    layer: web
    paths: ["apps/web/src/**"]
    plannedDependsOn: [api-gateway]
    acceptance:
      requiredIssues: [12]        # 验收所需的 Issue（completed 关闭）
      requiredChecks: [lint, test]
      manualApproval: false
  - id: api-gateway
    label: 网关服务
    layer: api
    paths: ["services/gateway/**"]
```

重新启动（或点界面上的 `⟳ 重新扫描`）即可看到你的架构。校验失败会给出可定位的错误（文件、路径、行列）。

### 接入真实 GitHub 数据

复制 `.env.example` 为 `.env`，填入一个**只读**的 GitHub PAT（需要 `repo` 读权限或细粒度只读 Issues/Pull requests）：

```dotenv
GITHUB_TOKEN=github_pat_xxxx
```

重启后，`project.github` 指向的真实仓库的 Issue/PR 会取代演示数据（顶栏徽标变为 `GitHub 实时`）。**令牌不会被提交，也不会下发到浏览器。** 当前限制：live 模式不逐 PR 拉取变更文件，模块↔PR 关联依赖配置中的 `issues`/`moduleIssues` 映射。

### 双人多用户演示

同一浏览器多标签页 = 同一用户多会话（互相可见、独立超时）。要演示**两个用户**，用两个浏览器或两个 Profile（例如 Chrome 与 Edge）分别打开 http://127.0.0.1:4310，选择不同身份即可；在线列表、选中模块、光标、备注编辑状态实时互通。服务监听回环地址，mock 身份仅限本机（绑定非回环地址时服务拒绝启动 mock 模式）。

## 开发

```powershell
pnpm lint        # ESLint（flat config）
pnpm typecheck   # 各 workspace 严格 TS 检查
pnpm test        # Vitest：配置校验 / 扫描器 / 状态矩阵 / REST+WS 集成 / 布局
pnpm build       # 构建前端 + 全量类型检查
```

目录结构：`packages/contracts`（共享契约）→ `packages/config`（YAML 解析）→ `packages/scanner`（git 基线 + 工作区 + 覆盖层）→ `packages/graph`（三源合并与状态判定）→ `apps/server`（Fastify REST/WS/watcher）→ `apps/web`（React + React Flow 工作台）。详见 [docs/CONSTRUCTION_PLAN.md](docs/CONSTRUCTION_PLAN.md)。

## 当前限制（诚实清单）

- 演示协作数据来自 fixture，界面全程标注 `DEMO`；不与真实 GitHub 数据混淆。
- 无 AST 调用链分析：依赖仅展示规划边，`observedDependsOn=null`。
- live GitHub 模式不拉取 PR 变更文件列表；无 webhook（改用手动/定时重扫）。
- 状态存储为 JSON 文件（单实例）；SQLite 迁移与快照历史在后续任务包（ARCH-006）。
- 未提交变更的覆盖层在 `git commit` 后由 watcher 自动重扫（监听 `.git` 状态信号），但 GitHub 数据仍需手动或重启刷新。
