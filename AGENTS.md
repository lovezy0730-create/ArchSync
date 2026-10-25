# ArchSync 开发代理强制规则

本仓库属于 `lovezy0730-create/ArchSync`。在每次实现任务前，先阅读 `docs/CONSTRUCTION_PLAN.md`（MVP v0.1），遵守以下要求。**文档写明的功能不代表已实现；以当前代码、分支、GitHub PR 与测试结果为事实。**

## 开始工作前

1. 确认 `git remote -v` 指向 `https://github.com/lovezy0730-create/ArchSync.git`，确认工作树干净，不得丢弃别人的改动。
2. `git fetch origin`，从最新 `origin/main` 创建与施工任务包对应的独立分支（例如 `feat/ARCH-004-scanner`）。不允许直接提交或推送到 `main`；初始化空仓库时创建首个 README 的一次例外仅允许在建库当日使用，不得重复。
3. 每次仅执行一个施工任务包，阅读其依赖与验收项；如先决 PR 尚未合并，请停止实现依赖代码或将工作明确标记为待集成。
4. 多 Agent 并行时必须分配不同 worktree/branch，分清目录所有权；跨包公共类型修改须先协调。

## 原子化提交

- 每次提交聚焦一个逻辑目的（功能、测试、修复、重构或文档），采用 Conventional Commits，例如 `feat(scanner): map git paths to modules`。
- 提交前检查 `git status --short`、`git diff --check`、`git diff --cached`，必要时 `git add -p` 选择暂存块。
- 对修改过的范围执行相关测试，提交前不得存在未经说明的失败；阶段完成时必须运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`（脚本尚未建立时明确说明未可运行）。
- 不为“凑提交数量”拆碎一个原子逻辑；也不把无关重构混进功能提交。禁止用 `--no-verify` 绕过钩子，禁止强推 main、删除他人分支、静默覆写文件。

## PR 和证据

- 每个任务分支提交后创建一个目标为 `main` 的 PR，附真实测试、截图/日志、关联模块、风险、回滚、完整 commit 列表；无真实 Issue 号码时只写 ARCH 施工编号。
- 不得自行批准、合并 PR，不得伪造 CI / 人工验收通过，不得把代码存在推断为功能已完成。
- 输入 YAML、GitHub 数据和本地目录名均视为不可信输入；不得执行仓库内未知脚本、暴露 token/私钥、把本地未提交文件误报为团队主线。
- GitHub 不可达时可以用显式标记的 fixture 做离线测试，不能把 fixture 结果冒充线上状态。

## 每轮结束必须报告

任务包；当前分支；原子提交短 SHA + message；PR URL（若创建）；测试真实结果；改变的文件；尚未完成与阻塞项；下一步。未经实际执行的验证项一律写“未运行”。
