import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectConfigFile, ConfigError } from '@archsync/contracts';
import { parseProjectConfig } from '@archsync/config';

export interface ProjectEntry {
  id: string;
  name: string;
  rootDir: string;
  configText: string;
  configBlobSha: string;
  config: ProjectConfigFile;
  configWarnings: ConfigError[];
  /** path of collab.demo.json when the project ships demo collaboration data */
  demoCollabPath: string | null;
  demoCollabFetchedAt: string | null;
}

function loadEntry(configPath: string): ProjectEntry | { error: string } {
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
  const demoCollabPath = join(rootDir, '.archsync', 'collab.demo.json');
  const hasDemo = existsSync(demoCollabPath);
  return {
    id: parsed.config.project.id,
    name: parsed.config.project.name,
    rootDir,
    configText,
    configBlobSha: createHash('sha256').update(configText).digest('hex'),
    config: parsed.config,
    configWarnings: parsed.warnings,
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
    const entry = loadEntry(path);
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
