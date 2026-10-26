/**
 * `archsync init` wizard — bootstrap a project.yaml for a public GitHub repo.
 *
 *   pnpm archsync:init -- <owner/repo> [--ref HEAD] [--out <dir>]
 *
 * Pipeline (all anonymous, no token, single tarball request):
 *   1. download the repo tarball (codeload, not rate-limited like the API)
 *   2. cluster TS/JS files by directory (src/x, packages/x, apps/x …)
 *   3. run the real import analyzer on file contents → module dependency edges
 *   4. emit a draft project.yaml + a suggestions report (confidence, coverage,
 *      unclassified files, observed edges)
 *
 * Honesty rules:
 * - layer assignment is a labelled heuristic (name patterns), never a claim;
 * - directories we cannot confidently bound become candidates with LOW
 *   confidence and the file list, for the user to accept/fix;
 * - `plannedDependsOn` is prefilled from OBSERVED import edges only, so the
 *   plan starts grounded in real code rather than fiction.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeImports, isAnalyzable, moduleDependencyEdges } from '@archsync/scanner';
import { fetchTarballEntries } from './tarball.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.github', 'coverage',
  'docs', 'test', 'tests', '__tests__', 'examples', 'scripts', '.vscode', 'public', 'assets',
]);

const LAYER_RULES: Array<{ layer: string; label: string; order: number; patterns: RegExp[] }> = [
  { layer: 'web', label: '前端', order: 1, patterns: [/^(web|ui|frontend|client|browser|app)s?$/i, /-ui$/, /^apps?$/i] },
  { layer: 'server', label: '服务', order: 2, patterns: [/^(server|api|backend|service)s?$/i, /-service$/, /-api$/] },
  { layer: 'core', label: '核心', order: 3, patterns: [/^(core|lib|shared|packages?|pkg)$/i, /^packages?$/i] },
];

export interface ModuleSuggestion {
  id: string;
  dir: string;
  fileCount: number;
  sampleFiles: string[];
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  layer: string;
  observedDeps: string[];
}

export interface InitSuggestion {
  owner: string;
  repo: string;
  ref: string;
  totalFiles: number;
  analyzableFiles: number;
  modules: ModuleSuggestion[];
  unclassifiedFiles: string[];
  externalHighlights: string[];
  warnings: string[];
}

function slugId(dir: string): string {
  const cleaned = dir
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (/^[a-z]/.test(cleaned) && cleaned.length >= 2 && cleaned.length <= 64) return cleaned;
  return `mod-${cleaned || 'root'}`;
}

function layerFor(dir: string, fileCount: number, hasHtml: boolean): { layer: string; reason: string } {
  const base = dir.split('/')[0] ?? '';
  for (const rule of LAYER_RULES) {
    if (rule.patterns.some((p) => p.test(base) || p.test(dir))) {
      return { layer: rule.layer, reason: `目录名匹配 ${rule.layer} 启发式` };
    }
  }
  if (hasHtml && fileCount > 0) return { layer: 'web', reason: '包含 HTML/组件入口，推测为前端' };
  return { layer: 'core', reason: '未匹配已知模式，默认归入核心（请人工确认）' };
}

export function suggestModules(files: Array<{ path: string; content: string }>): InitSuggestion {
  const analyzable = files.filter((f) => isAnalyzable(f.path) && !isIgnoredPath(f.path));
  const byDir = new Map<string, Array<{ path: string; content: string }>>();
  for (const file of analyzable) {
    const segments = file.path.split('/');
    // candidate dir: first meaningful segment (skip top-level src/ prefix)
    const startIdx = segments[0] === 'src' && segments.length > 2 ? 1 : 0;
    const dir = segments.slice(0, startIdx + 1).join('/') || '(root)';
    byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }

  const dirs = [...byDir.entries()]
    .filter(([dir, fs]) => fs.length >= 3 && dir !== '(root)')
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 18);

  const analysis = analyzeImports(
    analyzable.map((f) => ({ path: f.path, content: f.content })),
  );
  const dirOf = new Map<string, string>();
  for (const file of analyzable) {
    const segments = file.path.split('/');
    const startIdx = segments[0] === 'src' && segments.length > 2 ? 1 : 0;
    dirOf.set(file.path, segments.slice(0, startIdx + 1).join('/') || '(root)');
  }
  const observed = moduleDependencyEdges(analysis, (p) => dirOf.get(p) ?? null);

  const idByDir = new Map<string, string>();
  for (const [dir] of dirs) idByDir.set(dir, slugId(dir));
  // dedupe ids
  const usedIds = new Set<string>();
  for (const [dir, id] of idByDir) {
    let unique = id;
    let n = 2;
    while (usedIds.has(unique)) unique = `${id}-${n++}`;
    usedIds.add(unique);
    idByDir.set(dir, unique);
  }

  const covered = new Set<string>();
  for (const [, fs] of dirs) for (const f of fs) covered.add(f.path);

  const modules: ModuleSuggestion[] = dirs.map(([dir, fs]) => {
    const hasHtml = fs.some((f) => f.path.endsWith('.tsx') || f.path.endsWith('.jsx'));
    const layerInfo = layerFor(dir, fs.length, hasHtml);
    const id = idByDir.get(dir)!;
    // observed edges use directory names; map targets to suggested module ids
    // and drop targets that are not suggested modules (honest: uncovered dirs
    // are not modules)
    const dirObserved = observed
      .filter((e) => e.source === dir)
      .map((e) => idByDir.get(e.target))
      .filter((targetId): targetId is string => targetId !== undefined);
    const reasons: string[] = [`${fs.length} 个 TS/JS 文件`, layerInfo.reason];
    let confidence: ModuleSuggestion['confidence'] = 'medium';
    if (fs.length >= 5 && dirObserved.length >= 1) {
      confidence = 'high';
      reasons.push(`存在 ${dirObserved.length} 条内部 import 依赖`);
    } else if (fs.length < 4) {
      confidence = 'low';
      reasons.push('文件较少，边界可能不准确');
    }
    return {
      id,
      dir,
      fileCount: fs.length,
      sampleFiles: fs.slice(0, 3).map((f) => f.path),
      confidence,
      reasons,
      layer: layerInfo.layer,
      observedDeps: [...new Set(dirObserved)],
    };
  });

  const unclassified = analyzable.filter((f) => !covered.has(f.path)).map((f) => f.path);
  const externalHighlights = [...new Set([...analysis.external.values()].flatMap((s) => [...s]))]
    .filter((spec) => !spec.startsWith('.'))
    .filter((spec) => !spec.startsWith('node:'))
    .slice(0, 15);

  const warnings: string[] = [];
  if (unclassified.length > analyzable.length * 0.3) {
    warnings.push(
      `${unclassified.length}/${analyzable.length} 文件未归入任何建议模块 —— 请在生成的 YAML 中补充模块或调整目录`,
    );
  }
  warnings.push('层（layer）分配来自目录名启发式，必须人工确认。依赖为真实 import 观察结果。');

  return {
    owner: '',
    repo: '',
    ref: 'HEAD',
    totalFiles: files.length,
    analyzableFiles: analyzable.length,
    modules,
    unclassifiedFiles: unclassified.slice(0, 40),
    externalHighlights,
    warnings,
  };
}

function isIgnoredPath(path: string): boolean {
  return path.split('/').some((seg) => IGNORED_DIRS.has(seg));
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

export function renderProjectYaml(owner: string, repo: string, suggestion: InitSuggestion): string {
  const layerIds = [...new Set(suggestion.modules.map((m) => m.layer))];
  const orderOf = (layer: string): number => LAYER_RULES.find((r) => r.layer === layer)?.order ?? 4;
  const layers = layerIds
    .map((id) => {
      const label = LAYER_RULES.find((r) => r.layer === id)?.label ?? '其他';
      return `  - id: ${id}\n    label: ${yamlQuote(label)}\n    order: ${orderOf(id)}`;
    })
    .join('\n');

  const modules = suggestion.modules
    .map((m) => {
      const deps = m.observedDeps.length > 0 ? `\n    plannedDependsOn: [${m.observedDeps.join(', ')}]` : '\n    plannedDependsOn: []';
      return `  - id: ${m.id}
    label: ${yamlQuote(m.dir)}
    layer: ${m.layer}
    description: ${yamlQuote(`${m.fileCount} 个文件（${m.confidence} 置信度建议，${m.reasons[0]}）`)}
    owners: []
    paths: [${yamlQuote(`${m.dir}/**`)}]
    issues: []${deps}
    acceptance:
      requiredIssues: []
      requiredChecks: []
      manualApproval: false`;
    })
    .join('\n');

  return `schemaVersion: 1
project:
  id: ${slugId(repo)}
  name: ${yamlQuote(`${owner}/${repo}`)}
  github:
    owner: ${owner}
    repo: ${repo}
    defaultBranch: main
  root: "."

layers:
${layers}

modules:
${modules}
`;
}

async function main(): Promise<void> {
  const argv = process.argv.filter((a) => a !== '--');
  const target = argv[2];
  if (!target || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) {
    console.error('用法: pnpm archsync:init -- <owner/repo> [--ref HEAD] [--out <dir>]');
    process.exit(1);
  }
  const [owner, repo] = target.split('/');
  const refIdx = argv.indexOf('--ref');
  const ref = refIdx >= 0 ? argv[refIdx + 1] : 'HEAD';
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : null;

  console.error(`[init] 下载 ${owner}/${repo}@${ref} tarball（匿名单请求）…`);
  const entries = await fetchTarballEntries(owner!, repo!, ref);
  console.error(`[init] 解压 ${entries.length} 个文本文件`);
  const suggestion = suggestModules(entries);
  suggestion.owner = owner!;
  suggestion.repo = repo!;

  const yamlText = renderProjectYaml(owner!, repo!, suggestion);
  if (outDir) {
    const dir = join(repoRoot, outDir, '.archsync');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'project.yaml'), yamlText, 'utf8');
    console.error(`[init] 已写入 ${outDir}/.archsync/project.yaml`);
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, suggestion, yaml: outDir ? undefined : yamlText }, null, 2)}\n`,
  );
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('init-wizard.ts')) {
  main().catch((err) => {
    console.error('[init] 失败:', (err as Error).message);
    process.exit(1);
  });
}
