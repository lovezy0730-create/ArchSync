import type {
  ArchitectureEdge,
  ArchitectureEdgeKind,
  ArchitectureLevel,
  ArchitectureNode,
  ArchitectureResponse,
  ArchitectureScope,
  CodeRelation,
  SourceFile,
} from '@archsync/contracts';
import type { ProjectEntry } from '../projects.js';
import type { DiscoveryPreferences } from './discovery.js';

/**
 * Build one architecture graph from the authoritative code index.
 *
 * The same facts drive every level: files and symbols from SQLite, relations
 * from the AST/Python scanners. Edges keep the evidence kind that produced
 * them, so an unresolved dynamic call can never be drawn as a resolved one.
 */

export interface ProjectionInput {
  entry: ProjectEntry;
  files: SourceFile[];
  level: ArchitectureLevel;
  scope: ArchitectureScope;
  preferences?: DiscoveryPreferences;
  now?: string;
}

interface SymbolLocation {
  file: SourceFile;
  symbolUid: string;
  name: string;
  kind: string;
}

const unplanned = '__observed_unplanned__';

function moduleLabel(entry: ProjectEntry, moduleId: string | null): string {
  if (!moduleId) return '未归类';
  return entry.config.modules.find((module) => module.id === moduleId)?.label ?? moduleId;
}

function systemOf(entry: ProjectEntry, moduleId: string | null): string | null {
  if (!moduleId) return null;
  const module = entry.config.modules.find((item) => item.id === moduleId);
  if (!module) return null;
  return module.systemId ?? module.layer ?? null;
}

function fileModule(entry: ProjectEntry, file: SourceFile, preferences?: DiscoveryPreferences): string {
  const moved = preferences?.moves[file.filePath];
  if (moved && entry.config.modules.some((module) => module.id === moved)) return moved;
  return file.moduleId;
}

function relationKind(relation: CodeRelation, stale: boolean): ArchitectureEdgeKind {
  if (relation.kind === 'unresolved_reference' || relation.targetUid === null) return 'unresolved';
  if (stale) return 'stale';
  if (relation.strength === 'resolved') return 'resolved';
  if (relation.strength === 'observed') return 'observed';
  return 'inferred';
}

const confidenceFor = (kind: ArchitectureEdgeKind): ArchitectureEdge['confidence'] =>
  kind === 'resolved' ? 'high' : kind === 'observed' ? 'medium' : kind === 'planned' ? 'medium' : 'low';

function symbolKindOf(kind: string): ArchitectureNode['kind'] | null {
  if (kind === 'module') return null; // file-level pseudo symbol, not a declaration
  if (kind === 'method') return 'function';
  return (['function', 'class', 'interface', 'type', 'constructor', 'endpoint', 'variable'].includes(kind)
    ? kind
    : 'unknown') as ArchitectureNode['kind'];
}

function countSymbols(files: SourceFile[]) {
  let symbols = 0;
  let functions = 0;
  let classes = 0;
  let interfaces = 0;
  for (const file of files) {
    for (const symbol of file.symbols) {
      if (symbol.kind === 'module') continue;
      symbols += 1;
      if (symbol.kind === 'function' || symbol.kind === 'method') functions += 1;
      else if (symbol.kind === 'class') classes += 1;
      else if (symbol.kind === 'interface') interfaces += 1;
    }
  }
  return { files: files.length, symbols, functions, classes, interfaces };
}

function fileStatus(file: SourceFile): ArchitectureNode['status'] {
  if (file.status === 'fresh') return 'fresh';
  if (file.status === 'stale') return 'stale';
  if (file.status === 'partial') return 'partial';
  if (file.status === 'deleted') return 'unavailable';
  return 'unknown';
}

function moduleNode(
  entry: ProjectEntry,
  moduleId: string,
  files: SourceFile[],
  parentId: string | null,
  level: ArchitectureLevel,
): ArchitectureNode {
  const config = entry.config.modules.find((module) => module.id === moduleId);
  const counts = countSymbols(files);
  const stale = files.some((file) => file.status !== 'fresh');
  return {
    id: `mod:${moduleId}`,
    level,
    kind: 'module',
    label: moduleLabel(entry, moduleId),
    parentId,
    moduleId,
    status: files.length === 0 ? 'unknown' : stale ? 'stale' : 'fresh',
    planned: entry.configOrigin === 'planned',
    observed: files.length > 0,
    confidence: config?.confidence ?? (entry.configOrigin === 'planned' ? 'high' : 'medium'),
    counts,
    evidence: [
      ...(config?.discoveryEvidence ?? []).map((detail) => ({ source: 'discovery', ref: moduleId, detail })),
      ...(files.length > 0 ? [{ source: 'code-index', ref: `${files.length} files` }] : []),
    ],
    meta: {
      systemId: config?.systemId ?? config?.layer ?? null,
      paths: config?.paths ?? [],
      plannedDependsOn: config?.plannedDependsOn ?? [],
    },
  };
}

export function projectArchitecture(input: ProjectionInput): ArchitectureResponse {
  const { entry, level, scope } = input;
  const files = input.files.filter((file) => file.status !== 'deleted');
  const stale = files.some((file) => file.status !== 'fresh');
  const now = input.now ?? new Date().toISOString();
  const indexVersion = files.reduce((total, file) => total + file.revision, 0);
  const plannedAvailable = entry.configOrigin === 'planned';
  const diagnostics: ArchitectureResponse['diagnostics'] = [];
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];

  const moduleOf = new Map<string, string>();
  for (const file of files) moduleOf.set(file.filePath, fileModule(entry, file, input.preferences));
  const moduleFiles = new Map<string, SourceFile[]>();
  for (const file of files) {
    const moduleId = moduleOf.get(file.filePath)!;
    const list = moduleFiles.get(moduleId) ?? [];
    list.push(file);
    moduleFiles.set(moduleId, list);
  }
  const visibleModules = entry.config.modules.filter(
    (module) => !input.preferences?.hidden.includes(module.id),
  );

  const symbolsByUid = new Map<string, SymbolLocation>();
  for (const file of files) {
    for (const symbol of file.symbols) {
      symbolsByUid.set(symbol.symbolUid, {
        file,
        symbolUid: symbol.symbolUid,
        name: symbol.qualifiedName || symbol.name,
        kind: symbol.kind,
      });
    }
  }

  const addEdge = (
    source: string,
    target: string,
    kind: ArchitectureEdgeKind,
    evidence: ArchitectureEdge['evidence'],
    count = 1,
    label?: string,
  ) => {
    const existing = edges.find((edge) => edge.source === source && edge.target === target && edge.kind === kind);
    if (existing) {
      existing.count += count;
      for (const item of evidence) {
        if (existing.evidence.length < 6 && !existing.evidence.some((e) => e.filePath === item.filePath)) {
          existing.evidence.push(item);
        }
      }
      return;
    }
    edges.push({
      id: `${kind}:${source}->${target}`,
      source,
      target,
      kind,
      count,
      confidence: confidenceFor(kind),
      evidence: evidence.slice(0, 6),
      ...(label ? { label } : {}),
    });
  };

  /* ----------------------------- system level ----------------------------- */
  if (level === 'system') {
    const systems = entry.config.layers.map((layer) => {
      const systemModules = visibleModules.filter(
        (module) => (module.systemId ?? module.layer) === layer.id && !module.parentId,
      );
      const systemFiles = systemModules.flatMap((module) => moduleFiles.get(module.id) ?? []);
      const node: ArchitectureNode = {
        id: `sys:${layer.id}`,
        level: 'system',
        kind: 'system',
        label: layer.label,
        parentId: null,
        status: systemFiles.some((file) => file.status !== 'fresh') ? 'stale' : 'fresh',
        planned: plannedAvailable,
        observed: systemFiles.length > 0,
        confidence: plannedAvailable ? 'high' : 'medium',
        counts: countSymbols(systemFiles),
        evidence: [{ source: 'discovery', ref: layer.id, detail: `${systemModules.length} 个模块` }],
        meta: { moduleIds: systemModules.map((module) => module.id) },
      };
      nodes.push(node);
      for (const module of systemModules) {
        nodes.push(moduleNode(entry, module.id, moduleFiles.get(module.id) ?? [], node.id, 'module'));
      }
      return { layer, systemModules, systemFiles };
    });
    // module-level observed edges, aggregated from resolved file relations
    for (const file of files) {
      const sourceModule = moduleOf.get(file.filePath)!;
      for (const relation of file.relations) {
        if (relation.kind !== 'imports' && relation.kind !== 'calls') continue;
        const target = relation.targetUid ? symbolsByUid.get(relation.targetUid) : null;
        if (!target) continue;
        const targetModule = moduleOf.get(target.file.filePath)!;
        if (targetModule === sourceModule || targetModule === unplanned || sourceModule === unplanned) continue;
        addEdge(
          `mod:${sourceModule}`,
          `mod:${targetModule}`,
          relationKind(relation, file.status !== 'fresh' || target.file.status !== 'fresh'),
          [{ filePath: file.filePath, startLine: relation.evidence[0]?.startLine ?? null, detail: relation.kind }],
        );
      }
    }
    // system-level aggregation
    for (const edge of [...edges]) {
      const sourceSystem = systemOf(entry, edge.source.replace('mod:', ''));
      const targetSystem = systemOf(entry, edge.target.replace('mod:', ''));
      if (!sourceSystem || !targetSystem || sourceSystem === targetSystem) continue;
      addEdge(`sys:${sourceSystem}`, `sys:${targetSystem}`, edge.kind, edge.evidence, edge.count, '系统间');
    }
    if (plannedAvailable) {
      for (const module of visibleModules) {
        for (const dependency of module.plannedDependsOn) {
          addEdge(`mod:${module.id}`, `mod:${dependency}`, 'planned', [{ filePath: '.archsync/project.yaml' }]);
        }
      }
    }
    if (systems.every((system) => system.systemFiles.length === 0)) {
      diagnostics.push({
        severity: 'warning',
        code: 'no_source_in_systems',
        message: '没有模块匹配到源文件；请确认项目路径或检查扫描状态。',
      });
    }
  }

  /* ----------------------------- module level ----------------------------- */
  if (level === 'module') {
    const moduleId = scope.moduleId;
    if (!moduleId) {
      diagnostics.push({ severity: 'error', code: 'module_scope_missing', message: '模块级视图需要 moduleId。' });
    } else {
      const config = entry.config.modules.find((module) => module.id === moduleId);
      const childModules = visibleModules.filter((module) => module.parentId === moduleId);
      const ownFiles = (moduleFiles.get(moduleId) ?? []).filter(
        (file) => !childModules.some((child) => (moduleFiles.get(child.id) ?? []).includes(file)),
      );
      const parentNodeId = `mod:${moduleId}`;
      nodes.push(moduleNode(entry, moduleId, moduleFiles.get(moduleId) ?? [], config?.parentId ? `mod:${config.parentId}` : `sys:${config?.systemId ?? config?.layer ?? ''}`, 'module'));
      for (const child of childModules) {
        nodes.push(moduleNode(entry, child.id, moduleFiles.get(child.id) ?? [], parentNodeId, 'module'));
      }
      for (const file of ownFiles) {
        nodes.push({
          id: `file:${file.filePath}`,
          level: 'file',
          kind: 'file',
          label: file.filePath,
          parentId: parentNodeId,
          moduleId,
          filePath: file.filePath,
          language: file.language,
          status: fileStatus(file),
          planned: false,
          observed: true,
          confidence: 'high',
          counts: countSymbols([file]),
          evidence: [{ source: 'code-index', ref: `revision ${file.revision}` }],
        });
      }
      // file edges inside the module and to external modules/files
      for (const file of moduleFiles.get(moduleId) ?? []) {
        for (const relation of file.relations) {
          if (relation.kind !== 'imports' && relation.kind !== 'calls') continue;
          const target = relation.targetUid ? symbolsByUid.get(relation.targetUid) : null;
          if (!target) continue;
          const targetModule = moduleOf.get(target.file.filePath)!;
          if (targetModule === moduleId) {
            if (target.file.filePath === file.filePath) continue;
            addEdge(
              `file:${file.filePath}`,
              `file:${target.file.filePath}`,
              relationKind(relation, file.status !== 'fresh' || target.file.status !== 'fresh'),
              [{ filePath: file.filePath, startLine: relation.evidence[0]?.startLine ?? null, detail: relation.kind }],
            );
          } else {
            const targetNodeId = `mod:${targetModule}`;
            if (!nodes.some((node) => node.id === targetNodeId)) {
              nodes.push(moduleNode(entry, targetModule, moduleFiles.get(targetModule) ?? [], null, 'module'));
            }
            addEdge(
              `file:${file.filePath}`,
              targetNodeId,
              relationKind(relation, file.status !== 'fresh'),
              [{ filePath: file.filePath, startLine: relation.evidence[0]?.startLine ?? null, detail: '跨模块依赖' }],
            );
          }
        }
      }
      if (plannedAvailable) {
        for (const dependency of config?.plannedDependsOn ?? []) {
          addEdge(parentNodeId, `mod:${dependency}`, 'planned', [{ filePath: '.archsync/project.yaml' }]);
        }
      }
    }
  }

  /* ------------------------------ file level ------------------------------ */
  if (level === 'file') {
    const moduleId = scope.moduleId;
    const systemId = scope.systemId;
    const scopeFiles = files.filter((file) => {
      if (scope.filePath) return file.filePath === scope.filePath;
      if (moduleId) return moduleOf.get(file.filePath) === moduleId;
      if (systemId) return systemOf(entry, moduleOf.get(file.filePath) ?? null) === systemId;
      return true;
    });
    for (const file of scopeFiles) {
      nodes.push({
        id: `file:${file.filePath}`,
        level: 'file',
        kind: 'file',
        label: file.filePath,
        parentId: moduleId ? `mod:${moduleId}` : systemId ? `sys:${systemId}` : null,
        moduleId: moduleOf.get(file.filePath),
        filePath: file.filePath,
        language: file.language,
        status: fileStatus(file),
        planned: false,
        observed: true,
        confidence: 'high',
        counts: countSymbols([file]),
        evidence: [{ source: 'code-index', ref: `revision ${file.revision}` }],
      });
    }
    for (const file of scopeFiles) {
      for (const relation of file.relations) {
        if (relation.kind !== 'imports' && relation.kind !== 'calls') continue;
        const target = relation.targetUid ? symbolsByUid.get(relation.targetUid) : null;
        if (!target) continue;
        if (target.file.filePath === file.filePath) continue;
        if (!nodes.some((node) => node.id === `file:${target.file.filePath}`)) {
          nodes.push({
            id: `file:${target.file.filePath}`,
            level: 'file',
            kind: 'file',
            label: target.file.filePath,
            parentId: null,
            moduleId: moduleOf.get(target.file.filePath),
            filePath: target.file.filePath,
            language: target.file.language,
            status: fileStatus(target.file),
            planned: false,
            observed: true,
            confidence: 'high',
            counts: countSymbols([target.file]),
            evidence: [{ source: 'code-index', ref: '外部依赖目标' }],
            meta: { external: true },
          });
        }
        addEdge(
          `file:${file.filePath}`,
          `file:${target.file.filePath}`,
          relationKind(relation, file.status !== 'fresh' || target.file.status !== 'fresh'),
          [{ filePath: file.filePath, startLine: relation.evidence[0]?.startLine ?? null, detail: relation.kind }],
        );
      }
    }
  }

  /* ----------------------------- symbol level ----------------------------- */
  if (level === 'symbol') {
    const filePath = scope.filePath;
    const moduleId = scope.moduleId;
    const scopeFiles = files.filter((file) => {
      if (filePath) return file.filePath === filePath;
      if (moduleId) return moduleOf.get(file.filePath) === moduleId;
      return false;
    });
    const scopeUids = new Set<string>();
    const skippedUids = new Set<string>();
    for (const file of scopeFiles) {
      for (const symbol of file.symbols) {
        const kind = symbolKindOf(symbol.kind);
        if (kind === null) {
          skippedUids.add(symbol.symbolUid);
          continue;
        }
        scopeUids.add(symbol.symbolUid);
        nodes.push({
          id: `sym:${symbol.symbolUid}`,
          level: 'symbol',
          kind,
          label: symbol.qualifiedName || symbol.name,
          parentId: `file:${file.filePath}`,
          moduleId: moduleOf.get(file.filePath),
          filePath: file.filePath,
          symbolUid: symbol.symbolUid,
          language: file.language,
          status: fileStatus(file),
          planned: false,
          observed: true,
          confidence: 'high',
          counts: { files: 0, symbols: 1, functions: symbol.kind === 'function' ? 1 : 0, classes: symbol.kind === 'class' ? 1 : 0, interfaces: symbol.kind === 'interface' ? 1 : 0 },
          evidence: [{ source: 'code-index', ref: `${file.filePath}:${symbol.startLine}` }],
          meta: { signature: symbol.signature, startLine: symbol.startLine, endLine: symbol.endLine },
        });
      }
    }
    const ensureSymbolNode = (location: SymbolLocation) => {
      const kind = symbolKindOf(location.kind);
      if (kind === null) return;
      const nodeId = `sym:${location.symbolUid}`;
      if (nodes.some((node) => node.id === nodeId)) return;
      nodes.push({
        id: nodeId,
        level: 'symbol',
        kind,
        label: location.name,
        parentId: `file:${location.file.filePath}`,
        moduleId: moduleOf.get(location.file.filePath),
        filePath: location.file.filePath,
        symbolUid: location.symbolUid,
        language: location.file.language,
        status: fileStatus(location.file),
        planned: false,
        observed: true,
        confidence: 'high',
        counts: { files: 0, symbols: 1, functions: 0, classes: 0, interfaces: 0 },
        evidence: [{ source: 'code-index', ref: '外部调用目标' }],
        meta: { external: !scopeUids.has(location.symbolUid) },
      });
    };
    for (const file of scopeFiles) {
      for (const relation of file.relations) {
        if (!scopeUids.has(relation.sourceUid)) continue;
        if (skippedUids.has(relation.sourceUid)) continue;
        if (relation.kind === 'contains' || relation.kind === 'exports') continue;
        const source = symbolsByUid.get(relation.sourceUid);
        if (!source) continue;
        if (relation.targetUid) {
          const target = symbolsByUid.get(relation.targetUid);
          if (!target) continue;
          ensureSymbolNode(target);
          addEdge(
            `sym:${source.symbolUid}`,
            `sym:${target.symbolUid}`,
            relationKind(relation, file.status !== 'fresh' || target.file.status !== 'fresh'),
            [{ filePath: file.filePath, startLine: relation.evidence[0]?.startLine ?? null, detail: relation.kind }],
          );
        } else {
          // unresolved reference: keep it visible with its own node so the UI
          // can explain "dynamic call / external dependency" instead of hiding it.
          const key = relation.targetKey ?? relation.reason ?? 'unresolved';
          const nodeId = `unresolved:${key}`;
          if (!nodes.some((node) => node.id === nodeId)) {
            nodes.push({
              id: nodeId,
              level: 'symbol',
              kind: 'unknown',
              label: `未解析：${relation.reason === 'dynamic_call' ? '动态调用' : relation.reason === 'external_dependency' ? '外部依赖' : relation.reason ?? '未知引用'}`,
              parentId: null,
              moduleId: moduleOf.get(file.filePath),
              status: fileStatus(file),
              planned: false,
              observed: true,
              confidence: 'low',
              counts: { files: 0, symbols: 0, functions: 0, classes: 0, interfaces: 0 },
              evidence: [{ source: 'code-index', ref: relation.evidence[0]?.filePath ?? file.filePath, detail: relation.reason }],
              meta: { unresolved: true, reason: relation.reason ?? null },
            });
          }
          addEdge(
            `sym:${source.symbolUid}`,
            nodeId,
            'unresolved',
            [{ filePath: file.filePath, startLine: relation.evidence[0]?.startLine ?? null, detail: relation.reason ?? 'unresolved' }],
          );
        }
      }
    }
  }

  const resolvedEdges = edges.filter((edge) => edge.kind === 'resolved').length;
  const unresolvedEdges = edges.filter((edge) => edge.kind === 'unresolved').length;
  const plannedEdges = edges.filter((edge) => edge.kind === 'planned').length;

  if (nodes.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'empty_scope',
      message:
        level === 'symbol'
          ? '该范围内没有可显示的符号；请先选择一个文件或模块。'
          : '该范围内没有可显示的节点；代码索引可能尚未完成。',
    });
  } else if (level !== 'system' && edges.length === 0) {
    diagnostics.push({
      severity: 'info',
      code: 'no_relations',
      message: '没有已解析的跨文件关系；这通常意味着该范围内的调用是动态调用或指向外部依赖。',
    });
  }
  if (!plannedAvailable) {
    diagnostics.push({
      severity: 'info',
      code: 'planned_unavailable',
      message: '该仓库没有 .archsync/project.yaml；当前结构来自代码自动发现，不代表人工规划。',
    });
  }

  return {
    projectId: entry.id,
    level,
    scope: { systemId: scope.systemId ?? null, moduleId: scope.moduleId ?? null, filePath: scope.filePath ?? null },
    generatedAt: now,
    indexVersion,
    stale,
    plannedAvailable,
    nodes,
    edges,
    diagnostics,
    summary: {
      systems: nodes.filter((node) => node.kind === 'system').length,
      modules: nodes.filter((node) => node.kind === 'module').length,
      files: nodes.filter((node) => node.kind === 'file').length,
      symbols: nodes.filter((node) => node.level === 'symbol' && node.kind !== 'unknown').length,
      resolvedEdges,
      unresolvedEdges,
      plannedEdges,
    },
  };
}
