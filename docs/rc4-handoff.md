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
