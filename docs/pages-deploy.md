# GitHub Pages 部署与运维

线上地址：**https://lovezy0730-create.github.io/ArchSync/**

> 源码中的 v1.0 功能只有合并到 `main` 且新的 Pages `deploy` 作业成功后才算**已上线**。验证生产状态请看 [Actions](https://github.com/lovezy0730-create/ArchSync/actions) 的最新 main 工作流、站点中的 `sourceCommitSha` 与公开数据快照；不要仅凭 PR 绿色或 README 版本判断。

## 发布架构和权限

工作流：[`.github/workflows/pages-build.yml`](../.github/workflows/pages-build.yml)，三个独立作业：

| Job | 权限 | 用途 |
| --- | --- | --- |
| `build` | `contents: read` | 校验、构建、生成快照；上传 `snapshot-history` 和**官方 `github-pages` Artifact** |
| `archive` | `contents: write` | 在可信 `main` 中检出 `scripts/archive-history.sh`，将历史版本推送到 `site-snapshots` 孤儿分支 |
| `deploy` | `pages: write`, `id-token: write` | `needs: [build, archive]`，归档成功后才发布 Pages |

`pull_request`：仅运行只读构建、测试和预览 Artifact，**不归档、不上传正式 Pages Artifact、不部署**。

`push(main)`、`issues` 事件、每周日 03:17 UTC 的 `schedule`、在 `main` 上手动 `workflow_dispatch`：执行可信构建、归档、正式部署。

注意：**PR 新建或更新不会立即刷新生产站**，该事件只运行 PR 检查。PR 合并通常触发 `main` push，未合并 PR 的协作信息由 Issues 事件、周日对账或手动触发补偿。静态数据是**构建时快照**，不是实时 WebSocket。

## 首次发布或 v1.0 升级

1. 确认仓库 [Settings → Pages](https://github.com/lovezy0730-create/ArchSync/settings/pages) 的发布来源已设置为 **GitHub Actions**。
2. 按顺序审核并合并 PR #3（访问码鉴权）和 PR #7（v1.0）。在合并 #3 后再次检查 #7 是否可合并及测试是否仍通过。
3. 合并 #7 后打开 [Actions](https://github.com/lovezy0730-create/ArchSync/actions)，找到**基于最新 `main` SHA** 的 `GitHub Pages (build, verify, archive, deploy)` 运行。
4. 核查 `build` 成功、`snapshot-history` 与 `github-pages` 两个 Artifact 均已上传。
5. 核查 `archive` 成功，并出现 [`site-snapshots` 分支](https://github.com/lovezy0730-create/ArchSync/tree/site-snapshots)。**首次成功运行前该链接不存在是正常的。**
6. 查看该分支根目录应以 `history/` 为主，不应把主分支全部源码拷入历史分支；确认每个项目的 `index.json` 和版本 JSON 存在。
7. 核查 `deploy` 成功，再访问 https://lovezy0730-create.github.io/ArchSync/ ，强制刷新并检查 `/ArchSync/data/index.json`、架构快照、历史索引。
8. 选择真实 `ArchSync` 项目，确认真实公开 GitHub PR/文件证据、三态依赖边和历史面板。Sticky Notes 仍是明确标注的 DEMO。确认界面显示的来源 SHA 和构建时间对应此次新发布。
9. 再次触发 `workflow_dispatch` 测试第二次归档：无变化不能无限新增历史版本；有变化时应保留旧版本并生成新版本。

**必须以首次真实 `archive` 和 `deploy` 作业结果为准。** 这两个生产作业会在 PR 检查时跳过，PR CI 成功不等于生产已验证。

## 静态构建与本地预览

环境：Node.js ≥22、pnpm（版本以 `package.json` 为准）。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify:workflow
pnpm build:pages
pnpm verify:pages
pnpm preview:pages
```

预览地址：`http://localhost:4173/ArchSync/`；构建产物：`apps/web/dist/`，部署路径：`/ArchSync/`。

`build:pages` 会生成快照并构建网站。工作流使用 `pnpm snapshot:generate` 后再执行 Vite build，以保留从历史分支恢复的版本数据。不得在恢复历史后再次使用清空历史的构建步骤。

## 公开数据安全边界

1. 只有设置 `project.publishStatic: true` 的项目进入公开产物；真实公开 GitHub 协作数据还需要显式 `project.publishPublicGithubData: true`。
2. 只有确定允许公开的信息才能写入静态快照。当前 v1.0 准备发布 ArchSync 自描述项目的公开数据与虚构 Sticky Notes 示例；公开不等于实时。
3. 静态生成器拒绝私有 GitHub Token，`verify:pages` 检查常见凭据和无效 `/api`、`/ws` 引用。仍应人工抽查 `apps/web/dist/data/`，因为启发式扫描不能保证发现所有敏感文本。
4. `site-snapshots` 分支及 Pages JSON **均为公开资源**，不能借助前端登录保护其中的内容。
5. `archive` 的写权限只赋予可信的主分支发布路径，PR 代码不得进入拥有仓库写权限的上下文。

## 失败排查和恢复

- **build 失败**：打开失败步骤日志；先本地复现。不要跳过 lint/test/verify。
- **archive 出现 403**：检查 Actions Token 的 `contents: write` 作业权限、仓库 Actions 设置、规则集/分支保护；不要把整个 workflow 改为写权限。
- **archive 无法执行脚本**：检查 archive checkout 到的确实是此次可信 main 代码及 `scripts/archive-history.sh` 路径。
- **首次无 site-snapshots 分支**：build 在首次恢复历史时允许跳过；archive 应通过 `git init` 创建只含 history 的孤儿分支。
- **deploy 找不到 github-pages Artifact**：确认 build 成功执行了 `actions/upload-pages-artifact@v3`，并检查官方 artifact 名称与内容。
- **deploy 404**：检查 Settings → Pages 来源是否启用 GitHub Actions。
- **站点仍是旧数据**：先检查最新 main 部署运行结果及 `data/index.json` 的 SHA、时间；缓存可能造成暂时显示旧内容。
- **匿名 API 限流**：检查静态快照 `githubSource` 及 stale 标记；公开 PR 明细可能降级，不能把缺失数据解释为“没有 PR”。
- **历史归档与发布版本不一致**：停止继续部署，保留上一个成功 Pages 版本，调查工作流版本与历史分支 SHA；不要强推历史分支。

发布失败时可以在 GitHub Pages Deployments 中回退至上一个成功部署（如提供该操作），或在 `main` revert 导致错误的提交后重新触发 Pages 构建。历史分支应独立保留，禁止为了回滚页面而直接清空历史。

## 已知边界

- GitHub Pages 是静态站：无线上 WS 光标、在线备注写入、本地磁盘监听。
- 当前静态历史最多保留近 20 版，本地服务的 SQLite 多版本历史仍未实现。
- TS/JS 的 import 依赖分析为部分分析，不代表对所有实际调用关系的完整证明。
- PR 触发只做检查；已发布快照的同步受 Actions 事件、周期、API 限流与 GitHub Pages 缓存约束。

其他部署方式（Docker、访问码和 HTTPS）请看 [服务器部署指南](deploy.md)；完整已知问题请看 [known-issues.md](known-issues.md)。
