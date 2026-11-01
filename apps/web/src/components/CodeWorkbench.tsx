import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArchitectureNode,
  ArchitectureResponse,
  CodeSymbol,
  SourceFile,
} from '@archsync/contracts';
import {
  loadArchitecture,
  loadCodeIndex,
  loadCodeIndexStatus,
  loadCodeSource,
  loadWorkspace,
  saveWorkspace,
  type CodeIndexResponse,
  type SourceResponse,
} from '../lib/code-index-api.js';
import { ArchitectureGraph } from './ArchitectureGraph.js';
import { ErrorBoundary } from './ErrorBoundary.js';

type Level = 'system' | 'module' | 'file' | 'symbol';

const LEVEL_LABEL: Record<Level, string> = { system: '系统', module: '模块', file: '文件', symbol: '符号' };

function readPreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: session-only */
  }
}

export function CodeWorkbench({ projectId }: { projectId: string }) {
  const [index, setIndex] = useState<CodeIndexResponse | null>(null);
  const [indexState, setIndexState] = useState<'idle' | 'scanning' | 'ready' | 'error' | 'unavailable'>('idle');
  const [indexError, setIndexError] = useState('');
  const [arch, setArch] = useState<ArchitectureResponse | null>(null);
  const [archError, setArchError] = useState('');
  const [archLoading, setArchLoading] = useState(false);
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [symbolUid, setSymbolUid] = useState<string | null>(null);
  const [source, setSource] = useState<SourceResponse | null>(null);
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState('all');
  const [publicOnly, setPublicOnly] = useState(false);
  const [includeStale, setIncludeStale] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [viewMode, setViewMode] = useState<'graph' | 'list'>(() =>
    readPreference('archsync-code-view', 'graph', ['graph', 'list']),
  );
  const [fileView, setFileView] = useState<'files' | 'symbols'>(() =>
    readPreference('archsync-code-file-view', 'files', ['files', 'symbols']),
  );
  const [refreshKey, setRefreshKey] = useState(0);

  const selectionTouched = useRef(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const selectedLine = useRef<HTMLSpanElement>(null);
  const indexVersionRef = useRef<number | null>(null);
  const archGeneration = useRef(0);
  const indexGeneration = useRef(0);

  const level: Level = symbolUid
    ? 'symbol'
    : filePath && fileView === 'symbols'
      ? 'symbol'
      : filePath
        ? 'file'
        : moduleId
          ? 'module'
          : 'system';
  const sourceRevision = index?.files.find((file) => file.filePath === filePath)?.revision;

  useEffect(() => {
    if (index?.changes === null) setOnlyChanged(false);
  }, [index?.changes]);
  // The workbench unmounts when the user switches to the planned view; the
  // chosen presentation must survive that (and a restart).
  useEffect(() => {
    writePreference('archsync-code-view', viewMode);
  }, [viewMode]);
  useEffect(() => {
    writePreference('archsync-code-file-view', fileView);
  }, [fileView]);

  const navigate = (nextModule: string | null, nextFile: string | null, nextSymbol: string | null) => {
    setModuleId(nextModule);
    setFilePath(nextFile);
    setSymbolUid(nextSymbol);
    if (nextFile !== filePath && !nextSymbol) setFileView('files');
    selectionTouched.current = true;
    const selection = { moduleId: nextModule, filePath: nextFile, symbolUid: nextSymbol };
    saveQueue.current = saveQueue.current
      .then(() => saveWorkspace(projectId, selection))
      .catch((err: unknown) => setIndexError(err instanceof Error ? err.message : '工作台状态保存失败'));
  };

  /* ------------------------- index polling by version ------------------------- */
  useEffect(() => {
    let alive = true;
    const generation = ++indexGeneration.current;
    setIndex(null);
    setArch(null);
    setIndexError('');
    setArchError('');
    setModuleId(null);
    setFilePath(null);
    setSymbolUid(null);
    setSource(null);
    indexVersionRef.current = null;
    selectionTouched.current = false;
    void loadWorkspace(projectId)
      .then((saved) => {
        if (alive && generation === indexGeneration.current && !selectionTouched.current) {
          setModuleId(saved.moduleId);
          setFilePath(saved.filePath);
          setSymbolUid(saved.symbolUid);
        }
      })
      .catch((err: unknown) => {
        if (alive) setIndexError(err instanceof Error ? err.message : '工作台状态不可用');
      });

    const tick = async () => {
      try {
        // Cheap status first: the full index (files + relations) is only
        // transferred when its version actually changed.
        const status = await loadCodeIndexStatus(projectId);
        if (!alive || generation !== indexGeneration.current) return;
        setIndexState(status.state);
        // During a rebuild the AST batch lands before the Python batch; do not
        // replace a complete tree with a half-scanned one. Apply the full
        // index only when the rebuild reports ready (or failed).
        if ((status.state === 'ready' || status.state === 'error') &&
            (indexVersionRef.current === null || status.indexVersion !== indexVersionRef.current)) {
          const next = await loadCodeIndex(projectId);
          if (!alive || generation !== indexGeneration.current) return;
          indexVersionRef.current = next.indexVersion ?? status.indexVersion;
          setIndex(next);
        }
        setIndexError('');
      } catch (err) {
        if (alive && generation === indexGeneration.current) {
          setIndexError(err instanceof Error ? err.message : '索引不可用');
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId]);

  /* ---------------------- selection validity after index ---------------------- */
  useEffect(() => {
    if (!index) return;
    const moduleIds = new Set(index.modules.map((module) => module.id));
    if (moduleId && !moduleIds.has(moduleId)) {
      setModuleId(null);
      setFilePath(null);
      setSymbolUid(null);
      return;
    }
    const file = index.files.find((item) => item.filePath === filePath);
    if (filePath && (!file || file.status === 'deleted')) {
      setFilePath(null);
      setSymbolUid(null);
      return;
    }
    if (symbolUid && !file?.symbols.some((symbol) => symbol.symbolUid === symbolUid)) {
      setSymbolUid(null);
    }
  }, [index, moduleId, filePath, symbolUid]);

  /* ----------------------------- architecture ----------------------------- */
  useEffect(() => {
    // The system graph does not need the full (potentially multi-megabyte)
    // code index; render it first and let the index arrive in the background.
    let alive = true;
    const generation = ++archGeneration.current;
    setArchLoading(true);
    setArchError('');
    const query =
      level === 'system'
        ? { level: 'system' as const }
        : level === 'module'
          ? { level: 'module' as const, moduleId: moduleId ?? undefined }
          : level === 'file'
            ? { level: 'file' as const, moduleId: moduleId ?? undefined, systemId: undefined }
            : { level: 'symbol' as const, filePath: filePath ?? undefined };
    void loadArchitecture(projectId, query)
      .then((next) => {
        if (!alive || generation !== archGeneration.current) return;
        if (!next || !Array.isArray(next.nodes) || !Array.isArray(next.edges)) {
          throw new Error('架构投影数据无效（nodes/edges 缺失）');
        }
        // Never let an older projection overwrite a newer index state.
        setArch((current) => (current && next.indexVersion < current.indexVersion ? current : next));
      })
      .catch((err: unknown) => {
        if (alive && generation === archGeneration.current) {
          setArchError(err instanceof Error ? err.message : '架构投影不可用');
        }
      })
      .finally(() => {
        if (alive && generation === archGeneration.current) setArchLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, level, moduleId, filePath, index?.indexVersion, refreshKey]);

  /* -------------------------------- source -------------------------------- */
  useEffect(() => {
    let alive = true;
    setSource(null);
    if (filePath) {
      void loadCodeSource(projectId, filePath)
        .then((data) => {
          if (alive) setSource(data);
        })
        .catch((err: unknown) => {
          if (alive) setIndexError(err instanceof Error ? err.message : '源码不可读取');
        });
    }
    return () => {
      alive = false;
    };
  }, [projectId, filePath, sourceRevision]);

  useEffect(() => {
    if (source && symbolUid) selectedLine.current?.scrollIntoView({ block: 'center' });
  }, [source, symbolUid]);

  /* ------------------------------- derived data ------------------------------- */
  const changedPaths = useMemo(() => new Set((index?.changes ?? []).map((change) => change.path)), [index?.changes]);
  const terms = search.trim().toLowerCase();
  const files = useMemo(
    () =>
      (index?.files ?? []).filter(
        (file) =>
          file.status !== 'deleted' &&
          (includeStale || file.status === 'fresh') &&
          (language === 'all' || file.language === language) &&
          (!onlyChanged || changedPaths.has(file.filePath)),
      ),
    [index?.files, includeStale, language, onlyChanged, changedPaths],
  );
  const fileMatches = (file: SourceFile) =>
    !terms ||
    file.filePath.toLowerCase().includes(terms) ||
    file.symbols.some((symbol) => symbol.qualifiedName.toLowerCase().includes(terms));

  const selectedModule = index?.modules.find((item) => item.id === moduleId);
  const selectedFile = index?.files.find((item) => item.filePath === filePath);
  const selectedSymbol: CodeSymbol | undefined = selectedFile?.symbols.find((item) => item.symbolUid === symbolUid);
  const symbols = (selectedFile?.symbols ?? []).filter(
    (symbol) =>
      symbol.kind !== 'module' &&
      (!publicOnly || symbol.exported === true) &&
      (!terms || symbol.qualifiedName.toLowerCase().includes(terms) || selectedFile?.filePath.toLowerCase().includes(terms)),
  );
  const nameByUid = useMemo(
    () => new Map((index?.files ?? []).flatMap((f) => f.symbols).map((s) => [s.symbolUid, `${s.qualifiedName} · ${s.filePath}:${s.startLine}`])),
    [index?.files],
  );
  const trusted = useMemo(
    () => new Set((index?.trustedRelations ?? []).map((relation) => `${relation.sourceUid}|${relation.targetUid}|${relation.kind}`)),
    [index?.trustedRelations],
  );
  const childUids = useMemo(
    () =>
      new Set(
        (selectedFile?.symbols ?? [])
          .filter((symbol) => symbol.parentSymbolUid === selectedSymbol?.symbolUid)
          .map((symbol) => symbol.symbolUid),
      ),
    [selectedFile?.symbols, selectedSymbol?.symbolUid],
  );
  const relations =
    selectedFile?.status === 'fresh' && selectedSymbol
      ? selectedFile.relations.filter(
          (relation) => relation.sourceUid === selectedSymbol.symbolUid || childUids.has(relation.sourceUid),
        )
      : [];

  const systems = useMemo(() => {
    if (!index) return [];
    const configured = index.systems ?? [];
    const byId = new Map(configured.map((system) => [system.id, system]));
    for (const module of index.modules) {
      const systemId = module.systemId ?? module.layer;
      if (systemId && !byId.has(systemId)) byId.set(systemId, { id: systemId, label: systemId, order: byId.size + 1 });
    }
    return [...byId.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, [index]);

  const moduleFiles = files.filter((file) => file.moduleId === moduleId && fileMatches(file));

  const filteredArch = useMemo(() => {
    if (!arch || !Array.isArray(arch.nodes) || !Array.isArray(arch.edges)) return null;
    const keep = (node: ArchitectureNode): boolean => {
      if (terms) {
        const haystack = `${node.label} ${node.filePath ?? ''}`.toLowerCase();
        if (!haystack.includes(terms)) return false;
      }
      if (language !== 'all' && node.language && node.language !== language) return false;
      if (!includeStale && (node.status === 'stale' || node.status === 'partial' || node.status === 'unavailable') && node.kind !== 'module' && node.kind !== 'system') return false;
      if (onlyChanged) {
        if (node.filePath) return changedPaths.has(node.filePath);
        if (node.kind === 'module' || node.kind === 'system') {
          const ids = new Set(arch.nodes.filter((item) => item.parentId === node.id && item.filePath).map((item) => item.filePath!));
          return [...ids].some((path) => changedPaths.has(path));
        }
        return true;
      }
      return true;
    };
    const nodes = arch.nodes.filter(keep);
    const visible = new Set(nodes.map((node) => node.id));
    return { ...arch, nodes, edges: arch.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)) };
  }, [arch, terms, language, includeStale, onlyChanged, changedPaths]);

  const openNode = (node: ArchitectureNode) => {
    if (node.kind === 'system') {
      navigate(null, null, null);
      return;
    }
    if (node.kind === 'module' && node.moduleId) {
      navigate(node.moduleId, null, null);
      return;
    }
    if (node.kind === 'file' && node.filePath) {
      navigate(node.moduleId ?? moduleId, node.filePath, null);
      return;
    }
    if (node.symbolUid && node.filePath) {
      navigate(node.moduleId ?? moduleId, node.filePath, node.symbolUid);
    }
  };

  const stateLabel = ({ idle: '待扫描', scanning: '扫描中', ready: '扫描完成', error: '扫描失败', unavailable: '不可用' })[indexState];
  const archSelection = archSelectionFor(level, moduleId, filePath, symbolUid);

  return (
    <section className="code-workbench" aria-label="真实代码架构">
      <div className="code-heading">
        <div>
          <strong>代码架构</strong>
          <span>
            真实源码 · {index?.origin === 'inferred' ? '模块由代码证据自动发现' : '规划与实际分别显示'}
            {level !== 'system' && ` · ${LEVEL_LABEL[level]}级`}
          </span>
        </div>
        <span>
          {index
            ? `${stateLabel} · ${index.summary.fresh} 个有效文件 · ${index.summary.freshSymbols} 个符号 · ${index.summary.stale} 个过期文件`
            : stateLabel === '扫描中' ? '扫描中…（架构图可先查看）' : '正在加载索引…（架构图可先查看）'}
        </span>
      </div>
      {(indexError || index?.error) && <p className="code-alert" role="alert">{indexError || index?.error}</p>}
      <div className="code-controls">
        <input aria-label="搜索代码" placeholder="搜索文件、模块或符号" value={search} onChange={(event) => setSearch(event.target.value)} />
        <select aria-label="语言筛选" value={language} onChange={(event) => setLanguage(event.target.value)}>
          <option value="all">全部语言</option>
          <option value="typescript">TypeScript</option>
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
        </select>
        <label><input type="checkbox" checked={publicOnly} onChange={(event) => setPublicOnly(event.target.checked)} />仅公开接口</label>
        <label><input type="checkbox" checked={includeStale} onChange={(event) => setIncludeStale(event.target.checked)} />显示过期索引</label>
        <label title={index?.changes === null ? 'Git 状态不可用' : '仅本机未提交变更'}>
          <input type="checkbox" disabled={!index?.changes} checked={onlyChanged} onChange={(event) => setOnlyChanged(event.target.checked)} />仅未提交变更
        </label>
        <div className="code-view-toggle" role="group" aria-label="展示方式">
          <button className={viewMode === 'graph' ? 'on' : ''} onClick={() => setViewMode('graph')}>关系图</button>
          <button className={viewMode === 'list' ? 'on' : ''} onClick={() => setViewMode('list')}>列表</button>
        </div>
        {filePath && (
          <div className="code-view-toggle" role="group" aria-label="文件级视图">
            <button className={fileView === 'files' ? 'on' : ''} onClick={() => { setFileView('files'); setSymbolUid(null); }}>文件依赖</button>
            <button className={fileView === 'symbols' ? 'on' : ''} onClick={() => setFileView('symbols')}>符号调用</button>
          </div>
        )}
      </div>
      <nav className="code-crumbs" aria-label="代码层级">
        <button onClick={() => navigate(null, null, null)}>系统</button>
        {selectedModule && (
          <>
            <span>›</span>
            <button onClick={() => navigate(moduleId, null, null)}>{selectedModule.label}</button>
          </>
        )}
        {filePath && (
          <>
            <span>›</span>
            <button onClick={() => navigate(moduleId, filePath, null)}>{filePath}</button>
          </>
        )}
        {selectedSymbol && (
          <>
            <span>›</span>
            <span>{selectedSymbol.name}</span>
          </>
        )}
      </nav>

      <div className="code-shell">
        <aside className="code-tree" aria-label="架构树">
          <div className="code-tree-head">架构树</div>
          {!index && <p className="hint">索引加载中…</p>}
          {index && systems.length === 0 && <p className="hint">没有可显示的模块。</p>}
          {systems.map((system) => {
            const systemModules = index?.modules.filter((module) => (module.systemId ?? module.layer) === system.id) ?? [];
            const systemFiles = (index?.files ?? []).filter((file) => systemModules.some((module) => module.id === file.moduleId) && file.status !== 'deleted');
            return (
              <details key={system.id} open className="code-tree-system">
                <summary>
                  <span>{system.label}</span>
                  <span className="hint">{systemModules.length} 模块 · {systemFiles.length} 文件</span>
                </summary>
                {systemModules.map((module) => {
                  const moduleFileList = (index?.files ?? []).filter((file) => file.moduleId === module.id && file.status !== 'deleted');
                  return (
                    <div key={module.id} className="code-tree-module">
                      <button
                        className={module.id === moduleId ? 'selected' : ''}
                        onClick={() => navigate(module.id, null, null)}
                        title={module.discoveryEvidence?.join('、')}
                      >
                        <span>{module.label}</span>
                        <span className="hint">
                          {moduleFileList.length} 文件
                          {module.confidence && module.confidence !== 'high' ? ` · ${module.confidence}` : ''}
                        </span>
                      </button>
                      {module.id === moduleId &&
                        moduleFileList
                          .filter(fileMatches)
                          .slice(0, 80)
                          .map((file) => (
                            <button
                              key={file.filePath}
                              className={`code-tree-file${file.filePath === filePath ? ' selected' : ''}`}
                              onClick={() => navigate(module.id, file.filePath, null)}
                            >
                              {file.filePath.split('/').slice(-2).join('/')}
                            </button>
                          ))}
                    </div>
                  );
                })}
              </details>
            );
          })}
        </aside>

        <div className="code-main">
          {viewMode === 'graph' && (
            <div className="code-graph-panel">
              {archLoading && <p className="hint">正在生成{LEVEL_LABEL[level]}级关系图…</p>}
              {archError && (
                <div className="code-alert" role="alert">
                  {archError}
                  <button onClick={() => setRefreshKey((value) => value + 1)}>重试</button>
                </div>
              )}
              {!archError && filteredArch && (
                <ErrorBoundary scope="架构关系图">
                  <ArchitectureGraph
                    response={filteredArch}
                    selectedId={archSelection}
                    onSelect={openNode}
                    changedPaths={changedPaths}
                  />
                </ErrorBoundary>
              )}
              {!archError && !filteredArch && !archLoading && <p className="hint">没有可显示的架构数据。</p>}
            </div>
          )}
          {viewMode === 'list' && (
            <div className="code-list">
              {level === 'system' &&
                systems.map((system) => (
                  <div key={system.id} className="code-list-group">
                    <h4>{system.label}</h4>
                    {index?.modules
                      .filter((module) => (module.systemId ?? module.layer) === system.id)
                      .map((module) => (
                        <button key={module.id} onClick={() => navigate(module.id, null, null)}>
                          <strong>{module.label}</strong>
                          <span>
                            {(index?.files ?? []).filter((file) => file.moduleId === module.id && file.status !== 'deleted').length} 个文件
                            {module.confidence ? ` · 置信度 ${module.confidence}` : ''}
                          </span>
                        </button>
                      ))}
                  </div>
                ))}
              {level === 'module' &&
                moduleFiles.slice(0, 300).map((file) => (
                  <button key={file.filePath} onClick={() => navigate(moduleId, file.filePath, null)}>
                    <strong>{file.filePath}</strong>
                    <span>
                      {file.language} · {file.status} · {file.symbols.filter((symbol) => symbol.kind !== 'module').length} 个声明
                      {changedPaths.has(file.filePath) ? ' · 未提交' : ''}
                    </span>
                  </button>
                ))}
              {level === 'module' && moduleFiles.length === 0 && <p>没有符合条件的文件。</p>}
              {(level === 'file' || level === 'symbol') &&
                symbols.slice(0, 500).map((symbol) => (
                  <button key={symbol.symbolUid} className={symbol.symbolUid === symbolUid ? 'selected' : ''} onClick={() => navigate(moduleId, filePath, symbol.symbolUid)}>
                    <strong>{symbol.qualifiedName}</strong>
                    <span>{symbol.kind} · 第 {symbol.startLine} 行</span>
                  </button>
                ))}
              {(level === 'file' || level === 'symbol') && symbols.length === 0 && <p>没有符合条件的声明。</p>}
              {(level === 'file' || level === 'symbol') && symbols.length > 500 && <p className="hint">仅显示前 500 个声明；请使用搜索缩小范围。</p>}
              {level === 'module' && moduleFiles.length > 300 && <p className="hint">仅显示前 300 个文件；请使用搜索缩小范围。</p>}
            </div>
          )}
        </div>

        <aside className="code-detail" aria-label="详情与源码">
          {selectedSymbol ? (
            <>
              <h3>{selectedSymbol.qualifiedName}</h3>
              <code>{selectedSymbol.signature}</code>
              <p>
                {selectedSymbol.filePath}:{selectedSymbol.startLine}:{selectedSymbol.startColumn ?? 1} · {selectedSymbol.exported ? '导出' : '未确认导出'}
              </p>
              {selectedSymbol.parameters.length > 0 && (
                <p>
                  参数：
                  {selectedSymbol.parameters
                    .map((parameter) => `${parameter.name}${parameter.optional ? '?' : ''}: ${parameter.type ?? '未知类型'}${parameter.defaultValue ? ` = ${parameter.defaultValue}` : ''}`)
                    .join('、')}
                </p>
              )}
              <p>返回类型：{selectedSymbol.returnType ?? '未知'}</p>
              {selectedSymbol.docComment && <pre>{selectedSymbol.docComment}</pre>}
              <h4>静态关系与证据</h4>
              {relations.length ? (
                relations.map((relation, i) => {
                  const valid = relation.strength !== 'resolved' || trusted.has(`${relation.sourceUid}|${relation.targetUid}|${relation.kind}`);
                  return (
                    <p key={`${relation.kind}-${i}`}>
                      {relation.kind} · {valid ? relation.strength : '失效'} ·{' '}
                      {relation.sourceUid !== selectedSymbol.symbolUid && `${nameByUid.get(relation.sourceUid)?.split(' · ')[0] ?? '子符号'} → `}
                      {valid ? (relation.targetUid ? nameByUid.get(relation.targetUid) ?? '目标不可用' : relation.reason ?? '未解析') : '目标不再可信'} ·{' '}
                      {relation.evidence[0]?.filePath}:{relation.evidence[0]?.startLine}
                    </p>
                  );
                })
              ) : (
                <p>无可显示的当前关系。</p>
              )}
              {selectedFile?.status !== 'fresh' && <p className="code-alert">{selectedFile?.status ?? '文件不可用'}：历史符号不是当前代码事实。</p>}
              {source && (
                <>
                  <h4>源码 {source.indexedContentMatches ? '' : '（内容与索引不一致）'}</h4>
                  <pre className="code-source">
                    {source.content.split('\n').map((line, i) => (
                      <span ref={selectedSymbol && i + 1 === selectedSymbol.startLine ? selectedLine : undefined} key={i} className={selectedSymbol && i + 1 === selectedSymbol.startLine ? 'code-line-selected' : ''}>
                        <i>{i + 1}</i>
                        {line || ' '}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                </>
              )}
            </>
          ) : selectedFile ? (
            <>
              <h3>{selectedFile.filePath}</h3>
              <p>
                {selectedFile.language} · {selectedFile.status} · revision {selectedFile.revision}
              </p>
              <p>
                {selectedFile.symbols.filter((symbol) => symbol.kind !== 'module').length} 个声明 · {selectedFile.relations.length} 条关系
              </p>
              <h4>导入与调用</h4>
              {selectedFile.relations.length ? (
                selectedFile.relations.slice(0, 40).map((relation, i) => (
                  <p key={i}>
                    {relation.kind} · {relation.strength} · {relation.targetUid ? nameByUid.get(relation.targetUid) ?? '目标不可用' : relation.reason ?? '未解析'}
                  </p>
                ))
              ) : (
                <p>该文件没有已解析的跨文件关系。</p>
              )}
              {source && (
                <>
                  <h4>源码 {source.indexedContentMatches ? '' : '（内容与索引不一致）'}</h4>
                  <pre className="code-source">
                    {source.content.split('\n').map((line, i) => (
                      <span key={i}>
                        <i>{i + 1}</i>
                        {line || ' '}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                </>
              )}
            </>
          ) : selectedModule ? (
            <>
              <h3>{selectedModule.label}</h3>
              <p>{index?.origin === 'inferred' ? '自动发现模块' : '规划模块'}</p>
              {selectedModule.confidence && <p>识别置信度：{selectedModule.confidence}</p>}
              {selectedModule.discoveryEvidence?.length ? <p>证据：{selectedModule.discoveryEvidence.join('、')}</p> : null}
              <p>
                {moduleFiles.length} 个文件 · {moduleFiles.reduce((total, file) => total + file.symbols.filter((symbol) => symbol.kind !== 'module').length, 0)} 个声明
              </p>
              {arch && arch.level === 'module' && (
                <>
                  <h4>依赖</h4>
                  {arch.edges.length ? arch.edges.slice(0, 20).map((edge) => <p key={edge.id}>{edge.kind} · {edge.count} 条证据</p>) : <p>没有已解析的模块依赖。</p>}
                </>
              )}
              <p className="hint">选择左侧文件可查看真实源码与符号关系。</p>
            </>
          ) : (
            <p>选择模块、文件或符号以查看证据与源码。</p>
          )}
        </aside>
      </div>
    </section>
  );
}

/** The graph selection mirrors the breadcrumb: symbol > file > module > system. */
function archSelectionFor(level: Level, moduleId: string | null, filePath: string | null, symbolUid: string | null): string | null {
  if (level === 'symbol' && symbolUid) return `sym:${symbolUid}`;
  if (level === 'file' && filePath) return `file:${filePath}`;
  if (level === 'module' && moduleId) return `mod:${moduleId}`;
  return null;
}
