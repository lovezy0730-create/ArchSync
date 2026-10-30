# ArchSync 1.2.0-rc.4 Windows 试用

状态：Implemented；部分真实场景 Verified。以 PR #11 最新 Windows E2E 结果决定 Ready for User Trial；不是 Release Ready。

## 安装

从 PR #11 最新成功的 Windows Desktop Build 下载 archsync-portable-rc4 或 archsync-setup-rc4 artifact，解压。
- 便携版：双击 ArchSync-Portable-1.2.0-rc.4.exe。
- 安装版：运行 ArchSync-Setup-1.2.0-rc.4.exe，按向导安装。
- 不需要 Node.js、pnpm、tsx、VSCode 或手工启动 Agent。读取/克隆本地 Git 仓库仍需要系统安装 Git；公开远端只读监控可独立使用。
- 用压缩包中的 SHA256SUMS.txt 核验 EXE。程序尚无代码签名，Windows 可能显示未知发行者。

## 使用

输入显示名进入工作台，点「＋」。
- 本地：浏览或输入仓库路径；已有配置直接读取；无配置时预览并编辑建议 YAML，确认保存并监控。已有配置不会被覆盖。
- 公开 GitHub：输入仓库 URL，添加远端监控；可选择克隆后进入本地初始化流程。远端只读不生成伪架构，当前 PR/Issue/CI 在「动态」面板查看。
- 工具栏：本地刷新/刷新 GitHub、暂停恢复、移除（保留源代码）。关闭窗口默认后台监控，从托盘「退出」彻底退出。
- 数据与日志位于 Windows 用户数据目录 ArchSync/data 和 ArchSync/logs；安装版/便携版使用同一 userData 位置。

## 已验证和限制

自动化：Worker→真实SQLite→重开→Snapshot；REST远端注册→重启→再次同步→规范化API；完整分页/不安全Link/ETag回归；项目切换迟到响应隔离。
Windows真实EXE：隔离用户目录、身份端口、页面加载、陌生仓库初始化与扫描、重启恢复、ArchSync自举、正常退出清理。公开远端在CI以只读token验证；本机匿名限流失败如实报告。

尚待人工：原生目录对话框交互、托盘点击/暂停恢复/关闭常驻、安装向导和升级保留数据、便携EXE外层自解压启动、长时间断网恢复与资源观察、实际受控远端状态变化。CI当前运行win-unpacked/ArchSync.exe，不能把它等同于安装器完整人工验收。
私有库Windows系统凭据存储未实现；远端只读模式明确拒绝私有库。匿名GitHub受60次/小时限制，多项目可能很快限流。
旧远端Git历史仍含本地路径数据库，历史重写待授权，见rc4-handoff.md。
