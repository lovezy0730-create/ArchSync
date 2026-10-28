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
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const AGENT_ENTRY = path.join(ROOT, 'apps', 'server', 'src', 'index.ts');
const DIST_INDEX = path.join(ROOT, 'apps', 'web', 'dist', 'index.html');

let mainWindow = null;
let tray = null;
let agentProcess = null;
let agentPort = 4310;
let quitting = false;
let monitorPaused = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function findFreePort(startPort) {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once('error', () => resolvePort(findFreePort(startPort + 1)));
    server.once('listening', () => {
      server.close(() => resolvePort(startPort));
    });
    server.listen(startPort, '127.0.0.1');
  });
}

function agentEnv() {
  const env = { ...process.env, PORT: String(agentPort), HOST: '127.0.0.1', ELECTRON_RUN: '1' };
  if (monitorPaused) env.ARCHSYNC_MONITOR_PAUSED = '1';
  return env;
}

function startAgent() {
  const tsxDir = path.join(ROOT, 'node_modules', '.bin');
  const tsxCmd = process.platform === 'win32' ? path.join(tsxDir, 'tsx.cmd') : path.join(tsxDir, 'tsx');
  const agent = spawn(tsxCmd, [AGENT_ENTRY], {
    cwd: ROOT,
    env: agentEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  agent.stdout.on('data', (d) => process.stdout.write(`[agent] ${d}`));
  agent.stderr.on('data', (d) => process.stderr.write(`[agent] ${d}`));
  agent.on('exit', (code) => {
    agentProcess = null;
    if (!quitting) {
      // 后台异常恢复：3 秒后重启 agent
      setTimeout(() => {
        if (!quitting) {
          agentPort = agentPort % 65535 === 0 ? 4310 : agentPort + 1;
          startAgent();
        }
      }, 3000);
    }
  });
  agentProcess = agent;
}

function waitForAgent(maxWaitMs = 30000) {
  const started = Date.now();
  return new Promise((resolveReady) => {
    const probe = () => {
      const req = net.connect(agentPort, '127.0.0.1', () => {
        req.destroy();
        resolveReady(true);
      });
      req.on('error', () => {
        if (Date.now() - started > maxWaitMs) resolveReady(false);
        else setTimeout(probe, 400);
      });
    };
    probe();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
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
  const iconPath = path.join(__dirname, 'icon.png');
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
    if (agentProcess) agentProcess.kill();
  }, 500);
}

app.whenReady().then(async () => {
  agentPort = await findFreePort(Number(process.env.PORT || 4310));
  // IPC：仅暴露受控查询，不暴露文件系统或命令执行
  ipcMain.handle('archsync:status', () => ({ port: agentPort, monitorPaused }));
  startAgent();
  const ready = await waitForAgent();
  if (!ready) {
    // agent 无法启动时仍打开一个错误页，用户可以看到日志路径
    mainWindow = new BrowserWindow({ width: 800, height: 500 });
    mainWindow.loadURL(`data:text/html,<h2>ArchSync Agent 启动失败</h2><p>请查看日志：%file%</p>`.replace('%file%', encodeURIComponent(path.join(ROOT, '.local'))));
  } else {
    createWindow();
  }
  createTray();
});

app.on('before-quit', () => {
  quitting = true;
  if (agentProcess) agentProcess.kill();
});

app.on('window-all-closed', () => {
  // 托盘常驻：不退出，保持监控
});
