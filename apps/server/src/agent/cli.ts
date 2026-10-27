/**
 * ArchSync Agent CLI — a stable, model-agnostic interface for Codex/GLM/DSH
 * and other agents to read architecture context and report progress.
 *
 * Usage (from the repo root):
 *   pnpm agent -- snapshot [--project <id>]
 *   pnpm agent -- module <moduleId> [--project <id>]
 *   pnpm agent -- impact <moduleId> [--project <id>]
 *   pnpm agent -- context [--project <id>] [--modules a,b]
 *   pnpm agent -- validate <project.yaml | -(stdin)>
 *   pnpm agent -- layout-context [--project <id>]
 *   pnpm agent -- layout-validate [views.yaml | -] [--project <id>]
 *   pnpm agent -- report --module <id> --status <workflow> --by <agentName> --note "..."
 *
 * Principles:
 * - Read-only against the repository: report writes go to a separate,
 *   clearly-labelled JSONL audit file (.archsync/agent-reports.jsonl) and
 *   never mutate snapshots or the planning YAML.
 * - Agent reports are claims, not facts: every report record is marked
 *   `authoritative: false` and callers must verify against real evidence.
 * - All output is structured JSON on stdout; logs go to stderr; exit code
 *   0 = success, 1 = failure (parseable by tooling).
 * - Works fully offline (local scan); GITHUB_TOKEN, when present in the
 *   environment of THIS process, upgrades collaboration data to live (server
 *   side only — the token never appears in any output).
 */
import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '@archsync/contracts';
import { buildSnapshot, dependencyClosure } from '@archsync/graph';
import { scanProject } from '@archsync/scanner';
import { parseProjectConfig, parseProjectViews } from '@archsync/config';
import { discoverProjects, type ProjectEntry } from '../projects.js';
import { loadCollab } from '../github.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

interface CliArgs {
  command: string;
  flags: Map<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): CliArgs {
  // pnpm passes a literal "--" before user args; strip it (npm convention)
  const cleaned = argv[0] === '--' ? argv.slice(1) : argv;
  const [command = '', ...rest] = cleaned;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, code = 'agent_error'): never {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`);
  process.exit(1);
}

async function buildOfflineSnapshot(entry: ProjectEntry): Promise<Snapshot> {
  const now = new Date().toISOString();
  const scan = await scanProject(entry.config, entry.rootDir, () => now);
  const token = process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.length > 0 ? process.env.GITHUB_TOKEN : null;
  const collab = await loadCollab(entry, token);
  return buildSnapshot({
    config: entry.config,
    configWarnings: entry.configWarnings,
    viewDiagnostics: entry.viewDiagnostics,
    views: entry.views,
    defaultViewId: entry.defaultViewId,
    configBlobSha: entry.configBlobSha,
    scan,
    collab,
    version: 0,
    snapshotId: 'agent-query',
    now,
  });
}

async function resolveProject(flag: string | undefined): Promise<ProjectEntry> {
  const { projects } = discoverProjects(repoRoot);
  if (projects.length === 0) fail('未发现任何 .archsync/project.yaml 项目', 'no_projects');
  if (flag) {
    const found = projects.find((p) => p.id === flag);
    if (!found) {
      fail(
        `项目 ${flag} 不存在。可用: ${projects.map((p) => p.id).join(', ')}`,
        'project_not_found',
      );
    }
    return found;
  }
  return projects[0]!;
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));

  if (command === 'validate') {
    const source = positional[0];
    const text =
      source === '-' || source === undefined
        ? await new Promise<string>((resolve) => {
            let data = '';
            process.stdin.on('data', (chunk) => (data += chunk));
            process.stdin.on('end', () => resolve(data));
          })
        : await readFile(source, 'utf8');
    const result = parseProjectConfig(text);
    out({
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      moduleCount: result.config?.modules.length ?? 0,
      layerCount: result.config?.layers.length ?? 0,
    });
    process.exit(result.ok ? 0 : 1);
  }

  if (command === 'layout-validate') {
    const entry = await resolveProject(flags.get('project'));
    const source = positional[0];
    const text =
      source === '-'
        ? await new Promise<string>((resolve) => {
            let data = '';
            process.stdin.on('data', (chunk) => (data += chunk));
            process.stdin.on('end', () => resolve(data));
          })
        : await readFile(source ?? join(entry.rootDir, '.archsync', 'views.yaml'), 'utf8');
    const result = parseProjectViews(text, entry.config.modules.map((module) => module.id));
    out({
      ok: result.ok,
      projectId: entry.id,
      errors: result.errors,
      warnings: result.warnings,
      viewCount: result.file?.views.length ?? 0,
      defaultView: result.file?.defaultView ?? null,
    });
    process.exit(result.ok ? 0 : 1);
  }

  if (command === 'layout-context') {
    const entry = await resolveProject(flags.get('project'));
    const snapshot = await buildOfflineSnapshot(entry);
    out({
      ok: true,
      format: 'archsync-layout-context/1',
      goal: '为当前项目建议一个简单、易读、适合该项目结构的模块视图。',
      instructions: {
        output: '.archsync/views.yaml',
        doNotOutputCoordinates: true,
        note: '只决定 kind、direction、groups、group.order、group.tone 和 group.moduleIds；像素坐标由 ArchSync 布局引擎计算。',
        validation: '提交前运行 pnpm agent -- layout-validate .archsync/views.yaml --project <id>',
        constraints: [
          '每个 view 中每个模块最多出现一次，未分组模块会自动进入“其他模块”并产生警告',
          'group.order 在同一个 view 内必须唯一',
          '根据项目语义选择 system / flow / layer，不要为了填满画布创造不存在的系统',
          '优先把强依赖模块放在相邻分组，减少跨组连线',
        ],
      },
      project: { id: snapshot.projectId, name: snapshot.projectName },
      modules: snapshot.modules.map((module) => ({
        id: module.id,
        label: module.label,
        layer: module.layer,
        description: module.description,
        workflow: module.workflow,
        implementation: module.implementation,
        plannedDependsOn: module.plannedDependsOn,
        dependedOnBy: module.dependedOnBy,
        fileCount: module.matchedWorkspacePaths.length,
      })),
      edges: snapshot.edges.map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind })),
      currentViews: snapshot.views ?? [],
      defaultViewId: snapshot.defaultViewId ?? null,
      viewDiagnostics: snapshot.viewDiagnostics ?? [],
    });
    return;
  }

  if (command === 'report') {
    const moduleId = flags.get('module');
    const status = flags.get('status');
    const by = flags.get('by') ?? 'unknown-agent';
    const note = flags.get('note') ?? '';
    if (!moduleId || !status) {
      fail('用法: report --module <id> --status <workflow> [--by <agent>] [--note <text>]');
    }
    const validStatus = ['not_started', 'in_progress', 'in_review', 'blocked', 'done'];
    if (!validStatus.includes(status)) {
      fail(`status 必须是 ${validStatus.join('|')} 之一`, 'invalid_status');
    }
    const record = {
      recordedAt: new Date().toISOString(),
      projectId: flags.get('project') ?? null,
      moduleId,
      claimedWorkflow: status,
      author: by,
      note,
      /**
       * Agent claims are NOT project facts. A claimed status must be verified
       * against GitHub evidence (issues/PRs/code) before being trusted; this
       * file is an audit trail, never an input to snapshot state.
       */
      authoritative: false,
    };
    const file = join(repoRoot, '.archsync', 'agent-reports.jsonl');
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    out({ ok: true, appendedTo: '.archsync/agent-reports.jsonl', record });
    return;
  }

  if (command === 'snapshot') {
    const entry = await resolveProject(flags.get('project'));
    const snapshot = await buildOfflineSnapshot(entry);
    const edgeKinds = { planned: 0, confirmed: 0, observed: 0 };
    for (const e of snapshot.edges) edgeKinds[e.kind as keyof typeof edgeKinds] += 1;
    out({
      ok: true,
      project: { id: snapshot.projectId, name: snapshot.projectName },
      scannedAt: snapshot.generatedAt,
      branch: snapshot.branch,
      sourceCommitSha: snapshot.sourceCommitSha,
      scanCompleteness: snapshot.scanCompleteness,
      dependencyAnalysis: snapshot.dependencyAnalysis,
      githubSource: snapshot.githubSource,
      githubDemo: snapshot.githubDemo,
      viewCount: snapshot.views?.length ?? 1,
      defaultViewId: snapshot.defaultViewId ?? null,
      viewDiagnostics: snapshot.viewDiagnostics ?? [],
      moduleStats: {
        total: snapshot.modules.length,
        implementation: tally(snapshot.modules.map((m) => m.implementation)),
        workflow: tally(snapshot.modules.map((m) => m.workflow)),
      },
      edgeStats: edgeKinds,
      warnings: snapshot.warnings,
    });
    return;
  }

  if (command === 'module') {
    const moduleId = positional[0] ?? flags.get('module');
    if (!moduleId) fail('用法: module <moduleId> [--project <id>]');
    const entry = await resolveProject(flags.get('project'));
    const snapshot = await buildOfflineSnapshot(entry);
    const module = snapshot.modules.find((m) => m.id === moduleId);
    if (!module) {
      fail(
        `模块 ${moduleId} 不存在。可用: ${snapshot.modules.map((m) => m.id).join(', ')}`,
        'module_not_found',
      );
    }
    out({
      ok: true,
      module: {
        id: module.id,
        label: module.label,
        layer: module.layer,
        description: module.description,
        plannedPaths: module.plannedPaths,
        matchedWorkspacePaths: module.matchedWorkspacePaths,
        matchedBaselinePaths: module.matchedBaselinePaths,
        plannedDependsOn: module.plannedDependsOn,
        observedDependsOn: module.observedDependsOn,
        dependedOnBy: module.dependedOnBy,
        implementation: module.implementation,
        workflow: module.workflow,
        owners: module.owners,
        assignees: module.assignees,
        contributors: module.contributors,
        issueNumbers: module.issueNumbers,
        pullRequestNumbers: module.pullRequestNumbers,
        warnings: module.warnings,
      },
      evidence: module.evidence,
    });
    return;
  }

  if (command === 'impact') {
    const moduleId = positional[0] ?? flags.get('module');
    if (!moduleId) fail('用法: impact <moduleId> [--project <id>]');
    const entry = await resolveProject(flags.get('project'));
    const snapshot = await buildOfflineSnapshot(entry);
    if (!snapshot.modules.some((m) => m.id === moduleId)) {
      fail(`模块 ${moduleId} 不存在`, 'module_not_found');
    }
    const { upstream, downstream } = dependencyClosure(snapshot.modules, moduleId);
    out({
      ok: true,
      module: moduleId,
      rationale:
        '影响分析基于规划依赖闭包（YAML plannedDependsOn）。observed 依赖（真实 import）见 module 查询。修改该模块时，下游模块（dependedOnBy 闭包）需要回归。',
      upstream: [...upstream].sort(),
      downstream: [...downstream].sort(),
      upstreamCount: upstream.size,
      downstreamCount: downstream.size,
    });
    return;
  }

  if (command === 'context') {
    const entry = await resolveProject(flags.get('project'));
    const snapshot = await buildOfflineSnapshot(entry);
    const only = flags.get('modules')?.split(',').map((s) => s.trim()).filter(Boolean);
    const modules = only ? snapshot.modules.filter((m) => only.includes(m.id)) : snapshot.modules;
    out({
      ok: true,
      format: 'archsync-agent-context/1',
      hint: '供 LLM/Agent 消费的紧凑架构上下文。implementation/workflow 状态由真实扫描与 GitHub 证据计算；agent-reports.jsonl 中的申报不参与计算。',
      project: { id: snapshot.projectId, name: snapshot.projectName, commit: snapshot.sourceCommitSha.slice(0, 10) },
      layers: snapshot.layers,
      views: snapshot.views ?? [],
      defaultViewId: snapshot.defaultViewId ?? null,
      viewDiagnostics: snapshot.viewDiagnostics ?? [],
      modules: modules.map((m) => ({
        id: m.id,
        label: m.label,
        layer: m.layer,
        desc: m.description,
        impl: m.implementation,
        workflow: m.workflow,
        paths: m.plannedPaths,
        files: m.matchedWorkspacePaths.length,
        depsPlanned: m.plannedDependsOn,
        depsObserved: m.observedDependsOn ?? undefined,
        issues: m.issueNumbers,
        prs: m.pullRequestNumbers,
        owners: m.owners,
      })),
      edges: snapshot.edges.map((e) => ({ s: e.source, t: e.target, k: e.kind })),
    });
    return;
  }

  fail(
    `未知命令 "${command}"。可用: snapshot | module | impact | context | validate | layout-context | layout-validate | report`,
    'unknown_command',
  );
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

main().catch((err) => fail((err as Error).message));
