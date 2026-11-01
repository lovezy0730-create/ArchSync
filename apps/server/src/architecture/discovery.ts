import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { sourcePaths } from '@archsync/scanner/ast';
import type { ModuleConfidence, ProjectConfigFile } from '@archsync/contracts';

/**
 * Structure-first module discovery for repositories without `.archsync/project.yaml`.
 *
 * The goal is to stop treating top-level directories as the architecture. A
 * directory only becomes a module when there is code evidence for a boundary:
 *
 * - a workspace package (`package.json` with a name, e.g. `@qqagent/webui`)
 * - a Python package (`__init__.py`)
 * - a directory cluster with several source files and no package above it
 *
 * Top-level directories become **systems** (navigation groups), not modules.
 * Every file is assigned to exactly one leaf module, so the workbench never
 * falls back to "a list of folders". No business meaning is invented: labels
 * come from package names or relative paths, and every boundary keeps its
 * evidence and confidence.
 */

export interface DiscoveryPreferences {
  version: 1;
  /** Explicit file → module overrides (applied by the architecture projection). */
  moves: Record<string, string>;
  /** Module label overrides. */
  rename: Record<string, string>;
  /** Modules the user chose to hide from navigation. */
  hidden: string[];
}

export function emptyPreferences(): DiscoveryPreferences {
  return { version: 1, moves: {}, rename: {}, hidden: [] };
}

export interface DiscoveredModule {
  id: string;
  label: string;
  systemId: string;
  parentId: string | null;
  /** Directory relative to the project root (`''` for root). */
  dir: string;
  /** Glob list used by the scanner to assign files. */
  paths: string[];
  /** Files assigned to this module (relative posix paths). */
  files: string[];
  languageCounts: Record<string, number>;
  confidence: ModuleConfidence;
  evidence: string[];
  depth: number;
}

export interface DiscoveredSystem {
  id: string;
  label: string;
  dir: string;
  moduleIds: string[];
  files: string[];
  confidence: ModuleConfidence;
  evidence: string[];
}

export interface DiscoveryResult {
  systems: DiscoveredSystem[];
  modules: DiscoveredModule[];
  /** Files that could not be assigned (should stay empty in practice). */
  unassigned: string[];
  diagnostics: string[];
}

const SOURCE_PATTERN = /\.(tsx?|jsx?|mjs|cjs|py)$/;

const id = (prefix: string, key: string): string =>
  `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;

const posix = (value: string): string => value.replace(/\\/g, '/');
const parentDir = (dir: string): string => {
  const index = dir.lastIndexOf('/');
  return index === -1 ? '' : dir.slice(0, index);
};
const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
const isInside = (dir: string, candidate: string): boolean =>
  candidate === dir || candidate.startsWith(`${dir}/`);

function readPackageName(rootDir: string, dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, dir, 'package.json'), 'utf8')) as { name?: string };
    return typeof pkg.name === 'string' && pkg.name.trim().length > 0 ? pkg.name.trim() : null;
  } catch {
    return null;
  }
}

function languageOf(filePath: string): string {
  if (filePath.endsWith('.py')) return 'python';
  if (/\.(tsx?)$/.test(filePath)) return 'typescript';
  return 'javascript';
}

export function discoverArchitecture(
  rootDir: string,
  preferences: DiscoveryPreferences = emptyPreferences(),
): DiscoveryResult {
  const files = sourcePaths(rootDir, SOURCE_PATTERN).map((file) => posix(relative(rootDir, file)));
  const diagnostics: string[] = [];
  if (files.length === 0) {
    return { systems: [], modules: [], unassigned: [], diagnostics: ['未发现可解析的 TS/JS/Python 源文件'] };
  }

  // Ancestor directories of real source files: discovery never looks at
  // ignored trees (node_modules, build output, ...) because they contain no
  // source file that survived sourcePaths().
  const dirs = new Set<string>(['']);
  for (const file of files) {
    let dir = parentDir(file);
    while (dir !== '' && !dirs.has(dir)) {
      dirs.add(dir);
      dir = parentDir(dir);
    }
  }

  const packageDirs = new Map<string, string>(); // dir -> package name
  const pythonPackageDirs = new Set<string>();
  for (const dir of dirs) {
    if (dir === '') continue;
    if (existsSync(join(rootDir, dir, 'package.json'))) {
      const name = readPackageName(rootDir, dir);
      if (name) packageDirs.set(dir, name);
    }
    if (existsSync(join(rootDir, dir, '__init__.py'))) pythonPackageDirs.add(dir);
  }

  // Top-level systems: first path segment ('' = repository root files).
  const systemDirs = new Set<string>();
  for (const file of files) {
    const [first] = file.split('/');
    systemDirs.add(file.includes('/') ? first! : '');
  }

  const modules: DiscoveredModule[] = [];
  const systems: DiscoveredSystem[] = [];
  const assigned = new Map<string, string>(); // file -> module id

  const makeModule = (
    dir: string,
    systemId: string,
    parentId: string | null,
    label: string,
    confidence: ModuleConfidence,
    evidence: string[],
    paths: string[],
  ): DiscoveredModule => {
    const module: DiscoveredModule = {
      id: id('mod', dir === '' ? '.' : dir),
      label,
      systemId,
      parentId,
      dir,
      paths,
      files: [],
      languageCounts: {},
      confidence,
      evidence,
      depth: depthOf(dir),
    };
    const renamed = preferences.rename[module.id];
    if (renamed) module.label = renamed;
    return module;
  };

  for (const systemDir of [...systemDirs].sort()) {
    const systemFiles = files.filter((file) =>
      systemDir === '' ? !file.includes('/') : file === systemDir || file.startsWith(`${systemDir}/`),
    );
    if (systemFiles.length === 0) continue;
    const systemId = id('sys', systemDir === '' ? '.' : systemDir);
    const systemModules: DiscoveredModule[] = [];

    // 1) package boundaries inside this system, shallowest first. A top-level
    // directory that is itself a package becomes the system's root module.
    if (systemDir !== '' && packageDirs.has(systemDir)) {
      systemModules.push(
        makeModule(systemDir, systemId, null, packageDirs.get(systemDir)!, 'high',
          ['package.json name=' + packageDirs.get(systemDir)], [`${systemDir}/**`]),
      );
    }
    const packageRoots = [...packageDirs.keys()]
      .filter((dir) => systemDir === '' ? !dir.includes('/') : dir === systemDir || dir.startsWith(`${systemDir}/`))
      .filter((dir) => systemDir === '' ? dir !== '' : dir !== systemDir)
      .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));

    for (const dir of packageRoots) {
      const name = packageDirs.get(dir)!;
      const evidence = [`package.json name=${name}`];
      if (pythonPackageDirs.has(dir)) evidence.push('__init__.py');
      const nearestParent = packageRoots
        .filter((candidate) => candidate !== dir && isInside(candidate, dir))
        .sort((a, b) => depthOf(b) - depthOf(a))[0];
      const parentModule = nearestParent
        ? systemModules.find((module) => module.dir === nearestParent)
        : undefined;
      systemModules.push(
        makeModule(dir, systemId, parentModule?.id ?? null, name, 'high', evidence, [`${dir}/**`]),
      );
    }

    // 2) Python packages without a package.json
    for (const dir of [...pythonPackageDirs].sort()) {
      if (packageDirs.has(dir)) continue;
      if (systemDir === '' ? dir.includes('/') : !(dir === systemDir || dir.startsWith(`${systemDir}/`))) continue;
      if (dir === systemDir) continue;
      const nearestParent = [...pythonPackageDirs]
        .filter((candidate) => candidate !== dir && isInside(candidate, dir))
        .sort((a, b) => depthOf(b) - depthOf(a))[0];
      const parentModule = nearestParent
        ? systemModules.find((module) => module.dir === nearestParent)
        : undefined;
      systemModules.push(
        makeModule(dir, systemId, parentModule?.id ?? null, dir, 'high', ['__init__.py'], [`${dir}/**`]),
      );
    }

    // 3) directory clusters only where no package boundary exists above them
    if (systemModules.length === 0) {
      const directChildren = new Map<string, number>();
      for (const file of systemFiles) {
        const rest = systemDir === '' ? file : file.slice(systemDir.length + 1);
        if (!rest.includes('/')) continue;
        const child = systemDir === '' ? rest.split('/')[0]! : `${systemDir}/${rest.split('/')[0]!}`;
        directChildren.set(child, (directChildren.get(child) ?? 0) + 1);
      }
      const clusters = [...directChildren.entries()]
        .filter(([, count]) => count >= 2)
        .map(([dir]) => dir)
        .sort();
      for (const dir of clusters) {
        systemModules.push(
          makeModule(dir, systemId, null, dir, 'medium', [`目录包含至少 2 个源文件`], [`${dir}/**`]),
        );
      }
    }

    // 4) fallback module for files not covered by a discovered boundary
    const covered = (file: string): boolean =>
      systemModules.some((module) => isInside(module.dir, file) && file !== module.dir);
    const leftovers = systemFiles.filter((file) => !covered(file));
    if (leftovers.length > 0 || systemModules.length === 0) {
      const leftoverDirs = new Set<string>();
      let rootFiles = false;
      for (const file of leftovers) {
        const dir = parentDir(file);
        if (dir === systemDir || dir === '') rootFiles = true;
        else leftoverDirs.add(dir);
      }
      const paths: string[] = [];
      if (rootFiles) paths.push(systemDir === '' ? '*' : `${systemDir}/*`);
      for (const dir of [...leftoverDirs].sort()) paths.push(`${dir}/**`);
      if (paths.length === 0) paths.push(systemDir === '' ? '**' : `${systemDir}/**`);
      const label = systemDir === '' ? '根目录' : `${systemDir}（根文件）`;
      systemModules.push(
        makeModule(systemDir, systemId, null, label, systemModules.length === 0 ? 'low' : 'medium',
          [systemModules.length === 0 ? '没有可识别的包边界，保留目录分组' : '未归入子模块的文件'], paths),
      );
    }

    // Assign every file to the deepest module whose directory contains it.
    for (const file of systemFiles) {
      const candidates = systemModules
        .filter((module) => module.dir !== '' && isInside(module.dir, file))
        .sort((a, b) => b.depth - a.depth);
      const target = candidates[0] ?? systemModules.find((module) => module.dir === systemDir) ?? systemModules[0]!;
      target.files.push(file);
      assigned.set(file, target.id);
      const language = languageOf(file);
      target.languageCounts[language] = (target.languageCounts[language] ?? 0) + 1;
    }

    for (const module of systemModules) {
      module.files.sort();
      if (module.files.length === 0 && module.confidence !== 'low') {
        diagnostics.push(`模块 ${module.label} 没有匹配到源文件`);
      }
    }
    systemModules.sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));
    modules.push(...systemModules);
    const visible = systemModules.filter((module) => !preferences.hidden.includes(module.id));
    systems.push({
      id: systemId,
      label: systemDir === '' ? '根目录' : systemDir,
      dir: systemDir,
      moduleIds: visible.map((module) => module.id),
      files: systemFiles,
      confidence: systemModules.some((module) => module.confidence === 'high') ? 'high' : 'medium',
      evidence: [`顶层目录 ${systemDir === '' ? '.' : systemDir}`, `${systemFiles.length} 个源文件`],
    });
  }

  const unassigned = files.filter((file) => !assigned.has(file));
  for (const file of unassigned) diagnostics.push(`文件未分配模块: ${file}`);
  return { systems, modules, unassigned, diagnostics };
}

/**
 * Build the in-memory project config used for repositories without YAML.
 *
 * Layers are systems (navigation groups) and modules are the discovered
 * boundaries. Modules are ordered deepest-first so the scanner's first-match
 * assignment resolves nested modules correctly.
 */
export function inferredConfig(
  projectId: string,
  name: string,
  github: { owner: string; repo: string; defaultBranch: string },
  discovery: DiscoveryResult,
): ProjectConfigFile {
  const systemOrder = new Map(discovery.systems.map((system, index) => [system.id, index + 1]));
  const modules = [...discovery.modules].sort((a, b) => b.depth - a.depth || a.label.localeCompare(b.label));
  return {
    schemaVersion: 1,
    project: { id: projectId, name, github, root: '.' },
    layers: discovery.systems.map((system) => ({
      id: system.id,
      label: system.label,
      order: systemOrder.get(system.id) ?? 1,
    })),
    modules: modules.map((module) => ({
      id: module.id,
      label: module.label,
      layer: module.systemId,
      description:
        module.confidence === 'high'
          ? `自动发现：${module.evidence.join('、')}`
          : `自动发现：${module.evidence.join('、')}（置信度 ${module.confidence}）`,
      owners: [],
      paths: module.paths,
      issues: [],
      plannedDependsOn: [],
      acceptance: { requiredIssues: [], requiredChecks: [], manualApproval: false },
      parentId: module.parentId,
      systemId: module.systemId,
      confidence: module.confidence,
      discoveryEvidence: module.evidence,
    })),
  };
}
