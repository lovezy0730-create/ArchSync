import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MarkerType, Position, ReactFlow } from '@xyflow/react';
import type { CodeSymbol, SourceFile } from '@archsync/contracts';
import { loadCodeIndex, loadCodeSource, loadWorkspace, saveWorkspace, type CodeIndexResponse, type SourceResponse } from '../lib/code-index-api.js';

export function CodeWorkbench({ projectId }: { projectId: string }) {
  const [index, setIndex] = useState<CodeIndexResponse | null>(null);
  const [error, setError] = useState('');
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [symbolUid, setSymbolUid] = useState<string | null>(null);
  const [source, setSource] = useState<SourceResponse | null>(null);
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState('all');
  const [publicOnly, setPublicOnly] = useState(false);
  const [includeStale, setIncludeStale] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const selectionTouched = useRef(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const selectedLine = useRef<HTMLSpanElement>(null);
  const sourceRevision = index?.files.find((file) => file.filePath === filePath)?.revision;
  useEffect(() => { if (index?.changes === null) setOnlyChanged(false); }, [index?.changes]);

  const navigate = (nextModule: string | null, nextFile: string | null, nextSymbol: string | null) => {
    setModuleId(nextModule); setFilePath(nextFile); setSymbolUid(nextSymbol);
    selectionTouched.current = true;
    const selection = { moduleId: nextModule, filePath: nextFile, symbolUid: nextSymbol };
    saveQueue.current = saveQueue.current.then(() => saveWorkspace(projectId, selection)).catch((err: unknown) => { setError(err instanceof Error ? err.message : '工作台状态保存失败'); });
  };

  useEffect(() => {
    let alive = true;
    setIndex(null); setError(''); setSource(null); setModuleId(null); setFilePath(null); setSymbolUid(null); selectionTouched.current = false;
    void loadWorkspace(projectId).then((saved) => {
      if (alive && !selectionTouched.current) { setModuleId(saved.moduleId); setFilePath(saved.filePath); setSymbolUid(saved.symbolUid); }
    }).catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : '工作台状态不可用'); });
    const load = async () => {
      try {
        const next = await loadCodeIndex(projectId);
        if (alive) { setIndex(next); setError(''); }
      } catch (err) { if (alive) setError(err instanceof Error ? err.message : '索引不可用'); }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    setSource(null);
    if (filePath) void loadCodeSource(projectId, filePath)
      .then((data) => { if (alive) setSource(data); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : '源码不可读取'); });
    return () => { alive = false; };
  }, [projectId, filePath, sourceRevision]);

  const changedPaths = new Set((index?.changes ?? []).map((change) => change.path));
  const files = useMemo(() => (index?.files ?? []).filter((file) => file.status !== 'deleted' && (includeStale || file.status === 'fresh') && (language === 'all' || file.language === language) && (!onlyChanged || index?.changes?.some((change) => change.path === file.filePath))), [index, includeStale, language, onlyChanged]);
  const selectedModule = index?.modules.find((item) => item.id === moduleId);
  const selectedFile = files.find((item) => item.filePath === filePath);
  const selectedSymbol: CodeSymbol | undefined = selectedFile?.symbols.find((item) => item.symbolUid === symbolUid);
  const terms = search.trim().toLowerCase();
  const matches = (file: SourceFile) => !terms || file.filePath.toLowerCase().includes(terms) || file.symbols.some((s) => s.qualifiedName.toLowerCase().includes(terms));
  const moduleFiles = files.filter((file) => file.moduleId === moduleId && matches(file));
  const symbols = (selectedFile?.symbols ?? []).filter((symbol) => symbol.kind !== 'module' && (!publicOnly || symbol.exported === true) && (!terms || symbol.qualifiedName.toLowerCase().includes(terms) || selectedFile?.filePath.toLowerCase().includes(terms)));
  const nameByUid = new Map((index?.files ?? []).flatMap((f) => f.symbols).map((s) => [s.symbolUid, `${s.qualifiedName} · ${s.filePath}:${s.startLine}`]));
  const trusted = new Set((index?.trustedRelations ?? []).map((r) => `${r.sourceUid}|${r.targetUid}|${r.kind}`));
  const relations = selectedFile?.status === 'fresh' && selectedSymbol
    ? selectedFile.relations.filter((relation) => relation.sourceUid === selectedSymbol.symbolUid) : [];
  const moduleBySymbol = new Map((index?.files ?? []).filter((file) => file.status === 'fresh').flatMap((file) => file.symbols.map((symbol) => [symbol.symbolUid, file.moduleId] as const)));
  const edgeCounts = new Map<string, { source: string; target: string; count: number }>();
  for (const relation of index?.trustedRelations ?? []) {
    if (!['imports', 'calls'].includes(relation.kind) || !relation.targetUid) continue;
    const sourceModule = moduleBySymbol.get(relation.sourceUid);
    const targetModule = moduleBySymbol.get(relation.targetUid);
    if (!sourceModule || !targetModule || sourceModule === targetModule) continue;
    const key = `${sourceModule}|${targetModule}`;
    const current = edgeCounts.get(key);
    if (current) current.count++; else edgeCounts.set(key, { source: sourceModule, target: targetModule, count: 1 });
  }
  useEffect(() => {
    if (source && selectedSymbol) selectedLine.current?.scrollIntoView({ block: 'center' });
  }, [source, symbolUid]);

  return <section className="code-workbench" aria-label="真实代码架构">
    <div className="code-heading"><div><strong>代码架构</strong><span>真实源码 · {index?.origin === 'inferred' ? '分组为推断' : '规划与实际分别显示'}</span></div>
      <span>{index ? `${({ idle: '待扫描', scanning: '扫描中', ready: '扫描完成', error: '扫描失败', unavailable: '不可用' })[index.state]} · ${index.summary.fresh} 个有效文件 · ${index.summary.freshSymbols} 个符号 · ${index.summary.stale} 个过期文件` : '正在加载索引…'}</span></div>
    {(error || index?.error) && <p className="code-alert" role="alert">{error || index?.error}</p>}
    <div className="code-controls">
      <input aria-label="搜索代码" placeholder="搜索文件或符号" value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label="语言筛选" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="all">全部语言</option><option value="typescript">TypeScript</option><option value="javascript">JavaScript</option><option value="python">Python</option></select>
      <label><input type="checkbox" checked={publicOnly} onChange={(event) => setPublicOnly(event.target.checked)} />仅公开接口</label>
      <label><input type="checkbox" checked={includeStale} onChange={(event) => setIncludeStale(event.target.checked)} />显示过期索引</label>
      <label title={index?.changes === null ? 'Git 状态不可用' : '仅本机未提交变更'}><input type="checkbox" disabled={!index?.changes} checked={onlyChanged} onChange={(event) => setOnlyChanged(event.target.checked)} />仅未提交变更</label>
    </div>
    <nav className="code-crumbs" aria-label="代码层级">
      <button onClick={() => navigate(null, null, null)}>系统</button>
      {selectedModule && <><span>›</span><button onClick={() => navigate(moduleId, null, null)}>{selectedModule.label}</button></>}
      {filePath && <><span>›</span><button onClick={() => navigate(moduleId, filePath, null)}>{filePath}</button></>}
      {selectedSymbol && <><span>›</span><span>{selectedSymbol.name}</span></>}
    </nav>
    <div className="code-content">
      {!moduleId && index && <div className="code-graph"><ReactFlow fitView nodesDraggable={false} nodesConnectable={false} fitViewOptions={{ padding: 0.2, maxZoom: 1 }} nodes={index.modules.map((module, i) => {
        const group = files.filter((file) => file.moduleId === module.id && matches(file));
        const indexed = index.files.filter((file) => file.moduleId === module.id && file.status !== 'deleted');
        const comparison = index.origin !== 'planned' ? '自动分组（推断）'
          : module.id === '__observed_unplanned__' ? '实际存在，未规划'
            : index.state !== 'ready' ? '扫描未完成'
              : indexed.some((file) => file.status === 'fresh') ? '规划与实际匹配'
                : indexed.length ? '实际分析不完整' : '仅规划，未检测到源码';
        return { id: module.id, sourcePosition: Position.Right, targetPosition: Position.Left, position: { x: (i % 4) * 290, y: Math.floor(i / 4) * 160 }, style: { width: 250, padding: 0, border: 0, background: 'transparent' }, data: { label: <button className="code-card" data-module-id={module.id} onClick={() => navigate(module.id, null, null)}><strong>{module.label}</strong><span>{comparison}</span><span>{group.length} 个文件 · {group.reduce((n, file) => n + file.symbols.filter((s) => s.kind !== 'module').length, 0)} 个声明</span></button> } };
      })} edges={[...edgeCounts.values()].map((edge) => ({ id: `${edge.source}|${edge.target}`, source: edge.source, target: edge.target, label: String(edge.count), markerEnd: { type: MarkerType.ArrowClosed, color: '#58a6ff' }, style: { stroke: '#58a6ff' }, labelStyle: { fill: '#e6edf3' }, labelBgStyle: { fill: '#18212c' } }))}><Background /><Controls /></ReactFlow></div>}
      {moduleId && !filePath && <div className="code-list">{moduleFiles.map((file) => <button key={file.filePath} onClick={() => navigate(moduleId, file.filePath, null)}><strong>{file.filePath}</strong><span>{file.language} · {file.status} · {file.symbols.filter((s) => s.kind !== 'module').length} 个声明{changedPaths.has(file.filePath) ? ' · 未提交' : ''}</span></button>)}{moduleFiles.length === 0 && <p>没有符合条件的文件。</p>}</div>}
      {filePath && <div className="code-file-view"><div className="code-list code-symbols">{selectedFile?.status !== 'fresh' && <p className="code-alert">{selectedFile?.status ?? '文件不可用'}：历史符号不是当前代码事实。</p>}{symbols.map((symbol) => <button key={symbol.symbolUid} className={symbol.symbolUid === symbolUid ? 'selected' : ''} onClick={() => navigate(moduleId, filePath, symbol.symbolUid)}><strong>{symbol.qualifiedName}</strong><span>{symbol.kind} · 第 {symbol.startLine} 行</span></button>)}{symbols.length === 0 && <p>没有符合条件的声明。</p>}</div>
        <div className="code-detail">{selectedSymbol ? <><h3>{selectedSymbol.qualifiedName}</h3><code>{selectedSymbol.signature}</code><p>{selectedSymbol.filePath}:{selectedSymbol.startLine}:{selectedSymbol.startColumn ?? 1} · {selectedSymbol.exported ? '导出' : '未确认导出'}</p><p>返回类型：{selectedSymbol.returnType ?? '未知'}</p>{selectedSymbol.docComment && <pre>{selectedSymbol.docComment}</pre>}<h4>静态关系与证据</h4>{relations.length ? relations.map((relation, i) => {
          const valid = relation.strength !== 'resolved' || trusted.has(`${relation.sourceUid}|${relation.targetUid}|${relation.kind}`);
          return <p key={`${relation.kind}-${i}`}>{relation.kind} · {valid ? relation.strength : '失效'} · {valid ? (relation.targetUid ? nameByUid.get(relation.targetUid) ?? '目标不可用' : relation.reason ?? '未解析') : '目标不再可信'} · {relation.evidence[0]?.filePath}:{relation.evidence[0]?.startLine}</p>;
        }) : <p>无可显示的当前关系。</p>}</> : <p>选择声明以查看签名、证据和源码。</p>}
          {source && <><h4>源码 {source.indexedContentMatches ? '' : '（内容与索引不一致）'}</h4><pre className="code-source">{source.content.split('\n').map((line, i) => <span ref={selectedSymbol && i + 1 === selectedSymbol.startLine ? selectedLine : undefined} key={i} className={selectedSymbol && i + 1 === selectedSymbol.startLine ? 'code-line-selected' : ''}><i>{i + 1}</i>{line || ' '}{'\n'}</span>)}</pre></>}
        </div></div>}
    </div>
  </section>;
}
