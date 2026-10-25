# GitHub Pages 部署指南（Pages Ready → 上线）

> **当前状态：GitHub Pages Ready — All Checks Passed — Not Deployed。**
> 本文说明剩余的上线操作。执行前请阅读「数据安全边界」。

## 已具备的能力（本分支交付）

| 能力 | 命令 / 文件 |
|---|---|
| 静态快照生成（公开数据门控） | `pnpm snapshot:generate` |
| Pages 生产构建（/ArchSync/ 子路径） | `pnpm build:pages` |
| 本地子路径预览 | `pnpm preview:pages` → http://localhost:4173/ArchSync/ |
| 产物验证（路径/schema/无 /api·/ws/无凭据） | `pnpm verify:pages` |
| CI 构建 + Artifact（不部署） | `.github/workflows/pages-build.yml` |

## 数据安全边界（发布前必读）

1. **publishStatic 门**：只有 `project.yaml` 中 `project.publishStatic: true` 的项目才会进入公开静态包。默认（缺省 false）一切项目都不发布。当前已标记的只有虚构的 sticky-notes 演示项目；ArchSync 自描述项目（含真实仓库路径）被显式排除并有测试守护。
2. **协作数据**：默认仅允许 demo fixture（界面全程 DEMO 标注）。若要发布某公开仓库的真实 Issue/PR，须显式设置 `project.publishPublicGithubData: true`，生成器才会用**匿名**公开 API 拉取（私有仓库必然失败，不会泄漏）。生成器**拒绝任何 token**——需要 token 即意味着私有数据，一律中止。
3. **凭据扫描**：生成器写出前扫描（PAT / AUTH_CODE / 私钥模式），CI 的 `verify:pages` 对整个产物二次扫描。
4. **隐私自查**：发布前用 `pnpm verify:pages` + 人工抽查 `apps/web/dist/data/*.json`。

## 剩余上线操作（人工执行）

### 方式 A：GitHub Actions 官方部署（推荐）

1. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
2. 在 `pages-build.yml` 末尾**追加**部署 job（本 PR 有意未包含）：

```yaml
      - name: Deploy to GitHub Pages
        uses: actions/deploy-pages@v4
        id: deployment
```

并给工作流加权限：

```yaml
permissions:
  contents: read
  pages: write
  id-token: write
```

同时把 upload-artifact 步骤改为 `actions/upload-pages-artifact@v3`（`path: apps/web/dist`），或在 deploy job 里 `download-artifact` 后部署。

3. 推送到 main（或手动 Run workflow）→ Actions 运行完成后访问：
   `https://lovezy0730-create.github.io/ArchSync/`

### 方式 B：手动上传 Artifact

1. 在 PR/CI 的 **Actions 运行页 → Artifacts** 下载 `pages-static-site`（zip）。
2. 解压后 `npx serve -l 8080 .` 本地核验，或推送到任意静态托管（对象存储/CDN）。
3. 若托管在子路径 `/ArchSync/` 之外（例如自定义域根路径），用 `pnpm build:pages --` 改造：`vite build --mode pages --base=/`（或修改 `apps/web/vite.config.ts` 的 base），重新验证后发布。

## 自动更新机制

- **触发**：push 到 main、PR 合并、手动 `workflow_dispatch`。每次运行都重新扫描 → 生成快照 → 构建并验证产物。
- **定期构建**（可选）：工作流中已备好注释掉的 `schedule`（每日 03:17 UTC）。启用后注意私有仓库的 Actions 免费额度；频率受 GitHub API 限制约束——匿名公开 API 为 60 请求/小时/IP，当前管线仅 2-3 个请求，任何合理频率都在限额内。
- **前端版本识别**：静态站顶栏显示快照 `v版本号` 与「构建于 <时间>」；manifest 携带 `sourceCommitSha`。页面刷新即获取最新构建；无 WebSocket，因此**不声称实时同步**——「构建时数据」徽标全程显示。
- **缓存**：JSON 内容哈希保证相同输入不产生误导性版本变化；Pages 对静态资源默认缓存 10 分钟。

## 本地复现（无 GitHub 凭据）

```bash
pnpm install
pnpm snapshot:generate   # 只读本地 git + demo fixture，无需任何令牌
pnpm build:pages         # 构建到 apps/web/dist（/ArchSync/ base）
pnpm verify:pages        # 产物验证
pnpm preview:pages       # http://localhost:4173/ArchSync/
```

## 已知限制

- 静态模式无实时协作、无备注保存、无本地文件监听（UI 已明确禁用并标注）。
- YAML 导入预览在浏览器中进行：不执行本地扫描（实现状态诚实显示「未知」），数据不出浏览器。
- 快照历史（多版本切换）暂只保留当前构建版本；历史版本随 CI 覆盖。
