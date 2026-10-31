import { _electron as electron, chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm, access, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const temp = await mkdtemp(join(tmpdir(), 'archsync-rc5-e2e-'));
const repo = join(temp, 'mixed-repo');
const data = join(temp, 'user-data');
const evidence = resolve('apps/desktop/release/evidence');
await mkdir(join(repo, 'src'), { recursive: true });
await mkdir(join(repo, 'lib'), { recursive: true });
await mkdir(evidence, { recursive: true });
await writeFile(join(repo, 'src', 'main.ts'), "import { helper } from '../lib/tool';\nexport function hello(n: number): number { return helper(n) + 1; }\n");
await writeFile(join(repo, 'lib', 'tool.ts'), 'export function helper(n: number): number { return n; }\n');
await writeFile(join(repo, 'src', 'service.py'), 'class Service:\n    def greet(self):\n        return "hello"\n');
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd: repo, windowsHide: true });
const executablePath = process.env.ARCHSYNC_E2E_EXE ?? resolve('apps/desktop/release/win-unpacked/ArchSync.exe');
let application;
let browser;
let portableProcess;
let currentPage;
let agentPid;
async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolvePort(port));
    });
  });
}
async function launch() {
  const env = { ...process.env, ARCHSYNC_DESKTOP_DATA_DIR: data, ARCHSYNC_CLOSE_TO_TRAY: '0', PORT: '0', AUTH_CODE: '', DEV_AUTH_MODE: 'mock', GITHUB_TOKEN: process.env.ARCHSYNC_E2E_GITHUB_TOKEN ?? '' };
  delete env.ELECTRON_RUN_AS_NODE;
  let page;
  if (process.env.ARCHSYNC_E2E_PORTABLE === '1') {
    const port = await availablePort();
    env.ARCHSYNC_E2E_DEBUG_PORT = String(port);
    portableProcess = spawn(executablePath, [], { env, windowsHide: true, stdio: 'ignore' });
    const deadline = Date.now() + 120000;
    while (!browser && Date.now() < deadline) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); }
      catch { await new Promise((resolveWait) => setTimeout(resolveWait, 500)); }
    }
    if (!browser) throw new Error('portable application did not expose its test browser');
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 60000 });
  } else {
    application = await electron.launch({ executablePath, env, timeout: 60000 });
    page = await application.firstWindow();
  }
  currentPage = page;
  await page.waitForURL('http://127.0.0.1:*/', { timeout: 60000 });
  const health = await page.evaluate(async () => (await fetch('/healthz')).json());
  agentPid = health.pid;
  return page;
}
async function stop() {
  if (application) { await application.close(); application = undefined; }
  else if (browser) {
    await currentPage.close();
    await browser.close().catch(() => undefined);
    browser = undefined; currentPage = undefined;
    portableProcess = undefined;
  }
  for (let i = 0; i < 100; i++) {
    try { process.kill(agentPid, 0); } catch { return; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('agent did not exit');
}
try {
  let page = await launch();
  await page.getByRole('button', { name: '打开或克隆仓库' }).click();
  await page.getByRole('dialog', { name: '添加项目' }).locator('input').first().fill(repo);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('dialog', { name: '添加项目' }).waitFor({ state: 'hidden', timeout: 60000 });
  const projectId = await page.waitForFunction(async (p) => {
    const list = await (await fetch('/api/v1/registry')).json();
    return list.projects.find((project) => project.localPath === p)?.id;
  }, repo).then((handle) => handle.jsonValue());
  await page.waitForFunction(async (id) => {
    const index = await (await fetch(`/api/v1/projects/${id}/code-index`)).json();
    return index.state === 'ready' && index.summary.fresh === 3;
  }, projectId, { timeout: 60000 });
  const before = await page.evaluate(async (id) => (await (await fetch(`/api/v1/projects/${id}/code-index`)).json()), projectId);
  const uid = before.files.flatMap((file) => file.symbols).find((symbol) => symbol.name === 'hello').symbolUid;
  await page.getByText(/扫描完成 · 3 个有效文件/).waitFor({ timeout: 30000 });
  await page.locator('.react-flow__edge').first().waitFor();
  await page.screenshot({ path: join(evidence, 'rc5-module-graph.png') });
  await page.getByRole('button', { name: /src（推断）/ }).click();
  await page.getByRole('button', { name: /src\/main.ts/ }).click();
  await page.getByRole('button', { name: /hello.*function/ }).click();
  await page.locator('.code-source').getByText('export function hello', { exact: false }).waitFor();
  await page.screenshot({ path: join(evidence, 'rc5-ts-source.png') });
  await page.getByRole('button', { name: /src（推断）/ }).first().click();
  await page.getByRole('button', { name: /src\/service.py/ }).click();
  await page.getByRole('button', { name: /Service.greet/ }).click();
  await page.locator('.code-source').getByText('def greet', { exact: false }).waitFor();
  await page.screenshot({ path: join(evidence, 'rc5-python-source.png') });
  await page.getByRole('button', { name: '刷新 GitHub' }).click();
  await page.locator('.registry-status [role=alert]').waitFor();
  assert.match(await page.locator('.badge-gh').getAttribute('class'), /badge-unavailable/);
  await writeFile(join(repo, 'src', 'main.ts'), "import { helper } from '../lib/tool';\nexport function hello(n: number): number { return helper(n) + 2; }\n");
  await page.waitForFunction(async ({ id, previous }) => {
    const index = await (await fetch(`/api/v1/projects/${id}/code-index`)).json();
    const symbol = index.files.flatMap((file) => file.symbols).find((item) => item.name === 'hello');
    return symbol && symbol.symbolUid === previous && index.files.find((file) => file.filePath === 'src/main.ts').revision > 1;
  }, { id: projectId, previous: uid }, { timeout: 30000 });
  await access(join(data, 'data', 'registry.sqlite'));
  await stop();
  page = await launch();
  await page.waitForFunction(async (id) => {
    const index = await (await fetch(`/api/v1/projects/${id}/code-index`)).json();
    return index.files?.some((file) => file.filePath === 'src/main.ts' && file.status === 'fresh');
  }, projectId, { timeout: 60000 });
  const registry = await page.evaluate(async () => (await fetch('/api/v1/registry')).json());
  assert.ok(registry.projects.some((project) => project.id === projectId));
  await page.getByText('Service.greet', { exact: false }).first().waitFor({ timeout: 30000 });
  for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    assert.equal(await page.locator('.topbar').evaluate((el) => el.scrollWidth <= el.clientWidth), true, `top bar overflows at ${size.width}`);
  }
  await page.locator('.add-project-btn').click();
  await page.getByRole('dialog', { name: '添加项目' }).locator('input').first().fill(resolve('.'));
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('dialog', { name: '添加项目' }).waitFor({ state: 'hidden', timeout: 60000 });
  const self = await page.waitForFunction(async () => {
    const list = await (await fetch('/api/v1/registry')).json();
    return list.projects.find((project) => project.id === 'archsync')?.id;
  }).then((handle) => handle.jsonValue());
  const scannerModule = await page.waitForFunction(async (id) => {
    const index = await (await fetch(`/api/v1/projects/${id}/code-index`)).json();
    const file = index.files?.find((item) => item.filePath === 'packages/scanner/src/imports.ts');
    return index.state === 'ready' && file?.symbols.some((item) => item.name === 'analyzeImports') ? file.moduleId : null;
  }, self, { timeout: 180000 }).then((handle) => handle.jsonValue());
  await page.locator(`[data-module-id="${scannerModule}"]`).click();
  await page.getByRole('button', { name: /packages\/scanner\/src\/imports.ts/ }).click();
  await page.getByRole('button', { name: /analyzeImports.*function/ }).click();
  await page.locator('.code-source').getByText('function analyzeImports', { exact: false }).waitFor();
  await page.screenshot({ path: join(evidence, 'rc5-archsync-source.png') });
  await page.waitForFunction(async () => (await (await fetch('/api/v1/workspace/active-project')).json()).projectId === 'archsync');
  await stop();
  page = await launch();
  await page.locator('.project-select').waitFor();
  await page.waitForFunction(() => document.querySelector('.project-select')?.value === 'archsync', null, { timeout: 60000 });
  await page.getByText('analyzeImports', { exact: true }).first().waitFor({ timeout: 60000 });
  await page.locator('.project-select').selectOption(projectId);
  await page.waitForFunction(async (id) => (await (await fetch('/api/v1/workspace/active-project')).json()).projectId === id, projectId);
  await stop();
  await rename(repo, `${repo}-missing`);
  page = await launch();
  await page.getByText('上次打开的项目不可用，请重新选择或检查路径。').waitFor({ timeout: 60000 });
  assert.equal(await page.locator('.project-select').inputValue(), '');
  await stop();
  await rename(`${repo}-missing`, repo);
  if (process.env.ARCHSYNC_E2E_GITHUB === '1') {
    page = await launch();
    await page.locator('.add-project-btn').click();
    await page.getByRole('button', { name: 'GitHub 仓库', exact: true }).click();
    await page.getByPlaceholder('https://github.com/owner/repo 或 owner/repo').fill('lovezy0730-create/ArchSync');
    await page.getByRole('button', { name: '添加远端监控' }).click();
    await page.getByRole('dialog', { name: '添加项目' }).waitFor({ state: 'hidden', timeout: 60000 });
    const remoteId = 'remote-lovezy0730-create-archsync';
    await page.waitForFunction(async (id) => {
      const response = await fetch(`/api/v1/registry/${id}/github`);
      if (!response.ok) return false;
      const status = await response.json();
      return status.collab.source === 'live' && status.collab.pullRequests.some((pr) => pr.number === 11);
    }, remoteId, { timeout: 120000 });
    const remoteIndex = await page.evaluate(async (id) => (await (await fetch(`/api/v1/projects/${id}/code-index`)).json()), remoteId);
    assert.equal(remoteIndex.files.length, 0, 'remote-only project must not invent local symbols');
    await page.locator('button[title="项目动态（GitHub 事件 / 本地变化时间线）"]').click();
    await page.locator('a[href$="/pull/11"]').waitFor({ timeout: 30000 });
    await page.getByText(/Issue（/).first().waitFor();
    await page.getByText(/远端 HEAD.*CI/).first().waitFor();
    await page.screenshot({ path: join(evidence, 'rc5-github-live.png') });
    await stop();
    console.log('PASS: public GitHub GUI registration and live PR/Issue/CI view');
  }
  console.log('PASS: packaged mixed repository, TS/Python navigation, source, watched edit, UID, restart, offline GitHub state and self-scan');
} finally {
  if (application) await application.close();
  if (browser) await browser.close().catch(() => undefined);
  if (portableProcess && portableProcess.exitCode === null) portableProcess.kill();
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
