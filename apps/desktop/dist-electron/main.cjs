// apps/desktop/src/main.cjs
var { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, utilityProcess } = require("electron");
var net = require("node:net");
var path = require("node:path");
var fs = require("node:fs");
var isPackaged = app.isPackaged;
var AGENT_CJS = isPackaged ? path.join(process.resourcesPath, "agent.cjs") : path.join(__dirname, "agent", "agent.cjs");
var BUILTIN_ROOT = isPackaged ? path.join(process.resourcesPath, "builtin-projects") : path.join(__dirname, "..", "..");
var mainWindow = null;
var tray = null;
var agentProcess = null;
var agentPort = 4310;
var quitting = false;
var monitorPaused = false;
var restartCount = 0;
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
  const userData = app.getPath("userData");
  const env = {
    ...process.env,
    PORT: String(agentPort),
    HOST: "127.0.0.1",
    ARCHSYNC_DATA_DIR: path.join(userData, "data"),
    // SQLite/状态/日志 → 用户数据目录
    ARCHSYNC_WEB_DIST: isPackaged ? path.join(process.resourcesPath, "web-dist") : path.join(__dirname, "..", "..", "apps", "web", "dist"),
    WORKSPACE_ROOT: BUILTIN_ROOT
  };
  if (monitorPaused) env.ARCHSYNC_MONITOR_PAUSED = "1";
  return env;
}
function startAgent() {
  const agent = utilityProcess.fork(AGENT_CJS, [], {
    env: agentEnv(),
    serviceName: "archsync-agent",
    stdio: "ignore"
  });
  agent.on("exit", (code) => {
    agentProcess = null;
    if (!quitting) {
      restartCount += 1;
      if (restartCount <= 5) {
        setTimeout(() => {
          if (!quitting) startAgent();
        }, 3e3);
      } else {
        console.error("[desktop] agent \u8FDE\u7EED\u5D29\u6E83\u8D85\u8FC7 5 \u6B21\uFF0C\u505C\u6B62\u81EA\u52A8\u91CD\u542F");
      }
    }
  });
  setTimeout(() => {
    restartCount = 0;
  }, 6e4);
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
