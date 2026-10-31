import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { sourcePaths } from '@archsync/scanner/ast';
import type { ProjectConfigFile, ConfigError, ProjectViewConfig, ViewDiagnostic } from '@archsync/contracts';
import { parseProjectConfig, parseProjectViews } from '@archsync/config';

export interface ProjectEntry {
  configOrigin?: 'planned' | 'inferred';
  id: string;
  name: string;
  rootDir: string;
  configText: string;
  configBlobSha: string;
  config: ProjectConfigFile;
  configWarnings: ConfigError[];
  views: ProjectViewConfig[];
  defaultViewId: string;
  viewDiagnostics: ViewDiagnostic[];
  /** path of collab.demo.json when the project ships demo collaboration data */
  demoCollabPath: string | null;
  demoCollabFetchedAt: string | null;
}

/** In-memory discovery only. Inferred groups are never written to the repo. */
export function inferProjectEntry(rootDir: string, id: string, name: string, github: { owner: string; repo: string; defaultBranch: string }): ProjectEntry {
  const paths = sourcePaths(rootDir, /\.(tsx?|jsx?|mjs|cjs|py)$/);
  const groups = new Set(paths.map((path) => {
    const parts = relative(rootDir, path).replace(/\\/g, '/').split('/');
    if (parts.length === 1) return '.';
    return (parts[0] === 'packages' || parts[0] === 'apps') && parts.length > 2
      ? parts.slice(0, 2).join('/') : parts[0]!;
  }));
  if (!groups.size) groups.add('.');
  const modules = [...groups].sort().map((dir) => ({
    id: `module-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}`,
    label: `${dir}（推断）`, layer: 'observed', description: '基于源码路径自动推断',
    owners: [], paths: [dir === '.' ? '*' : `${dir}/**`], issues: [], plannedDependsOn: [],
    acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false },
  }));
  const config: ProjectConfigFile = {
    schemaVersion: 1, project: { id, name, github, root: '.' },
    layers: [{ id: 'observed', label: '自动发现（推断）', order: 1 }], modules,
  };
  const configText = JSON.stringify(config);
  return { id, name, rootDir, config, configOrigin: 'inferred', configText,
    configBlobSha: createHash('sha256').update(configText).digest('hex'),
    configWarnings: [], views: [], defaultViewId: '', viewDiagnostics: [],
    demoCollabPath: null, demoCollabFetchedAt: null };
}

export function loadProjectEntry(configPath: string): ProjectEntry | { error: string } {
  if (!existsSync(configPath)) return { error: `${configPath}: 不存在` };
  const configText = readFileSync(configPath, 'utf8');
  const parsed = parseProjectConfig(configText);
  if (!parsed.ok || !parsed.config) {
    const first = parsed.errors[0];
    return {
      error: `${configPath}: 配置无效 [${first?.code ?? 'unknown'}] ${first?.message ?? ''}`,
    };
  }
  // project root is the parent of .archsync/ (where project.yaml lives)
  const rootDir = dirnameOf(dirnameOf(configPath));
  const viewsPath = join(rootDir, '.archsync', 'views.yaml');
  const viewsText = existsSync(viewsPath) ? readFileSync(viewsPath, 'utf8') : '';
  const parsedViews = viewsText
    ? parseProjectViews(viewsText, parsed.config.modules.map((module) => module.id))
    : { ok: true, errors: [], warnings: [] as ConfigError[], file: undefined };
  const viewDiagnostics: ViewDiagnostic[] = [
    ...(parsedViews.ok ? [] : parsedViews.errors).map((error) => ({
      ...error,
      severity: 'error' as const,
      file: '.archsync/views.yaml',
    })),
    ...parsedViews.warnings.map((warning) => ({
      ...warning,
      severity: 'warning' as const,
      file: '.archsync/views.yaml',
    })),
  ];
  const demoCollabPath = join(rootDir, '.archsync', 'collab.demo.json');
  const hasDemo = existsSync(demoCollabPath);
  return {
    id: parsed.config.project.id,
    name: parsed.config.project.name,
    rootDir,
    configText,
    configBlobSha: createHash('sha256').update(configText).update('\n').update(viewsText).digest('hex'),
    config: parsed.config,
    configWarnings: parsed.warnings,
    views: parsedViews.ok ? parsedViews.file?.views ?? [] : [],
    defaultViewId: parsedViews.ok ? parsedViews.file?.defaultView ?? '' : '',
    viewDiagnostics,
    demoCollabPath: hasDemo ? demoCollabPath : null,
    demoCollabFetchedAt: hasDemo ? statSync(demoCollabPath).mtime.toISOString() : null,
  };
}

function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? '.' : path.slice(0, idx);
}

/**
 * Discover projects: the repository itself (workspace root .archsync/) plus
 * every example project under examples. Invalid configs are skipped with a
 * logged reason, never guessed into a snapshot.
 */
export function discoverProjects(workspaceRoot: string): {
  projects: ProjectEntry[];
  skipped: string[];
} {
  const projects: ProjectEntry[] = [];
  const skipped: string[] = [];
  const candidates = [join(workspaceRoot, '.archsync', 'project.yaml')];
  const examplesDir = join(workspaceRoot, 'examples');
  if (existsSync(examplesDir)) {
    for (const name of readdirSync(examplesDir, { withFileTypes: true })) {
      if (name.isDirectory()) candidates.push(join(examplesDir, name.name, '.archsync', 'project.yaml'));
    }
  }
  for (const path of candidates) {
    const entry = loadProjectEntry(path);
    if ('error' in entry) {
      skipped.push(entry.error);
      continue;
    }
    if (projects.some((p) => p.id === entry.id)) {
      skipped.push(`${path}: 项目 ID 重复 ${entry.id}`);
      continue;
    }
    projects.push(entry);
  }
  return { projects, skipped };
}
