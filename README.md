# ArchSync

**ArchSync 是一个面向开发者与 AI Agent 的架构可视化和协作工作台。** 它读取 `.archsync/project.yaml` 中的架构规划，将模块与依赖展示为交互式图谱，并结合文件扫描和 GitHub 协作信息解释项目进度。

[**在线体验 · GitHub Pages**](https://lovezy0730-create.github.io/ArchSync/) · [施工设计](docs/CONSTRUCTION_PLAN.md) · [Pages 部署说明](docs/pages-deploy.md) · [API 文档](docs/api.md)

> **当前版本：MVP v0.1，已提供 GitHub Pages 静态演示站和本地完整模式。** GitHub Actions 的正式 Pages `build` / `deploy` 已通过（[发布记录](https://github.com/lovezy0730-create/ArchSync/actions/runs/40204211709)）。在线站点的协作数据是明确标记的 **DEMO**，并非本仓库的实时任务状态；这不是已完成的生产级多人协作平台。

![ArchSync 静态模式工作台截图](docs/screenshots/pages-static-mode.png)

## 立即体验

### 方式一：网页体验（无需安装）

打开 **https://lovezy0730-create.github.io/ArchSync/**。

网页基于 GitHub Pages 免费静态托管，可进行以下操作：

- 浏览 React Flow 分层架构图，缩放、拖拽、适应视图与高亮上下游依赖。
- 搜索、按任务/实现状态筛选模块，点击节点查看路径、负责人、任务关联与证据。
- 查看构建时生成的版本、时间和来源 SHA；识别 **DEMO 数据**与不可用的数据来源。
- 点击「导入 YAML」，在浏览器内解析自己的架构规划并预览；文件**不会上传**，也**不会扫描本机代码**，因此无法确认的实现状态显示为「未知」。

**网页演示数据：** 当前只发布示例工程 `Windows 便签 (Sticky Notes)` 的静态快照。示例中的成员、Issue 和 PR 均为虚构演示数据；源仓库自身的架构不会默认加入公开快照。

**静态模式边界：** 无 WebSocket 实时光标、服务器端备注编辑、本地文件监听和即时 GitHub 同步。网页展示的是**上一次构建时的数据**，不能将其当作实时 GitHub 状态。

### 方式二：本地完整模式（Windows 11 / macOS / Linux）

环境：Node.js **≥ 22**，项目使用 `pnpm@11.22.0`（可以先执行 `corepack enable`）。

```powershell
git clone https://github.com/lovezy0730-create/ArchSync.git
cd ArchSync
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

打开 **http://127.0.0.1:4310**。首次启动会构建网页，然后在单端口提供 React 前端、Fastify REST API 与 WebSocket。

本地模式额外支持：

- 实际扫描本仓库或 `examples/*` 项目的 Git 基线与工作区文件，区分规划、实际文件和未提交变更。
- Chokidar 自动监听本地文件以及部分 Git 状态变化，触发本地快照刷新。
- 多浏览器会话的在线成员、光标、选中模块及备注编辑状态。
- 模块备注保存与修订冲突检测；可选只读 GitHub Issues / PR 数据源。

> 默认登录仅是**本机演示身份**，服务仅监听回环地址。它不是公网用户认证，**不要直接把本地开发服务暴露到互联网**。独立的部署鉴权改动如果尚未合并到主线，则不属于上述本地默认版本。

## 两种模式的能力对照

| 能力 | GitHub Pages 静态模式 | 本地完整模式 |
| --- | --- | --- |
| 架构图、详情、搜索、筛选、依赖高亮 | ✅ | ✅ |
| 架构 YAML 导入预览 | ✅ 浏览器内预览 | ✅ 仓库配置解析与校验 |
| Git 文件扫描及本地覆盖层 | — 只有构建时快照 | ✅ |
| GitHub Issues / PR | 构建时公开允许的数据或 DEMO | ✅ 配置只读 Token 后获取 |
| 自动更新 | `main` 更新触发重新构建与发布 | ✅ 本地文件监听；GitHub 状态仍需重新同步 |
| 多人在线光标与模块选中 | — | ✅ 本机多会话 |
| 协作备注写入与冲突检测 | — 只读 | ✅ |
| 需要常驻 Node.js 服务 | 否 | 是 |

## 项目配置示例

将 `.archsync/project.yaml` 放在项目根目录：

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
  # 仅在你明确同意整个生成快照被公开时开启：
  # publishStatic: true

layers:
  - { id: ui, label: 界面, order: 1 }
  - { id: service, label: 服务, order: 2 }

modules:
  - id: ui-app
    label: Web UI
    layer: ui
    paths: ["src/ui/**"]
    plannedDependsOn: [api-service]
    issues: [12]

  - id: api-service
    label: API 服务
    layer: service
    paths: ["src/service/**"]
```

本地服务当前会自动发现项目根目录及 `examples/*` 下的配置。配置错误会报告路径、字段及可用的定位信息。

如需在本地服务读取真实 GitHub 协作状态，可将 `.env.example` 复制为 `.env`，使用具有所需**只读权限**的 Token 配置：

```dotenv
GITHUB_TOKEN=YOUR_READ_ONLY_TOKEN
```

不要把真实 Token 提交到 Git。静态 Pages 构建默认**不接受私有 Token**；构建时仅允许 `publishStatic: true` 的项目进入公开产物。真实公开 GitHub 协作数据还需要显式设置 `publishPublicGithubData: true`，否则使用标记过的演示数据或显示不可用。

## GitHub Pages：构建、预览与自动部署

从仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build:pages       # 生成公开安全的快照并打包静态前端
pnpm verify:pages      # 检查 /ArchSync/ 路径、快照格式与常见凭据泄漏
pnpm preview:pages     # 预览 http://localhost:4173/ArchSync/
```

网页构建输出到 `apps/web/dist`，Vite 使用项目子路径 `/ArchSync/`。

GitHub Actions 工作流 [`.github/workflows/pages-build.yml`](.github/workflows/pages-build.yml) 的行为：

1. 对 PR：运行 lint、类型检查、测试、生成静态快照、构建、产物校验，并上传**预览 Artifact**；不发布线上网站。
2. 对 `main` 的 push 或选择 `main` 的手动运行：同样完成校验后，上传 Pages Artifact，并用 `actions/deploy-pages` 自动发布。
3. **GitHub Issue/PR 状态本身变化不会立即更新网页**：当前没有启用定时发布；需要一次新的 `main` 构建或手动运行工作流。

发布配置与隐私约束见 [GitHub Pages 部署及运维指南](docs/pages-deploy.md)。

## 开发与工程约定

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build             # 本地服务模式前端构建
pnpm snapshot:generate # 构建时静态快照
pnpm build:pages
pnpm verify:pages
```

主要目录：

```text
apps/web/              React + React Flow 工作台、双数据提供器
apps/server/           Fastify REST/WS、本地文件监听、静态快照生成器
packages/contracts/    前后端共享 Schema 和类型
packages/config/       YAML 解析与校验
packages/scanner/      Git 文件树与本地工作区扫描
packages/graph/        规划/扫描/协作状态归并
examples/sticky-notes/ 演示项目及明确标记的协作模拟数据
.github/workflows/     CI 与 GitHub Pages 自动构建/发布
```

贡献者和 Coding Agent 请先阅读 [AGENTS.md](AGENTS.md)，使用**独立功能分支、原子化 Conventional Commits、PR 审查与真实测试记录**。

## 当前限制与后续方向

ArchSync 当前是一套可以体验、能够部署的 **MVP 工作台**，尚不是完整的源代码架构智能分析或生产级团队权限管理平台：

- 依赖连线目前主要来自 YAML **规划关系**；未实现 AST/跨语言实际调用关系识别，实际依赖为未知而非空。
- 本地 GitHub 读取功能尚不拉取逐 PR 修改文件、完整 Reviews/Checks/Projects 状态；尚无 GitHub Webhook 和周期对账闭环。
- 静态站点不提供真正的多人实时协作；在线快照展示最新**成功发布的构建**，不等于当前工作区状态。
- 本地状态存储主要使用单机 JSON 文件；SQLite、多版本历史快照、可靠多人身份与跨仓库权限隔离尚待实现。
- Pages 的公开数据安全依赖显式发布允许列表、验证与人工审核；**静态文件一经部署即对所有访问者可见**。

[施工设计](docs/CONSTRUCTION_PLAN.md) · [运行手册](docs/runbook.md) · [API 参考](docs/api.md) · [Pages 发布指南](docs/pages-deploy.md)

---

本项目仍在迭代中。**在线 Demo 用于展示交互体验，本地完整模式用于验证真实文件扫描与会话协作。**
