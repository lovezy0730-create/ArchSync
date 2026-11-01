#!/usr/bin/env node
/**
 * Read-only architecture acceptance against a REAL local repository.
 *
 * Usage:
 *   node scripts/rc5-architecture-acceptance.mjs --repo <path> [--out <dir>]
 *
 * It launches the packaged Windows app with an isolated data directory,
 * registers the repository through the normal GUI flow, and verifies:
 *   system → module → file → symbol graphs, the planned view, and source
 *   evidence. The repository is only read; registry/state/screenshots go to a
 *   temporary data directory and the output directory.
 *
 * CI cannot see a user's local QQAgent checkout, so CI uses the fixed
 * structural fixture in rc5-desktop-e2e.mjs instead. This script is the local
 * acceptance path and never claims to be CI evidence.
 */
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

const repo = resolve(arg('repo', ''));
if (!arg('repo')) {
  console.error('usage: node scripts/rc5-architecture-acceptance.mjs --repo <path> [--out <dir>]');
  process.exit(2);
}
const outDir = resolve(arg('out', join('apps', 'desktop', 'release', 'evidence')));
const executablePath = process.env.ARCHSYNC_E2E_EXE ?? resolve('apps/desktop/release/win-unpacked/ArchSync.exe');
const temp = await mkdtemp(join(tmpdir(), 'archsync-acceptance-'));
const data = join(temp, 'user-data');
await mkdir(outDir, { recursive: true });
let application;
const report = { repo, commit: null, startedAt: new Date().toISOString(), checks: [], screenshots: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) report.failed = true;
};

try {
  const env = { ...process.env, ARCHSYNC_DESKTOP_DATA_DIR: data, ARCHSYNC_CLOSE_TO_TRAY: '0', PORT: '0', AUTH_CODE: '', DEV_AUTH_MODE: 'mock', GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath, env, timeout: 90000 });
  const page = await application.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/', { timeout: 90000 });

  await page.getByRole('button', { name: '打开或克隆仓库' }).click();
  await page.getByRole('dialog', { name: '添加项目' }).locator('input').first().fill(repo);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('dialog', { name: '添加项目' }).waitFor({ state: 'hidden', timeout: 120000 });
  const projectId = await page.waitForFunction(async (path) => {
    const list = await (await fetch('/api/v1/registry')).json();
    return list.projects.find((project) => project.localPath === path)?.id ?? false;
  }, repo, { timeout: 120000, polling: 500 }).then((handle) => handle.jsonValue());
  check('repository registered without YAML', Boolean(projectId), projectId);

  await page.waitForFunction(async (id) => {
    const status = await (await fetch(`/api/v1/projects/${id}/code-index/status`)).json();
    return status.state === 'ready' && status.files > 0;
  }, projectId, { timeout: 300000, polling: 500 });
  const status = await page.evaluate(async (id) => (await (await fetch(`/api/v1/projects/${id}/code-index/status`)).json()), projectId);
  report.index = status;
  check('real AST index ready', status.files > 0, `${status.files} files · ${status.symbols} symbols · ${status.stale} stale`);

  const system = await page.evaluate(async (id) => (await (await fetch(`/api/v1/projects/${id}/architecture?level=system`)).json()), projectId);
  report.system = { summary: system.summary, diagnostics: system.diagnostics };
  check('system projection has systems and modules', system.summary.systems > 0 && system.summary.modules > 0, `${system.summary.systems} systems · ${system.summary.modules} modules`);
  check('system projection has resolved edges', system.summary.resolvedEdges > 0, `${system.summary.resolvedEdges} resolved · ${system.summary.unresolvedEdges} unresolved`);
  await page.locator('.arch-node').first().waitFor({ timeout: 120000 });
  await page.screenshot({ path: join(outDir, 'acceptance-1-system.png') });
  report.screenshots.push('acceptance-1-system.png');

  // Drill into the module with the most files, then a file, then a symbol.
  const target = await page.evaluate(async (id) => {
    const data = await (await fetch(`/api/v1/projects/${id}/architecture?level=system`)).json();
    const modules = data.nodes.filter((node) => node.kind === 'module').sort((a, b) => b.counts.files - a.counts.files);
    const module = modules[0];
    if (!module) return null;
    const moduleView = await (await fetch(`/api/v1/projects/${id}/architecture?level=module&moduleId=${encodeURIComponent(module.moduleId)}`)).json();
    const file = moduleView.nodes.filter((node) => node.kind === 'file').sort((a, b) => b.counts.symbols - a.counts.symbols)[0];
    let symbol = null;
    if (file) {
      const symbolView = await (await fetch(`/api/v1/projects/${id}/architecture?level=symbol&filePath=${encodeURIComponent(file.filePath)}`)).json();
      symbol = symbolView.nodes.find((node) => node.symbolUid && node.kind !== 'unknown') ?? null;
    }
    return { module, file, symbol };
  }, projectId);
  check('module-level graph has files', Boolean(target?.module && target?.file), target?.module?.label ?? '');
  if (target?.module) {
    await page.locator(`.arch-node[data-module-id="${target.module.moduleId}"]`).first().click();
    await page.locator('.arch-node[data-file-path]').first().waitFor({ timeout: 60000 });
    await page.screenshot({ path: join(outDir, 'acceptance-2-module.png') });
    report.screenshots.push('acceptance-2-module.png');
  }
  if (target?.file) {
    await page.locator(`.arch-node[data-file-path="${target.file.filePath}"]`).first().click();
    await page.getByRole('button', { name: '符号调用' }).click();
    await page.locator('.arch-node[data-symbol-uid]').first().waitFor({ timeout: 60000 });
    await page.screenshot({ path: join(outDir, 'acceptance-3-symbol.png') });
    report.screenshots.push('acceptance-3-symbol.png');
    check('symbol-level graph has declarations', Boolean(target.symbol), `${target.symbol?.label ?? 'none'} in ${target.file.filePath}`);
  }
  if (target?.symbol) {
    await page.locator(`.arch-node[data-symbol-uid="${target.symbol.symbolUid}"]`).first().click();
    await page.locator('.code-source').first().waitFor({ timeout: 60000 });
    const detail = await page.locator('.code-detail').innerText();
    check('source and line evidence visible', /:\d+:\d+/.test(detail) && detail.length > 40, detail.split('\n')[0]);
    await page.screenshot({ path: join(outDir, 'acceptance-4-source.png') });
    report.screenshots.push('acceptance-4-source.png');
  }

  // Planned view must not hang.
  await page.getByRole('button', { name: '规划视图' }).click();
  await page.locator('.react-flow__node').first().waitFor({ timeout: 60000 });
  const plannedText = await page.locator('.canvas-wrap').innerText();
  check('planned view renders without an endless spinner', !plannedText.includes('正在加载快照'), plannedText.slice(0, 80).replace(/\n/g, ' | '));
  await page.screenshot({ path: join(outDir, 'acceptance-5-planned.png') });
  report.screenshots.push('acceptance-5-planned.png');
  report.finishedAt = new Date().toISOString();
  report.ok = !report.failed;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.ok = false;
  console.error('ACCEPTANCE ERROR:', report.error);
} finally {
  if (application) await application.close().catch(() => undefined);
  await rm(temp, { recursive: true, force: true, maxRetries: 10 });
  await writeFile(join(outDir, 'acceptance-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nreport: ${join(outDir, 'acceptance-report.json')}`);
  if (!report.ok) process.exitCode = 1;
}
