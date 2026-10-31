# RC5 Phase A-1 交接

范围：只实现底层契约、确定性身份、文件索引持久化、合成索引测量。依赖尚未合并的 PR #11；不是完整 RC5 或完整 AC-17～19 验收。

## 分支与证据

独立 worktree D:/ArchSync/rc5-phase-a，分支 codex/rc5-phase-a。
基线 origin/feat/v1.2-integration @ c41e4382ea71d5766e1a512d4b5094306f135e86；规格 cherry-pick 34bfd4f → 6f577d5。功能提交 aee2d82。
原工作区未跟踪的数据库、WAL/SHM、调试文件及构建目录均保留。
初始新测试因身份模块尚不存在而无法收集（红）；实现后15项通过。全量158项通过（contracts3/config17/scanner15/graph23/server87/web13）；lint通过（既有1条any warning），typecheck最终通过，build通过。未运行桌面E2E/真实AST性能/GUI压力测试。

## 数据与解析器接口

packages/contracts/src/code-index.ts：System、Module、SourceFile、CodeSymbol、CodeRelation、SymbolEvidence、ScanDiagnostic、ScanIndexMetadata 的 Zod schema 和 TS 类型；独立导出，不替换旧 Snapshot。

Phase A-2 将解析器输出转换为 FileUpdateSchema：项目/模块/相对路径、内容哈希、parserVersion/configVersion/scannedAt、完整符号声明（范围/签名/参数/返回类型/修饰符/证据）、关系、诊断和状态。SymbolDraft.fingerprint 由解析器生成确定性的 AST 结构指纹，不能使用名称相似度。overload 必须提供稳定区分信息。

同一批次调用 CodeIndex(existingLocalDatabase).applyBatch(projectId, updates, gitRenameMap)。批次包含所有变化与删除文件；未变更文件保留。移动要同时提供旧文件deleted、新文件fresh和可靠的Git路径映射。不执行源码、不上传源码。系统/模块契约用于后续投影，本轮没有自动分组/解析器或UI接入。

## 身份与局限

symbolKey 是项目、语言、规范化相对路径、限定名称、类型及重载信息的 SHA256；不含行号。symbolUid 使用随机UUID，写入现有SQLite并随历史恢复。
同key且结构指纹一致优先匹配；其次可靠Git路径映射+同限定名/重载+结构指纹；最后是同项目/语言/类型/解析器版本的唯一结构匹配。不唯一则新UID，记录possiblePredecessors；不继承以旧UID关联的标注。
身份依据/置信度/匹配版本/previousKey均持久化。实现保守：主体改变即使名称不变，也可能产生新UID；尚未实现源码diff声明对应，待AST阶段补齐。未验证真实AST的移动/拆分/合并；确定性符号夹具验证不能当AC-17全部完成。

## 文件状态与事务

复用 LocalDatabase registry.sqlite，schema v3 只增加 code_index_files 与 code_index_history；不删除RC4表或JSON。fresh将符号/关系及最后成功快照一起提交；失败stale/unavailable/unsupported保留最后成功结果；partial结果为不可信临时符号，不替换最后成功基线；deleted清空当前符号/关系并保留历史。每次操作递增文件revision，fresh符号和关系标记对应indexRevision。
trustedRelations只返回源文件和两端符号均fresh且strength=resolved的边，stale/partial/不可读/删除不会冒充已验证依赖。
同一批次BEGIN IMMEDIATE/COMMIT；注入后续SQL失败的回归证明整个批次回滚。复合项目/路径主键隔离两个项目，实际SQLite关闭重开验证恢复。读取/AST失败到状态的映射由A-2适配器提供，本轮用确定性outcome验证。

回滚策略：停止服务并备份SQLite（含WAL一致性），回退功能提交；RC4忽略新增v3表，保留索引及历史，无破坏性down migration。旧github_cache与JSON记录保留已有回归证据。不得通过删用户数据库回滚。

## Benchmark Harness

在仓库根执行：

```powershell
pnpm exec tsx apps/server/src/index-benchmark.ts --out .local/rc5-a1-benchmark.json
```

可通过runBenchmark(seed, iterations)定制，iterations至少10；generateDataset生成固定种子/版本/哈希。默认10文件100个合成符号，不是1000文件AST基准。cold-index每样本空内存SQLite（迁移不计时）；incremental-index每样本先建立完整基线，基线不计时。
报告包含原始样本、nearest-rank P50/P95/min/max、Git SHA/dirty、解析器与数据集版本、CPU型号/逻辑核/内存/OS/Node/Electron、CPU微秒和OS I/O计数。RSS是进程生命周期high-water，非场景隔离峰值；Windows I/O计数可能为0/不可用，不伪造。实际报告见benchmarks/rc5-a1-synthetic.json，记录功能提交aee2d82的干净代码。仅观察性测量，不证明RC5性能目标或AC-19完整通过。

## 后续及停止点

本轮到此停止。A-2接入TS Compiler API，生成声明/指纹/范围/诊断和静态引用；通过FileUpdateSchema写入CodeIndex，补齐真实源码的身份/语法错误恢复及解析器版本失效回归。Python完整扫描、UI、Electron视觉、GitHub扩展不在本轮。
