/**
 * ArchSync desktop main process.
 *
 * Responsibilities:
 * - boot the local Fastify agent as a child process (127.0.0.1 only)
 * - show a startup/diagnostic page immediately, then navigate to the app when
 *   the agent answers /healthz (the agent now listens before scanning repos)
 * - pick a free port automatically when the default is taken
 * - open the workbench window; closing it keeps the agent running (tray)
 * - tray menu: open / pause monitoring / resume / quit
 * - single-instance guard; clean agent shutdown on real quit
 *
 * Diagnostics are written to <userData>/logs/main.log so a white screen can be
 * explained without DevTools.
 *
 * Security: contextIsolation on, nodeIntegration off, no remote content.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, utilityProcess } = require('electron');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const debugPort = Number(process.env.ARCHSYNC_E2E_DEBUG_PORT);
if (Number.isInteger(debugPort) && debugPort > 0 && debugPort < 65536) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(debugPort));
}
const instanceId = randomUUID();
if (process.env.ARCHSYNC_DESKTOP_DATA_DIR) {
  fs.mkdirSync(process.env.ARCHSYNC_DESKTOP_DATA_DIR,{recursive:true});
  app.setPath('userData',process.env.ARCHSYNC_DESKTOP_DATA_DIR);
}

// 打包态：agent.cjs 位于 resources（asar 外）；开发态：位于 dist-electron。
const isPackaged = app.isPackaged;
const AGENT_CJS = isPackaged
  ? path.join(process.resourcesPath, 'agent.cjs')
  : path.join(__dirname, 'agent', 'agent.cjs');
const STARTUP_HTML = path.join(app.getAppPath(), 'startup.html');
let mainWindow = null;
let tray = null;
let agentProcess = null;
let agentPort = 4310;
let quitting = false;
let monitorPaused = false;
let restartCount = 0;
let restartTimer = null;
let manualRetry = false;
let agentLastExit = null;
let startupStartedAt = Date.now();
let startupState = {
  phase: 'starting',
  message: '正在启动本地服务…',
  detail: '',
  elapsedMs: 0,
  agentAlive: false,
  logPath: '',
  build: null,
};

function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function logMain(...args) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(path.join(logDir(), 'main.log'), `${new Date().toISOString()} ${args.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`);
  } catch { /* logging must never break startup */ }
}

function readBuildInfo() {
  const candidates = isPackaged
    ? [path.join(process.resourcesPath, 'build-info.json'), path.join(app.getAppPath(), 'build-info.json')]
    : [path.join(__dirname, 'build-info.json')];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        version: typeof parsed.version === 'string' ? parsed.version : app.getVersion(),
        sha: typeof parsed.sha === 'string' ? parsed.sha : 'unknown',
        builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : null,
        dirty: typeof parsed.dirty === 'boolean' ? parsed.dirty : null,
      };
    } catch { /* try next */ }
  }
  return {
    version: process.env.ARCHSYNC_APP_VERSION ?? app.getVersion(),
    sha: process.env.ARCHSYNC_BUILD_SHA ?? 'unknown',
    builtAt: null,
    dirty: null,
  };
}
const BUILD_INFO = readBuildInfo();

function publishStartup(patch = {}) {
  startupState = {
    ...startupState,
    ...patch,
    elapsedMs: Date.now() - startupStartedAt,
    logPath: logDir(),
    build: BUILD_INFO,
  };
  if (patch.phase) logMain('[startup]', startupState.phase, startupState.message ?? '', startupState.detail ? `| ${startupState.detail}` : '');
  try { mainWindow?.webContents.send('archsync:startup-status', startupState); } catch { /* page not ready */ }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function findFreePort(startPort) {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once('error', () => resolvePort(findFreePort(startPort + 1)));
    server.once('listening', () => {
      const actualPort = server.address().port;
      server.close(() => resolvePort(actualPort));
    });
    server.listen(startPort, '127.0.0.1');
  });
}

function agentEnv() {
  const userData = app.getPath('userData');
  const workspace = path.join(userData, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const env = {
    ...process.env,
    ARCHSYNC_INSTANCE_ID: instanceId,
    PORT: String(agentPort),
    HOST: '127.0.0.1',
    ARCHSYNC_DATA_DIR: path.join(userData, 'data'), // SQLite/状态/日志 → 用户数据目录
    ARCHSYNC_LOG_DIR: logDir(),
    ARCHSYNC_BUILD_INFO: JSON.stringify(BUILD_INFO),
    ARCHSYNC_APP_VERSION: BUILD_INFO.version,
    ARCHSYNC_ELECTRON_VERSION: process.versions.electron ?? null,
    ARCHSYNC_WEB_DIST: isPackaged
      ? path.join(process.resourcesPath, 'web-dist')
      : path.join(__dirname, '..', '..', '..', 'apps', 'web', 'dist'),
    WORKSPACE_ROOT: workspace,
    ARCHSYNC_PYTHON_ASSETS: isPackaged
      ? path.join(process.resourcesPath, 'python-assets')
      : path.join(__dirname, 'python-assets'),
  };
  if (monitorPaused) env.ARCHSYNC_MONITOR_PAUSED = '1';
  return env;
}

function startAgent() {
  // 打包态与开发态共用同一 agent.cjs bundle（Electron utilityProcess 提供
  // Node 运行时，不依赖系统 Node/pnpm/tsx）。debug 端口仅崩溃排查用。
  if (!fs.existsSync(AGENT_CJS)) {
    agentLastExit = `agent bundle missing: ${AGENT_CJS}`;
    logMain('[agent] missing', AGENT_CJS);
    publishStartup({
      phase: 'error',
      message: '本地服务文件缺失',
      detail: `找不到 ${AGENT_CJS}\nPortable 版请重新解压；安装版请重新安装。`,
      agentAlive: false,
    });
    return null;
  }
  const agent = utilityProcess.fork(AGENT_CJS, [], {
    env: agentEnv(),
    serviceName: 'archsync-agent',
    stdio: 'pipe',
  });
  fs.mkdirSync(logDir(),{recursive:true});
  for (const stream of [agent.stdout,agent.stderr]) stream?.on('data',data => fs.appendFileSync(path.join(logDir(),'agent.log'),data));
  const stableTimer = setTimeout(() => { if (agentProcess === agent) restartCount = 0; },60000);
  agent.on('exit', (code, signal) => {
    clearTimeout(stableTimer);
    agentLastExit = `code=${code} signal=${signal ?? 'none'}`;
    logMain('[agent] exit', agentLastExit);
    if (agentProcess === agent) agentProcess = null;
    if (quitting) return;
    if (manualRetry) return;
    if (!agent.policyRestart) restartCount += 1;
    const willRestart = agent.policyRestart || restartCount <= 5;
    if (!willRestart) {
      fs.appendFileSync(path.join(logDir(),'agent.log'),'Agent 连续崩溃超过 5 次，停止自动重启\n');
      publishStartup({ phase: 'error', message: '本地服务连续退出', detail: `最近一次退出：${agentLastExit}\n请打开日志目录查看 agent.log。`, agentAlive: false });
      return;
    }
    publishStartup({ phase: 'waiting-agent', message: '本地服务已退出，正在重启…', detail: `最近一次退出：${agentLastExit}`, agentAlive: false });
    // Show the startup page so the user gets feedback instead of a stale/white
    // workbench while the agent restarts.
    try {
      if (mainWindow && mainWindow.webContents.getURL().startsWith('http://')) void loadStartupPage();
    } catch { /* window is gone */ }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (quitting || agentProcess) return;
      startAgent();
      void waitForAgent(60000, (progress) => publishStartup({
        phase: 'waiting-agent',
        message: '正在重启本地服务…',
        detail: `已等待 ${Math.round(progress.elapsedMs / 1000)} 秒`,
        agentAlive: Boolean(agentProcess),
      })).then((ready) => { if (ready) void loadApp(); });
    }, agent.policyRestart ? 50 : 3000);
  });
  agentProcess = agent;
  publishStartup({ phase: 'waiting-agent', message: '正在启动本地服务…', detail: '正在打开数据库并恢复上次索引；仓库源码扫描在后台进行。', agentAlive: true });
  return agent;
}

function probeHealth() {
  return new Promise((resolveProbe) => {
    const req = http.get(`http://127.0.0.1:${agentPort}/healthz`, (res) => {
      let body = '';
      res.on('data', (data) => { body += data; });
      res.on('end', () => {
        try { resolveProbe(JSON.parse(body)); } catch { resolveProbe(null); }
      });
    });
    req.setTimeout(1200, () => { req.destroy(); resolveProbe(null); });
    req.on('error', () => resolveProbe(null));
  });
}

async function waitForAgent(maxWaitMs = 120000, onProgress = null) {
  const started = Date.now();
  for (;;) {
    const health = await probeHealth();
    if (health && health.instanceId === instanceId) {
      logMain('[agent] ready', Date.now() - started, 'ms', health.phase ?? '');
      return true;
    }
    if (Date.now() - started > maxWaitMs) return false;
    onProgress?.({ elapsedMs: Date.now() - started, agentAlive: Boolean(agentProcess), health });
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  }
}

function loadStartupPage() {
  if (!mainWindow) return Promise.resolve();
  return mainWindow.loadFile(STARTUP_HTML).catch((error) => {
    logMain('[startup] startup page load failed', error?.message ?? String(error));
    return undefined;
  });
}

async function loadApp() {
  if (!mainWindow) return;
  publishStartup({ phase: 'ready', message: '正在打开工作台…', detail: '', agentAlive: true });
  try {
    await mainWindow.loadURL(`http://127.0.0.1:${agentPort}/`);
    logMain('[startup] app loaded', Date.now() - startupStartedAt, 'ms');
  } catch (error) {
    logMain('[startup] app load failed', error?.message ?? String(error));
    publishStartup({
      phase: 'error',
      message: '工作台页面加载失败',
      detail: `${error?.message ?? String(error)}\n本地服务地址：http://127.0.0.1:${agentPort}\n请点击重试或打开日志目录。`,
      agentAlive: Boolean(agentProcess),
    });
    await loadStartupPage();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1117',
    icon: path.join(app.getAppPath(), 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname,'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    try {const target=new URL(url);if(target.origin==='https://github.com'&&!target.username&&!target.password) void shell.openExternal(target.href);} catch {}
    return {action:'deny'};
  });
  mainWindow.webContents.on('will-navigate',(event,url) => {
    const allowed = url.startsWith(`http://127.0.0.1:${agentPort}`) || url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logMain('[renderer] did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame });
    if (isMainFrame && validatedURL.startsWith('http://127.0.0.1')) {
      publishStartup({
        phase: 'error',
        message: '工作台页面加载失败',
        detail: `${errorDescription} (${errorCode})\n${validatedURL}\n请点击重试或打开日志目录。`,
        agentAlive: Boolean(agentProcess),
      });
      void loadStartupPage();
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logMain('[renderer] render-process-gone', details);
    publishStartup({
      phase: 'error',
      message: '界面进程异常退出',
      detail: `reason=${details.reason} exitCode=${details.exitCode}\n可以重试；若反复出现请打开日志目录。`,
      agentAlive: Boolean(agentProcess),
    });
    void loadStartupPage();
  });
  mainWindow.on('unresponsive', () => {
    logMain('[renderer] unresponsive');
    publishStartup({ phase: 'waiting-agent', message: '界面响应较慢…', detail: '正在等待渲染进程恢复；若持续无响应请重试。', agentAlive: Boolean(agentProcess) });
  });
  mainWindow.on('responsive', () => logMain('[renderer] responsive'));
  mainWindow.webContents.on('did-finish-load', () => {
    try { mainWindow?.webContents.send('archsync:startup-status', startupState); } catch { /* ignore */ }
  });
  mainWindow.on('close', (event) => {
    if (!quitting && process.env.ARCHSYNC_CLOSE_TO_TRAY !== '0') {
      event.preventDefault();
      mainWindow.hide(); // 关闭主窗口 → 常驻托盘继续监控
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void loadStartupPage();
}

function createTray() {
  const iconPath = path.join(app.getAppPath(), 'icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  const rebuildMenu = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 ArchSync', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
      { type: 'separator' },
      {
        label: monitorPaused ? '恢复监控' : '暂停监控',
        click: () => {
          monitorPaused = !monitorPaused;
          restartAgentForPolicy();
          rebuildMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出（停止监控）',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]));
  };
  rebuildMenu();
  tray.setToolTip('ArchSync — 架构协作监控');
}

function restartAgentForPolicy() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (agentProcess) { agentProcess.policyRestart = true; agentProcess.kill(); } else {restartCount = 0;startAgent();}
  }, 500);
}

async function retryStartup() {
  // If the agent is healthy, a page-load failure only needs the app URL again.
  const health = await probeHealth();
  if (health && health.instanceId === instanceId) {
    await loadApp();
    return { ready: true };
  }
  manualRetry = true;
  restartCount = 0;
  if (agentProcess) {
    try { agentProcess.kill(); } catch { /* already gone */ }
    agentProcess = null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  manualRetry = false;
  startupStartedAt = Date.now();
  publishStartup({ phase: 'starting', message: '正在重新启动本地服务…', detail: '', agentAlive: false });
  startAgent();
  const ready = await waitForAgent(120000, (progress) => publishStartup({
    phase: 'waiting-agent',
    message: '正在恢复本地索引…',
    detail: `已等待 ${Math.round(progress.elapsedMs / 1000)} 秒；数据库与上次索引优先恢复，仓库扫描在后台进行。`,
    agentAlive: Boolean(agentProcess),
  }));
  if (ready) await loadApp();
  else publishStartup({ phase: 'error', message: '本地服务启动超时', detail: `${agentLastExit ? `上次退出：${agentLastExit}\n` : ''}请打开日志目录查看 agent.log。`, agentAlive: Boolean(agentProcess) });
  return { ready };
}

process.on('uncaughtException', (error) => logMain('[main] uncaughtException', error?.stack ?? String(error)));
process.on('unhandledRejection', (reason) => logMain('[main] unhandledRejection', reason?.stack ?? String(reason)));
app.on('child-process-gone', (_event, details) => logMain('[main] child-process-gone', details));

app.whenReady().then(async () => {
  startupStartedAt = Date.now();
  agentPort = await findFreePort(Number(process.env.PORT || 4310));
  logMain('[startup] ready', { version: BUILD_INFO.version, sha: BUILD_INFO.sha, electron: process.versions.electron, dataDir: app.getPath('userData'), agentPort, agentCjs: AGENT_CJS });

  // IPC：仅暴露受控查询，不暴露文件系统或命令执行
  ipcMain.handle('archsync:choose-folder', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('untrusted IPC sender');
    const result = await dialog.showOpenDialog(mainWindow,{properties:['openDirectory']});
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('archsync:status', () => ({ port: agentPort, monitorPaused, startup: startupState, build: BUILD_INFO }));
  ipcMain.handle('archsync:startup-info', () => startupState);
  ipcMain.handle('archsync:retry-startup', () => retryStartup());
  ipcMain.handle('archsync:open-logs', async () => {
    fs.mkdirSync(logDir(), { recursive: true });
    return shell.openPath(logDir());
  });

  createWindow();
  createTray();

  // Show the startup page immediately, then start the agent. The agent now
  // listens before scanning repositories, so this should resolve in seconds.
  publishStartup({
    phase: 'starting',
    message: '正在启动本地服务…',
    detail: `数据目录：${app.getPath('userData')}\n日志目录：${logDir()}\n版本 ${BUILD_INFO.version} · ${String(BUILD_INFO.sha).slice(0, 8)}`,
  });
  startAgent();
  const ready = await waitForAgent(120000, (progress) => publishStartup({
    phase: 'waiting-agent',
    message: '正在恢复本地索引…',
    detail: `已等待 ${Math.round(progress.elapsedMs / 1000)} 秒；数据库与上次索引优先恢复，仓库扫描在后台进行。`,
    agentAlive: Boolean(agentProcess),
  }));
  if (ready) {
    const health = await probeHealth();
    logMain('[startup] agent health', health);
    await loadApp();
  } else {
    publishStartup({
      phase: 'error',
      message: '本地服务启动超时',
      detail: `${agentLastExit ? `上次退出：${agentLastExit}\n` : ''}请打开日志目录查看 agent.log，然后点击重试。`,
      agentAlive: Boolean(agentProcess),
    });
  }
});

app.on('before-quit', () => {
  quitting = true;
  if (restartTimer) {clearTimeout(restartTimer);restartTimer=null;}
  if (agentProcess) agentProcess.kill();
});

app.on('window-all-closed', () => {
  if (process.env.ARCHSYNC_CLOSE_TO_TRAY === '0') app.quit();
});
