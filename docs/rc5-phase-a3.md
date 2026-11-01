# RC5 Phase A-3 交接：Python WASM 静态索引

分支 codex/rc5-phase-a；基线7b2682a；PR #12保持Draft，base为feat/v1.2-integration，依赖PR #11，未合并。原工作区数据库/未跟踪文件保留。本轮无UI、GitHub功能、安装器或Phase B实现。

## 提交与接口

- e208200 feat(scanner): index Python syntax with offline WASM and shared SQLite
- 41cee21 test(python): verify isolated Electron resources and measure real AST scans
- bdee654 fix(python): type lexical parent traversal without implicit any

扫描：PythonScanner.scan(root,projectId) → FileUpdateSchema → scanPythonIndex(root,projectId,index,gitRenameMap) → CodeIndex.applyBatch → SQLite v3。TS与Python删除检测按各自language过滤，混合索引不互删。临时/关闭项目可调用releasePythonIndex释放WASM语法树缓存。没有另建数据库或迁移用户数据。
共享文件发现器抽到files.ts，A2的sourcePaths导出兼容，TS/JS全量回归通过。

## 解析器与分发

锁定web-tree-sitter 0.20.8、tree-sitter-wasms 0.1.13，使用其中Python语法WASM。语法树为Tree-sitter具体语法树，转换为统一声明/关系模型，不是Python解释执行。
Runtime.init直接接收本地runtime WASM字节，Language.load直接接收本地grammar字节；不通过fetch下载。资源路径默认按本包解析，分发通过ARCHSYNC_PYTHON_ASSETS显式指向独立资源目录。需要tree-sitter.cjs、tree-sitter.wasm、tree-sitter-python.wasm，附许可文件应在后续正式安装包资源接入时一并处理。

Windows证据：scripts/python-offline-smoke.mjs把扫描及SQLite逻辑bundle到中文/空格临时目录，仅复制三个解析器资源；PATH置空、fetch强制抛错，Electron35.7.5/内置Node22.16.0仍成功解析中文.py并写入SQLite（1文件、3符号）。资源SHA256见benchmarks/rc5-a3-windows-electron.json。测试不依赖系统Python或node_modules。该证据验证隔离资源分发方案，不宣称现有安装器已包含Python；未构建或验收整套Windows安装器。
CI新增python-windows任务，重复Python/TS真实回归和Electron离线资源检查并上传proof；不得用本机通过替代CI状态。

## 事实提取与保守解析

实际AST提取module/package、def/async、class/method、staticmethod/classmethod、decorator、嵌套函数、参数/默认值/注解、返回注解、docstring、行列、限定名/父UID和声明指纹/anchor。未知类型为null。静态字面量__all__写入exportNames并解析本地导出。
FastAPI/Flask路由仅在明确框架导入及app构造绑定、静态装饰器method/path AST成立时生成routes_to，支持Flask静态methods列表；不执行装饰器。动态字符串/调用保持未知。
绝对/相对导入和别名、包内调用通过本地唯一模块/声明绑定；嵌套作用域中排除类命名空间与参数/赋值遮蔽。动态调用/外部依赖/本地未解析/语法错误/不支持结构分开记录。CodeRelation增加可选reason/route，CodeSymbol增加可选exportNames，均向后兼容。
相同结构/声明anchor复用A1/A2身份机制；重复定义与无法区分的声明标记partial，禁用可信关系，不自动合并。语法错误stale保留最后成功索引；不可读unavailable；恢复fresh；删除deleted。错误树不作为成功空索引。所有可信依赖仍经CodeIndex.trustedRelations过滤。

## 验证

本地lint/typecheck/test/build最终全通过；lint仅既有1条warning。全量164项（contracts3/config17/scanner15/graph23/server93/web13），其中Python3组实际文件端到端测试，TS真实AST3组同时通过。
覆盖中文文件/注释/字符串、参数/注解/docstring、静态方法/类方法/嵌套闭包、相对导入、FastAPI/Flask、overload、重复定义partial、动态引用、主体改动/改名/移动、Stale恢复、SQLite重开、多项目及混合索引。读失败使用EACCES故障注入，恢复再经实际文件解析；不能冒充实测OS文件锁。初始测试因Python适配器尚不存在而失败，后续通过。中间类型检查出现parentKey隐式类型错误，已由bdee654修复并重跑。

固定真实.py夹具 packages/scanner/test/fixtures/python；报告benchmarks/rc5-a3-python-fixture.json（代码bdee654）：3文件、12符号，3个module/6个function/1个class/2个method，2个路由，9条resolved关系、9条unresolved。诊断包含未安装FastAPI/Flask的外部引用和getattr动态调用，不把它们伪装成已解析。原始签名、路径、范围、源码哈希在JSON内。

## Benchmark

```powershell
pnpm exec tsx apps/server/src/python-verify.ts --out .local/python-proof.json
pnpm exec tsx apps/server/src/python-verify.ts --benchmark --out .local/python-benchmark.json
node scripts/python-offline-smoke.mjs --electron --out .local/python-offline-proof.json
```

原始数据benchmarks/rc5-a3-python-benchmark.json。固定生成器python-ast-benchmark-1、seed0、32个真实Python源文件、数据集SHA256，冷/缓存/编辑/删除/恢复/改名/移动各10次。分别记录parseMs/indexMs/totalMs与P50/P95/min/max、CPU/RSS、机器/Node/解析器/代码SHA。冷样本为空AST缓存与空索引，WASM运行时只在首次样本初始化；不当作每次独立进程冷启动。迁移、各增量基线及源码生成不计时。观察性小规模测试，不声明1000文件性能门禁或UI性能通过。

## 限制与Phase A剩余门禁

尚未覆盖所有Python版本新语法；语法错误与超出该grammar的语法均可能表现为错误树并保守stale，不自动声称Python自身无效。动态__all__、运行时import/getattr/monkey-patch/注入/复杂实例方法均不静态确认；函数内import及复杂src-layout/跨包重导出不完整；部分语法节点仅保留声明和未解析引用。没有类型推断或运行时代码。
完整AC-17仍缺复杂重构/diff身份实证；AC-18仍缺生产文件监听及真实OS锁/长时并发场景；AC-19仍缺固定硬件1000文件混合基准及后续UI规模门禁。WASM独立资源测试不等于安装器/DPI/升级验收。资源接入正式客户端、完整Phase A总体验收尚未宣称完成。
本轮A3到此停止，不进入Phase B。
