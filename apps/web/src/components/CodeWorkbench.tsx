import { useEffect, useMemo, useState } from 'react';
import type { CodeSymbol, SourceFile } from '@archsync/contracts';
import { loadCodeIndex, loadCodeSource, type CodeIndexResponse, type SourceResponse } from '../lib/code-index-api.js';

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
  const sourceRevision = index?.files.find((file) => file.filePath === filePath)?.revision;

  const navigate = (nextModule: string | null, nextFile: string | null, nextSymbol: string | null) => {
    setModuleId(nextModule); setFilePath(nextFile); setSymbolUid(nextSymbol);
    try { localStorage.setItem(`archsync-code-view:${projectId}`, JSON.stringify({ moduleId: nextModule, filePath: nextFile, symbolUid: nextSymbol })); } catch { /* storage can be disabled */ }
  };

  useEffect(() => {
    let alive = true;
    setIndex(null); setError(''); setSource(null);
    try {
      const saved = JSON.parse(localStorage.getItem(`archsync-code-view:${projectId}`) ?? '{}') as Record<string, unknown>;
      setModuleId(typeof saved.moduleId === 'string' ? saved.moduleId : null);
      setFilePath(typeof saved.filePath === 'string' ? saved.filePath : null);
      setSymbolUid(typeof saved.symbolUid === 'string' ? saved.symbolUid : null);
    } catch { setModuleId(null); setFilePath(null); setSymbolUid(null); }
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

  const files = useMemo(() => (index?.files ?? []).filter((file) => file.status !== 'deleted' && (includeStale || file.status === 'fresh') && (language === 'all' || file.language === language)), [index, includeStale, language]);
  const selectedModule = index?.modules.find((item) => item.id === moduleId);
  const selectedFile = files.find((item) => item.filePath === filePath);
  const selectedSymbol: CodeSymbol | undefined = selectedFile?.symbols.find((item) => item.symbolUid === symbolUid);
  const terms = search.trim().toLowerCase();
  const matches = (file: SourceFile) => !terms || file.filePath.toLowerCase().includes(terms) || file.symbols.some((s) => s.qualifiedName.toLowerCase().includes(terms));
  const moduleFiles = files.filter((file) => file.moduleId === moduleId && matches(file));
  const symbols = (selectedFile?.symbols ?? []).filter((symbol) => symbol.kind !== 'module' && (!publicOnly || symbol.exported === true) && (!terms || symbol.qualifiedName.toLowerCase().includes(terms) || selectedFile?.filePath.toLowerCase().includes(terms)));
  const nameByUid = new Map((index?.files ?? []).flatMap((f) => f.symbols).map((s) => [s.symbolUid, `${s.qualifiedName} · ${s.filePath}:${s.startLine}`]));
  const relations = selectedFile?.status === 'fresh' && selectedSymbol
    ? selectedFile.relations.filter((relation) => relation.sourceUid === selectedSymbol.symbolUid) : [];

  return <section className="code-workbench" aria-label="真实代码架构">
    <div className="code-heading"><div><strong>代码架构</strong><span>真实源码 · {index?.origin === 'inferred' ? '分组为推断' : '规划与实际分别显示'}</span></div>
      <span>{index ? `${index.state} · ${index.summary.fresh} 个有效文件 · ${index.summary.freshSymbols} 个符号 · ${index.summary.stale} 个过期文件` : '正在加载索引…'}</span></div>
    {(error || index?.error) && <p className="code-alert" role="alert">{error || index?.error}</p>}
    <div className="code-controls">
      <input aria-label="搜索代码" placeholder="搜索文件或符号" value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label="语言筛选" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="all">全部语言</option><option value="typescript">TypeScript</option><option value="javascript">JavaScript</option><option value="python">Python</option></select>
      <label><input type="checkbox" checked={publicOnly} onChange={(event) => setPublicOnly(event.target.checked)} />仅公开接口</label>
      <label><input type="checkbox" checked={includeStale} onChange={(event) => setIncludeStale(event.target.checked)} />显示过期索引</label>
    </div>
    <nav className="code-crumbs" aria-label="代码层级">
      <button onClick={() => navigate(null, null, null)}>系统</button>
      {selectedModule && <><span>›</span><button onClick={() => navigate(moduleId, null, null)}>{selectedModule.label}</button></>}
      {filePath && <><span>›</span><button onClick={() => navigate(moduleId, filePath, null)}>{filePath}</button></>}
      {selectedSymbol && <><span>›</span><span>{selectedSymbol.name}</span></>}
    </nav>
    <div className="code-content">
      {!moduleId && <div className="code-grid">{index?.modules.map((module) => {
        const group = files.filter((file) => file.moduleId === module.id && matches(file));
        return <button className="code-card" key={module.id} onClick={() => navigate(module.id, null, null)}><strong>{module.label}</strong><span>{group.length} 个文件 · {group.reduce((n, file) => n + file.symbols.filter((s) => s.kind !== 'module').length, 0)} 个声明</span></button>;
      })}</div>}
      {moduleId && !filePath && <div className="code-list">{moduleFiles.map((file) => <button key={file.filePath} onClick={() => navigate(moduleId, file.filePath, null)}><strong>{file.filePath}</strong><span>{file.language} · {file.status} · {file.symbols.filter((s) => s.kind !== 'module').length} 个声明</span></button>)}{moduleFiles.length === 0 && <p>没有符合条件的文件。</p>}</div>}
      {filePath && <div className="code-file-view"><div className="code-list code-symbols">{selectedFile?.status !== 'fresh' && <p className="code-alert">{selectedFile?.status ?? '文件不可用'}：历史符号不是当前代码事实。</p>}{symbols.map((symbol) => <button key={symbol.symbolUid} className={symbol.symbolUid === symbolUid ? 'selected' : ''} onClick={() => navigate(moduleId, filePath, symbol.symbolUid)}><strong>{symbol.qualifiedName}</strong><span>{symbol.kind} · 第 {symbol.startLine} 行</span></button>)}{symbols.length === 0 && <p>没有符合条件的声明。</p>}</div>
        <div className="code-detail">{selectedSymbol ? <><h3>{selectedSymbol.qualifiedName}</h3><code>{selectedSymbol.signature}</code><p>{selectedSymbol.filePath}:{selectedSymbol.startLine}:{selectedSymbol.startColumn ?? 1} · {selectedSymbol.exported ? '导出' : '未确认导出'}</p><p>返回类型：{selectedSymbol.returnType ?? '未知'}</p>{selectedSymbol.docComment && <pre>{selectedSymbol.docComment}</pre>}<h4>静态关系与证据</h4>{relations.length ? relations.map((relation, i) => <p key={`${relation.kind}-${i}`}>{relation.kind} · {relation.strength} · {relation.targetUid ? nameByUid.get(relation.targetUid) ?? '目标不可用' : relation.reason ?? '未解析'} · {relation.evidence[0]?.filePath}:{relation.evidence[0]?.startLine}</p>) : <p>无可显示的当前关系。</p>}</> : <p>选择声明以查看签名、证据和源码。</p>}
          {source && <><h4>源码 {source.indexedContentMatches ? '' : '（内容与索引不一致）'}</h4><pre className="code-source">{source.content.split('\n').map((line, i) => <span key={i} className={selectedSymbol && i + 1 === selectedSymbol.startLine ? 'code-line-selected' : ''}><i>{i + 1}</i>{line || ' '}{'\n'}</span>)}</pre></>}
        </div></div>}
    </div>
  </section>;
}
