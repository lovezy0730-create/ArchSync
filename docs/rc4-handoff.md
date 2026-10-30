# RC4 交接（2026-10-30）

基线：753c04cd2a99；PR #11；分支 feat/v1.2-integration。按本次用户要求继续集成分支，尚未合并 main。

## P0-A 非破坏性清理

取消跟踪 registry.sqlite/WAL/SHM、.tmp-debug.ts、.tmp-reg.json、dist-electron 两个产物；本地文件保留。修复 .gitignore 冲突标记并忽略运行数据及构建目录。db.ts/build.mjs 已有 mkdir 逻辑。

只读数据库检查：registry_projects 3 条记录含本地绝对路径；github_etags 14 条、github_cache 59 条中也含路径。sync_events 25 条。未打印字段内容；常见 GitHub token/私钥模式匹配为 0，不能证明不存在其他敏感数据。文件已在远端历史，不能仅靠本次删除消除历史暴露。

历史处置需用户授权：限制旧历史访问，审查旧 blob 中账号/项目元数据；发现凭据即撤销轮换；安排维护窗口使用 git-filter-repo 清理数据库及调试产物所有历史，协调克隆/分支并在授权后强推。当前不执行历史重写、不发布 Release。

验证：lint 通过（1 条既有 any warning）；typecheck 通过；build 通过。pnpm test 失败：server 59 assertions passed，但 afterAll 删除临时目录 EBUSY，套件失败；web 因递归任务中断未得最终结果。此为基线发现，后续必须修复生命周期/清理并重跑。

## P0 基线 / 待办

- B：loadCollab 把 Record 当数组，NormalizedPull 缺 assignees/files/checks，Issue 尚为 raw；需真实 SQLite → Snapshot 回归。
- C：分页部分成功被当完整、Link 未校验/redirect 未拒绝、ETag payload 回退跨请求；列表 slice 丢更新；Issue 首轮伪历史；Checks unknown 不重试。
- D：Dialog 仍旧 analyze 接口；无 YAML 编辑确认与原生选目录；remote-only 重启仍加载本地路径。
- E：桌面错误页 ROOT 未定义、崩溃定时器未清理、暂停重启流程待修。Windows 打包、EXE smoke、接入 E2E 尚未运行。
- P1/P2 与全部最终门禁尚待完成。状态：未达到 Ready for User Trial。

恢复入口：git fetch origin；检查本分支最新提交，顺序完成 B/C/D/E，每阶段追加真实结果。

## B/C 修复阶段（清理提交 5a266ae 后）

- request payload 以完整路径/查询/分页模式隔离；分页失败/超限拒绝覆盖最后完整缓存；后续页不发送首屏 ETag；HTTPS/API host/相同 endpoint+filters 校验并禁止 fetch redirect。
- Worker PR/Issue 全分页对账，去除 slice 截断；Issue 首轮基线；同一数据库 Record 经 projectWorkerState 单一投影（PR assignees、HEAD 对应 files/checks，raw Issue 字段）进入 Snapshot；无缓存不伪造 live。
- 新增 7 项分页/安全回归与 1 项真实 SQLite 关闭重开至 Snapshot 的集成回归（GitHub 为显式 fixture），曾失败后通过。定向 23 项通过；lint/typecheck/build 通过。全 test 的 137 assertions 通过但 server afterAll EBUSY；正在补齐关闭等待及 Windows 删除重试，需重跑。
- 仍待完整 raw schema/多页 Checks、端到端 REST/UI 证据及线上验收；不可宣称 B/C 所有验收完成。

## 接入与恢复阶段

提交：590e250（B/C）、6049368（shutdown）。Windows EBUSY 修复后全量 138 项通过；补充初始化回归后 139 项通过（server 69，web 12，graph 23，scanner 15，config 17，contracts 3）。lint（既有 1 warning）、typecheck、build 通过。

- SQLite v2 增 kind 并迁移已有 remote: 条目；remote-only 恢复使用内存元数据，不扫描虚拟路径；REST 注册→重启→同步回归通过。
- 现有 Dialog 接入预览/编辑/校验/确认保存，已有配置保护；GitHub 真正持久化注册；克隆公开库入口（需系统 Git）。原生选择器为受限 preload IPC，只接受当前主窗口主 frame 同源请求。
- 首页显示同步状态，提供远端刷新、暂停恢复、移除；暂停过滤本地 watcher。没有完整私有库凭据管理。
- build:pages / verify:pages / verify:workflow 已通过；Pages 匿名读取本项目实际 PR（只读，无测试写入）。随后 UI 仍有改动，最终需再跑一次。
- Windows 打包两次失败于 GitHub Electron ZIP 下载连接超时；新增 Playwright 实际 EXE 接入/重启/生命周期 E2E，尚未运行成功，不能宣称成品通过。CI 将运行该门禁，已移除旧固定4310/全系统同名进程强杀做法。
