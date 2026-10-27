/**
 * Graph engine: merges planning YAML, local scan results and collaboration
 * data into a single Snapshot. All state decisions are pure functions and
 * follow the truth matrix from docs/CONSTRUCTION_PLAN.md §5.1:
 *
 * - scan failed        → implementation = unknown (never "not_detected")
 * - scan ok, no files  → not_detected (absence of files, not of features)
 * - files, evidence incomplete → detected_unverified
 * - no acceptance rules configured → can never auto-verify
 * - workflow comes from issues/PRs only; local file changes are a separate
 *   overlay signal and never imply task progress
 * - observedDependsOn stays null (no AST analysis in MVP)
 */
import { sha256Hex } from './sha256.js';
import type {
  CollabData,
  ConfigError,
  DemoIssue,
  DemoPullRequest,
  Evidence,
  ImplementationState,
  ModuleScanResult,
  ModuleState,
  ProjectConfigFile,
  ProjectViewConfig,
  ScanResult,
  Snapshot,
  SnapshotEdge,
  ViewDiagnostic,
  WorkflowState,
} from '@archsync/contracts';
import { matchPaths } from '@archsync/scanner/pure';

export interface BuildSnapshotInput {
  config: ProjectConfigFile;
  configWarnings: ConfigError[];
  configBlobSha: string;
  scan: ScanResult;
  collab: CollabData;
  version: number;
  snapshotId: string;
  now: string;
  /** optional project-specific presentation views */
  views?: ProjectViewConfig[];
  defaultViewId?: string | null;
  /** structured non-fatal diagnostics while reading .archsync/views.yaml */
  viewDiagnostics?: ViewDiagnostic[];
}

/**
 * Backwards-compatible fallback: one deterministic column per configured layer.
 * Projects without views.yaml remain fully usable.
 */
export function deriveDefaultView(config: ProjectConfigFile): ProjectViewConfig {
  const layers = [...config.layers].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return {
    id: 'auto-layers',
    label: '技术分层',
    kind: 'layer',
    direction: 'LR',
    description: '按 project.yaml 的层级顺序自动生成的默认视图',
    groups: layers.map((layer, index) => ({
      id: layer.id,
      label: layer.label,
      order: index + 1,
      tone: 'blue',
      moduleIds: config.modules.filter((module) => module.layer === layer.id).map((module) => module.id),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Collab lookups                                                     */
/* ------------------------------------------------------------------ */

export function linkedIssues(collab: CollabData, moduleId: string, configIssues: number[]): DemoIssue[] {
  const numbers = new Set<number>([...configIssues, ...(collab.moduleIssues[moduleId] ?? [])]);
  return collab.issues.filter((i) => numbers.has(i.number));
}

export function touchingPullRequests(
  collab: CollabData,
  plannedPaths: string[],
): DemoPullRequest[] {
  if (plannedPaths.length === 0) return [];
  return collab.pullRequests.filter((pr) =>
    pr.changedFiles.some((f) => matchPaths(plannedPaths, [f]).length > 0),
  );
}

/* ------------------------------------------------------------------ */
/* State matrix                                                       */
/* ------------------------------------------------------------------ */

export function computeImplementation(
  scan: ScanResult,
  moduleScan: ModuleScanResult | undefined,
  configModule: { acceptance: { requiredIssues: number[]; requiredChecks: string[]; manualApproval: boolean } },
  issues: DemoIssue[],
  prs: DemoPullRequest[],
  manualApprovals: string[],
): { state: ImplementationState; reasons: string[] } {
  if (!scan.ok || moduleScan === undefined) {
    return { state: 'unknown', reasons: ['扫描未成功，不能判断实现状态'] };
  }
  const matched = moduleScan.matchedWorkspacePaths.length > 0
    ? moduleScan.matchedWorkspacePaths
    : moduleScan.matchedBaselinePaths;
  if (matched.length === 0) {
    return { state: 'not_detected', reasons: ['扫描完成，但规划路径下没有匹配文件'] };
  }

  const acc = configModule.acceptance;
  const hasAcceptanceRules =
    acc.requiredIssues.length > 0 || acc.requiredChecks.length > 0 || acc.manualApproval;
  if (!hasAcceptanceRules) {
    return { state: 'detected_unverified', reasons: ['未配置验收标准，不能自动判定 verified'] };
  }

  const reasons: string[] = [];
  if (acc.requiredIssues.length > 0) {
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    for (const n of acc.requiredIssues) {
      const issue = byNumber.get(n);
      if (!issue) {
        reasons.push(`必需 Issue #${n} 未找到于协作数据`);
      } else if (issue.state !== 'closed' || issue.completion !== 'completed') {
        reasons.push(`必需 Issue #${n} 尚未以 completed 关闭`);
      }
    }
  }
  if (acc.requiredChecks.length > 0) {
    const mergedWithGreenChecks = prs.some((pr) => pr.mergedAt !== null && pr.checks === 'success');
    if (!mergedWithGreenChecks) {
      reasons.push(`必需检查 [${acc.requiredChecks.join(', ')}] 缺少对应成功记录`);
    }
  }
  if (acc.manualApproval && manualApprovals.length === 0) {
    reasons.push('配置要求人工验收，但尚无维护者确认记录');
  }

  return reasons.length === 0
    ? { state: 'verified', reasons: [] }
    : { state: 'detected_unverified', reasons };
}

export function computeWorkflow(
  issues: DemoIssue[],
  prs: DemoPullRequest[],
  configAcceptance: { requiredIssues: number[]; manualApproval: boolean },
  manualApprovals: string[],
): { state: WorkflowState; warnings: string[] } {
  const warnings: string[] = [];
  const openIssues = issues.filter((i) => i.state === 'open');
  const openNonDraftPrs = prs.filter((p) => p.state === 'open' && !p.draft);
  const openDraftPrs = prs.filter((p) => p.state === 'open' && p.draft);
  const mergedPrs = prs.filter((p) => p.mergedAt !== null);
  const blockedIssues = issues.filter((i) =>
    i.labels.some((l) => l.toLowerCase() === 'blocked'),
  );

  // "PR merged ≠ accepted": a merged PR with unmet acceptance issues must
  // carry an explicit warning in every branch (T11).
  const required = configAcceptance.requiredIssues;
  const byNumberAll = new Map(issues.map((i) => [i.number, i]));
  if (mergedPrs.length > 0 && required.length > 0) {
    const unaccepted = required.filter((n) => {
      const i = byNumberAll.get(n);
      return i === undefined || i.state !== 'closed' || i.completion !== 'completed';
    });
    if (unaccepted.length > 0) {
      warnings.push(`PR 已合并但验收 Issue 未完成: #${unaccepted.join(', #')}`);
    }
  }

  // "done" requires the configured acceptance set — never a single merged PR.
  const doneEligible =
    issues.length > 0 || mergedPrs.length > 0 || manualApprovals.length > 0;
  let doneCheck = false;
  if (doneEligible && required.length > 0) {
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    doneCheck = required.every((n) => {
      const i = byNumber.get(n);
      return i !== undefined && i.state === 'closed' && i.completion === 'completed';
    });
    if (doneCheck && configAcceptance.manualApproval && manualApprovals.length === 0) {
      doneCheck = false;
      warnings.push('必需 Issue 已关闭，但人工验收未确认，不能判定 done');
    }
  }

  if (blockedIssues.length > 0) {
    return { state: 'blocked', warnings: [`Issue #${blockedIssues[0]!.number} 带有 blocked 标签`] };
  }
  if (openNonDraftPrs.length > 0) {
    return { state: 'in_review', warnings };
  }
  if (openIssues.length > 0 || openDraftPrs.length > 0) {
    return { state: 'in_progress', warnings };
  }
  if (doneCheck) {
    if (mergedPrs.length > 0 && required.length > 0) {
      // merged but acceptance issues not fully closed → must not be done
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      const unaccepted = required.filter((n) => {
        const i = byNumber.get(n);
        return i === undefined || i.state !== 'closed' || i.completion !== 'completed';
      });
      if (unaccepted.length === 0) return { state: 'done', warnings };
      warnings.push(`PR 已合并但验收 Issue 未完成: #${unaccepted.join(', #')}`);
      return { state: 'in_progress', warnings };
    }
    return { state: 'done', warnings };
  }
  if (doneEligible) {
    // activity exists (e.g. merged PR) but acceptance not satisfied
    if (mergedPrs.length > 0) {
      warnings.push('存在已合并 PR，但验收条件未全部满足');
    }
    return { state: 'in_progress', warnings };
  }
  return { state: 'not_started', warnings };
}

/* ------------------------------------------------------------------ */
/* Snapshot assembly                                                  */
/* ------------------------------------------------------------------ */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function snapshotContentHash(snapshot: Omit<Snapshot, 'id' | 'version' | 'generatedAt' | 'contentHash'>): string {
  // Volatile timestamps must not create meaningless version bumps (T17).
  const { githubFetchedAt: _ignored, ...stable } = snapshot;
  return sha256Hex(stableStringify(stable)).slice(0, 16);
}

export function buildSnapshot(input: BuildSnapshotInput): Snapshot {
  const { config, scan, collab, now } = input;
  const warnings: string[] = [...input.configWarnings.map((w) => `配置警告: ${w.message}`)];
  for (const diagnostic of input.viewDiagnostics ?? []) {
    const label = diagnostic.severity === 'error' ? '视图配置错误' : '视图配置警告';
    const location = [
      diagnostic.file,
      diagnostic.path,
      diagnostic.line ? `line ${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}` : null,
    ].filter(Boolean).join(':');
    warnings.push(`${label}: ${diagnostic.message}${location ? ` (${location})` : ''}`);
  }
  if (!scan.ok) warnings.push('本轮扫描未成功，实现状态标记为 unknown');
  for (const e of scan.errors) warnings.push(`扫描: ${e}`);
  if (collab.source === 'demo') {
    warnings.push('GitHub 协作数据来自演示数据 (demo fixture)，非真实仓库状态');
  }
  if (collab.source === 'unavailable') {
    warnings.push(collab.error ?? 'GitHub 协作数据不可用（未配置令牌且无演示数据）');
  }

  const scanByModule = new Map(scan.modules.map((m) => [m.moduleId, m]));
  const dependedOnBy = new Map<string, string[]>();
  for (const m of config.modules) {
    for (const dep of m.plannedDependsOn) {
      dependedOnBy.set(dep, [...(dependedOnBy.get(dep) ?? []), m.id]);
    }
  }

  const observedBySource = new Map<string, string[]>();
  for (const edge of scan.observedDependencies ?? []) {
    observedBySource.set(edge.source, [...(observedBySource.get(edge.source) ?? []), edge.target]);
  }

  const modules: ModuleState[] = config.modules.map((m) => {
    const moduleScan = scanByModule.get(m.id);
    const issues = linkedIssues(collab, m.id, m.issues);
    const prs = touchingPullRequests(collab, m.paths);
    const manualApprovals = collab.manualApprovals[m.id] ?? [];

    const impl = computeImplementation(
      scan,
      moduleScan,
      { acceptance: m.acceptance },
      issues,
      prs,
      manualApprovals,
    );
    const wf = computeWorkflow(issues, prs, m.acceptance, manualApprovals);

    const evidence: Evidence[] = [
      {
        source: 'yaml',
        ref: '.archsync/project.yaml',
        revision: input.configBlobSha.slice(0, 12),
        observedAt: now,
        demo: false,
        details: { plannedPaths: m.paths.length },
      },
    ];
    if (scan.ok && moduleScan) {
      evidence.push({
        source: 'git-tree',
        ref: `HEAD ${scan.baselineSha?.slice(0, 8) ?? 'unknown'}`,
        revision: scan.baselineSha ?? undefined,
        observedAt: scan.scannedAt,
        demo: false,
        details: {
          matchedBaseline: moduleScan.matchedBaselinePaths.length,
          matchedWorkspace: moduleScan.matchedWorkspacePaths.length,
        },
      });
      if (moduleScan.overlayChanges.length > 0) {
        evidence.push({
          source: 'local-watch',
          ref: '工作区未提交变更',
          observedAt: scan.scannedAt,
          demo: false,
          details: { changes: moduleScan.overlayChanges.length },
        });
      }
    }
    for (const issue of issues) {
      evidence.push({
        source: 'github-issue',
        ref: `#${issue.number} ${issue.title}`,
        observedAt: collab.fetchedAt,
        demo: collab.demo,
        details: { state: issue.state, completion: issue.completion },
      });
    }
    for (const pr of prs) {
      evidence.push({
        source: 'github-pr',
        ref: `PR #${pr.number} ${pr.title}`,
        observedAt: collab.fetchedAt,
        demo: collab.demo,
        details: {
          state: pr.state,
          draft: pr.draft,
          merged: pr.mergedAt !== null,
          checks: pr.checks,
        },
      });
    }
    for (const login of manualApprovals) {
      evidence.push({
        source: 'manual-acceptance',
        ref: `由 ${login} 确认`,
        observedAt: collab.fetchedAt,
        demo: collab.demo,
        details: {},
      });
    }

    const moduleWarnings = [...wf.warnings, ...impl.reasons.filter((r) => r.includes('未找到'))];
    if (moduleScan && moduleScan.overlappedWith.length > 0) {
      moduleWarnings.push(
        `路径与模块 ${moduleScan.overlappedWith.join(', ')} 存在交叠，同一文件被多个模块匹配`,
      );
    }
    if (moduleScan && moduleScan.overlayChanges.length > 0) {
      moduleWarnings.push(
        `本地有 ${moduleScan.overlayChanges.length} 个未提交变更（仅本机视图，非主线状态）`,
      );
    }

    return {
      id: m.id,
      label: m.label,
      layer: m.layer,
      description: m.description,
      plannedPaths: m.paths,
      plannedDependsOn: m.plannedDependsOn,
      dependedOnBy: [...(dependedOnBy.get(m.id) ?? [])].sort(),
      matchedBaselinePaths: moduleScan?.matchedBaselinePaths ?? [],
      matchedWorkspacePaths: moduleScan?.matchedWorkspacePaths ?? [],
      overlayChanges: moduleScan?.overlayChanges ?? [],
      observedDependsOn: scan.importAnalysisRan
        ? [...new Set(observedBySource.get(m.id) ?? [])].sort()
        : null,
      implementation: impl.state,
      workflow: wf.state,
      owners: m.owners,
      assignees: [...new Set(issues.flatMap((i) => i.assignees))].sort(),
      contributors: [...new Set(prs.map((p) => p.author))].sort(),
      issueNumbers: [...new Set(issues.map((i) => i.number))].sort((a, b) => a - b),
      pullRequestNumbers: [...new Set(prs.map((p) => p.number))].sort((a, b) => a - b),
      evidence,
      warnings: moduleWarnings,
    };
  });

  const plannedPairs = new Set<string>();
  for (const m of config.modules) {
    for (const dep of m.plannedDependsOn) {
      if (dep !== m.id) plannedPairs.add(`${m.id}->${dep}`);
    }
  }
  const observedPairs = new Set(
    (scan.observedDependencies ?? [])
      .filter((e) => e.source !== e.target)
      .map((e) => `${e.source}->${e.target}`),
  );

  const edges: SnapshotEdge[] = [
    ...[...plannedPairs].map((pair) => {
      const [source, target] = pair.split('->');
      return {
        id: pair,
        source: source!,
        target: target!,
        kind: observedPairs.has(pair) ? ('confirmed' as const) : ('planned' as const),
        demo: false,
      };
    }),
    ...[...observedPairs]
      .filter((pair) => plannedPairs.has(pair) === false)
      .map((pair) => {
        const [source, target] = pair.split('->');
        return { id: pair, source: source!, target: target!, kind: 'observed' as const, demo: false };
      }),
  ];

  const resolvedViews = input.views && input.views.length > 0
    ? input.views
    : [deriveDefaultView(config)];
  const defaultViewId =
    input.defaultViewId && resolvedViews.some((view) => view.id === input.defaultViewId)
      ? input.defaultViewId
      : resolvedViews[0]!.id;

  const base = {
    projectId: config.project.id,
    projectName: config.project.name,
    branch: scan.branch ?? '(unknown)',
    sourceCommitSha: scan.baselineSha ?? 'unknown',
    configBlobSha: input.configBlobSha,
    scope: 'local-workspace' as const,
    githubFetchedAt: collab.source === 'unavailable' ? null : collab.fetchedAt,
    githubSource: collab.source,
    githubDemo: collab.demo,
    freshness: (collab.error !== null ? 'stale' : 'fresh') as 'fresh' | 'stale',
    scanCompleteness: scan.ok
      ? scan.errors.length === 0
        ? ('complete' as const)
        : ('partial' as const)
      : ('unknown' as const),
    dependencyAnalysis: scan.importAnalysisRan ? ('partial' as const) : ('not_supported' as const),
    layers: config.layers,
    views: resolvedViews,
    defaultViewId,
    viewDiagnostics: input.viewDiagnostics ?? [],
    modules,
    edges,
    warnings,
  };

  return {
    id: input.snapshotId,
    version: input.version,
    generatedAt: now,
    contentHash: snapshotContentHash(base),
    ...base,
  };
}

export { diffSnapshots } from './diff.js';
export type { SnapshotDiff, ModuleDiffEntry, StateChangeEntry, EdgeDiffEntry } from './diff.js';

export { dependencyClosure, isEdgeOnPath } from './closure.js';
