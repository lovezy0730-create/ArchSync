// apps/desktop/src/main.cjs
var { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");
var { spawn } = require("node:child_process");
var net = require("node:net");
var path = require("node:path");
var fs = require("node:fs");
var ROOT = path.join(__dirname, "..");
var AGENT_ENTRY = path.join(ROOT, "apps", "server", "src", "index.ts");
var DIST_INDEX = path.join(ROOT, "apps", "web", "dist", "index.html");
var mainWindow = null;
var tray = null;
var agentProcess = null;
var agentPort = 4310;
var quitting = false;
var monitorPaused = false;
var gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
function findFreePort(startPort) {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once("error", () => resolvePort(findFreePort(startPort + 1)));
    server.once("listening", () => {
      server.close(() => resolvePort(startPort));
    });
    server.listen(startPort, "127.0.0.1");
  });
}
function agentEnv() {
  const env = { ...process.env, PORT: String(agentPort), HOST: "127.0.0.1", ELECTRON_RUN: "1" };
  if (monitorPaused) env.ARCHSYNC_MONITOR_PAUSED = "1";
  return env;
}
function startAgent() {
  const tsxDir = path.join(ROOT, "node_modules", ".bin");
  const tsxCmd = process.platform === "win32" ? path.join(tsxDir, "tsx.cmd") : path.join(tsxDir, "tsx");
  const agent = spawn(tsxCmd, [AGENT_ENTRY], {
    cwd: ROOT,
    env: agentEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  agent.stdout.on("data", (d) => process.stdout.write(`[agent] ${d}`));
  agent.stderr.on("data", (d) => process.stderr.write(`[agent] ${d}`));
  agent.on("exit", (code) => {
    agentProcess = null;
    if (!quitting) {
      setTimeout(() => {
        if (!quitting) {
          agentPort = agentPort % 65535 === 0 ? 4310 : agentPort + 1;
          startAgent();
        }
      }, 3e3);
    }
  });
  agentProcess = agent;
}
function waitForAgent(maxWaitMs = 3e4) {
  const started = Date.now();
  return new Promise((resolveReady) => {
    const probe = () => {
      const req = net.connect(agentPort, "127.0.0.1", () => {
        req.destroy();
        resolveReady(true);
      });
      req.on("error", () => {
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
    backgroundColor: "#0d1117",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadURL(`http://127.0.0.1:${agentPort}/`);
  mainWindow.on("close", (event) => {
    if (!quitting && process.env.ARCHSYNC_CLOSE_TO_TRAY !== "0") {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
function createTray() {
  const iconPath = path.join(__dirname, "icon.png");
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  const rebuildMenu = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "\u6253\u5F00 ArchSync", click: () => {
        if (mainWindow) mainWindow.show();
        else createWindow();
      } },
      { type: "separator" },
      {
        label: monitorPaused ? "\u6062\u590D\u76D1\u63A7" : "\u6682\u505C\u76D1\u63A7",
        click: () => {
          monitorPaused = !monitorPaused;
          restartAgentForPolicy();
          rebuildMenu();
        }
      },
      { type: "separator" },
      {
        label: "\u9000\u51FA\uFF08\u505C\u6B62\u76D1\u63A7\uFF09",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ]));
  };
  rebuildMenu();
  tray.setToolTip("ArchSync \u2014 \u67B6\u6784\u534F\u4F5C\u76D1\u63A7");
}
var restartTimer = null;
function restartAgentForPolicy() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (agentProcess) agentProcess.kill();
  }, 500);
}
app.whenReady().then(async () => {
  agentPort = await findFreePort(Number(process.env.PORT || 4310));
  ipcMain.handle("archsync:status", () => ({ port: agentPort, monitorPaused }));
  startAgent();
  const ready = await waitForAgent();
  if (!ready) {
    mainWindow = new BrowserWindow({ width: 800, height: 500 });
    mainWindow.loadURL(`data:text/html,<h2>ArchSync Agent \u542F\u52A8\u5931\u8D25</h2><p>\u8BF7\u67E5\u770B\u65E5\u5FD7\uFF1A%file%</p>`.replace("%file%", encodeURIComponent(path.join(ROOT, ".local"))));
  } else {
    createWindow();
  }
  createTray();
});
app.on("before-quit", () => {
  quitting = true;
  if (agentProcess) agentProcess.kill();
});
app.on("window-all-closed", () => {
});
