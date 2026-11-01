# RC5 A-2 交接（仅 TS/JS）

分支 codex/rc5-phase-a，独立 worktree D:/ArchSync/rc5-phase-a；A1基线88089c6。PR #12 已将 base 从 main 改为 feat/v1.2-integration，依赖PR #11但不合并。原工作区运行数据未改动。

## 代码与证据

- 3499e53 feat(scanner): parse real TS JS declarations and references into SQLite index
- 5403adf test(scanner): verify workspace references and isolate test websocket ports
- ed60323 fix(test): allocate explicit ephemeral ports for parallel Vite servers
- cc6570d fix(test): isolate HMR ports after Vitest configuration resolution
- ee7f199 fix(scanner): honor ignore rules and diagnose oversized sources

后两次测试端口修复是前次配置被Vitest覆盖后的纠正，最终configResolved阶段显式分配可用端口。最终全量日志不再含Port is already in use；不通过屏蔽日志消除问题。

packages/scanner/src/ast.ts 使用锁定 TypeScript 5.7.2 的 createProgram/createSourceFile/getTypeChecker；只读取扫描根内发现的源码。CompilerHost fileExists/readFile限定发现文件，不加载项目插件、不安装依赖、不执行源码、不联网；stdlib/外部包不补装，无法证明的目标保持unresolved。

scanAstIndex(root, projectId, CodeIndex, gitRenameMap) 将 AST 结果经 FileUpdateSchema → applyBatch → 现有SQLite v3。sourcePaths支持.ts/.tsx/.js/.jsx/.mjs/.cjs，忽略构建目录、符号链接、根/嵌套.gitignore；超1MiB文件明确unsupported。源文件本身是module-kind符号，只作为文件级导入/顶层引用端点，不计为虚构函数。

提取函数/变量箭头及函数表达式、类/构造/方法、interface/type、default/export、async/generator、参数及源码类型/默认值、JSDoc、行列和父UID。类型未知保留null。重载用参数描述哈希和实现/声明区分；无法区分的重复词法声明分配不冲突定位键并将文件标为partial，不进入可信关系。

同文件/跨文件Identifier调用使用Checker的实际声明和别名绑定；相对路径、tsconfig compilerOptions paths/baseUrl、常见packages/apps workspace src/index.ts 映射及重导出可解析。静态字符串require/import记录imports；运行时动态表达式、实例动态方法等保持unresolved。只标记实际找到的目标为resolved，关系带实际文件/行号和哈希证据。

## 身份与状态

身份版本rc5-identity-2：同唯一key、同声明签名anchor、同作用域声明集合，允许主体变化后延续；作用域新增/移除声明时保守拒绝主体变化的继承，避免拆分合并误继承。移动优先Git映射，改名用唯一结构；已用UID不得重复分配。移动历史中重复UID候选去重。符号列号和父key为兼容新增字段，不重写冻结规格。

语法诊断使文件stale（保留上次成功结果）；类型不匹配不作为语法错误，外部依赖缺失表现为unresolved。删除产生deleted，读取失败unavailable，大文件unsupported，重复声明partial；修复后原子恢复fresh。trustedRelations排除stale目标与来源。A3可实现同样的FileUpdateSchema适配器，TS扫描器不会将Python文件标成deleted。

## 测试与真实自举

初始真实文件回归因适配模块不存在失败；实现后AST端到端3个场景组通过（多项具体断言），覆盖10个实际fixture文件、六种扩展名、重载、父UID、JSDoc、paths/workspace、类型错误区别、动态调用、主体变化、改名/移动、SQLite重开、多项目、Stale修复、拆分/合并及忽略/大文件。
全量161项通过（server90/web13/contracts3/config17/scanner15/graph23）；lint通过，1条RC4既有warning；typecheck/build通过。未改UI/Python/Electron，未运行Windows打包。

实际只读自举原始报告 benchmarks/rc5-a2-self.json；源码基线ee7f199b1184d4386e3039b51d2019a8b1671545（dirty=false）。目标目录 packages/scanner/src、apps/server/src/sync、apps/web/src 共36源文件，242符号：36文件module、98函数、7类、6构造、41方法、46接口、8type。123 import；483 resolved关系；1536 unresolved；目标目录语法诊断0。统计是静态语法/引用证据，不等于功能已验收。

真实示例：packages/scanner/src/imports.ts 的 resolveSpecifier 在87–101行，analyzeImports在108–141行；报告含完整实际签名、路径、起止范围，并通过读取原文件范围核对名称。

## 复现命令

```powershell
pnpm exec tsx apps/server/src/ast-verify.ts --out .local/rc5-a2-self.json
pnpm exec tsx apps/server/src/ast-verify.ts --benchmark --out .local/rc5-a2-benchmark.json
pnpm --filter @archsync/server exec vitest run test/ast-index.test.ts
```

Benchmark原始样本 benchmarks/rc5-a2-benchmark.json，固定生成器ts-real-ast-1、seed0、32个真实TS源码文件和内容哈希。冷/缓存/编辑/删除/恢复/重命名/移动各10次，独立统计AST创建parseMs、索引提交indexMs、完整totalMs；analysisMs含文件发现读取与Checker分析。CPU/RSS/机器/Node/解析器/源码SHA在报告中。数据库迁移和各场景基线不计时；编译器模块加载不计时。只作为观察性小数据集基准，不宣称1000文件或UI性能达标。

## 限制与停止点

没有Python、UI或安装包。tsconfig extends/project references、复杂package exports、装饰器运行时、复杂动态分派、反射、getter/setter与所有class expression模式尚不完整；不推断未知返回类型。CommonJS动态导出/require destructuring的具体声明调用绑定可能unresolved。缓存仅内存AST复用；重启保留SQLite身份但重新解析源码，关系重算与索引仍提交全批次，尚非最小写入优化。源码diff身份延续采用保守声明证据，不声称通用语义拆分检测。

本轮仅A2结束。A3应将Python AST转换为同样的SymbolDraft（含指纹/声明anchor）、关系/诊断/FileUpdate；复用CodeIndex和现有事务，不另建数据库。
