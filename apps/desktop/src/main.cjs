/**
 * ArchSync desktop main process.
 *
 * Responsibilities:
 * - boot the local Fastify agent as a child process (127.0.0.1 only)
 * - pick a free port automatically when the default is taken
 * - open the workbench window; closing it keeps the agent running (tray)
 * - tray menu: open / pause monitoring / resume / quit
 * - single-instance guard; clean agent shutdown on real quit
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
let mainWindow = null;
let tray = null;
let agentProcess = null;
let agentPort = 4310;
let quitting = false;
let monitorPaused = false;
let restartCount = 0;

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
  const agent = utilityProcess.fork(AGENT_CJS, [], {
    env: agentEnv(),
    serviceName: 'archsync-agent',
    stdio: 'pipe',
  });
  const logDir = path.join(app.getPath('userData'),'logs');
  fs.mkdirSync(logDir,{recursive:true});
  for (const stream of [agent.stdout,agent.stderr]) stream?.on('data',data => fs.appendFileSync(path.join(logDir,'agent.log'),data));
  const stableTimer = setTimeout(() => { if (agentProcess === agent) restartCount = 0; },60000);
  agent.on('exit', () => {
    clearTimeout(stableTimer);
    if (agentProcess === agent) agentProcess = null;
    if (quitting) return;
    if (!agent.policyRestart) restartCount += 1;
    if (agent.policyRestart || restartCount <= 5) {
      restartTimer = setTimeout(() => {restartTimer = null; if (!quitting && !agentProcess) startAgent();},agent.policyRestart ? 50 : 3000);
    } else fs.appendFileSync(path.join(logDir,'agent.log'),'Agent 连续崩溃超过 5 次，停止自动重启\n');
  });
  agentProcess = agent;
}

function waitForAgent(maxWaitMs = 30000) {
  const started = Date.now();
  return new Promise(resolveReady => {
    const probe = () => {
      const retry = () => Date.now() - started > maxWaitMs ? resolveReady(false) : setTimeout(probe,400);
      const req = http.get(`http://127.0.0.1:${agentPort}/healthz`,res => {
        let body=''; res.on('data',data => {body+=data;});
        res.on('end',() => {
          try {if(JSON.parse(body).instanceId === instanceId) {resolveReady(true);return;}} catch {}
          retry();
        });
      });
      req.setTimeout(1000,() => req.destroy()); req.on('error',retry);
    }; probe();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0d1117',
    icon: path.join(app.getAppPath(), 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname,'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    try {const target=new URL(url);if(target.origin==='https://github.com'&&!target.username&&!target.password) void shell.openExternal(target.href);} catch {}
    return {action:'deny'};
  });
  mainWindow.webContents.on('will-navigate',(event,url) => {if (new URL(url).origin !== `http://127.0.0.1:${agentPort}`) event.preventDefault();});
  mainWindow.loadURL(`http://127.0.0.1:${agentPort}/`);
  mainWindow.on('close', (event) => {
    if (!quitting && process.env.ARCHSYNC_CLOSE_TO_TRAY !== '0') {
      event.preventDefault();
      mainWindow.hide(); // 关闭主窗口 → 常驻托盘继续监控
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

let restartTimer = null;
function restartAgentForPolicy() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (agentProcess) { agentProcess.policyRestart = true; agentProcess.kill(); } else {restartCount = 0;startAgent();}
  }, 500);
}

app.whenReady().then(async () => {
  agentPort = await findFreePort(Number(process.env.PORT || 4310));
  // IPC：仅暴露受控查询，不暴露文件系统或命令执行
  ipcMain.handle('archsync:choose-folder', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || new URL(event.senderFrame.url).origin !== `http://127.0.0.1:${agentPort}`) throw new Error('untrusted IPC sender');
    const result = await dialog.showOpenDialog(mainWindow,{properties:['openDirectory']});
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('archsync:status', () => ({ port: agentPort, monitorPaused }));
  startAgent();
  const ready = await waitForAgent();
  if (!ready) {
    // agent 无法启动时仍打开一个错误页，用户可以看到日志路径
    mainWindow = new BrowserWindow({ width: 800, height: 500 });
    mainWindow.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<h2>ArchSync Agent 启动失败</h2><p>请查看用户数据目录中的 logs/agent.log</p>`));
  } else {
    createWindow();
  }
  createTray();
});

app.on('before-quit', () => {
  quitting = true;
  if (restartTimer) {clearTimeout(restartTimer);restartTimer=null;}
  if (agentProcess) agentProcess.kill();
});

app.on('window-all-closed', () => {
  if (process.env.ARCHSYNC_CLOSE_TO_TRAY === '0') app.quit();
});
