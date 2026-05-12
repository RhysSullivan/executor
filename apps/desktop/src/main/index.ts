import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import windowStateKeeper from "electron-window-state";
import log from "electron-log/main.js";
import updater from "electron-updater";
const { autoUpdater } = updater;
import {
  startSidecar,
  stopSidecar,
  SidecarPortInUseError,
  type SidecarConnection,
} from "./sidecar";
import { getServerSettings, regeneratePassword, updateServerSettings } from "./settings";
import { SERVER_SETTINGS_USERNAME, type DesktopServerSettings } from "../shared/server-settings";

// Pin userData to a friendly app-name-scoped dir BEFORE app.ready so every
// Electron-side consumer (electron-store, electron-log, window-state) lands
// at a predictable spot. User-mutable executor state (executor.jsonc,
// data.db) is pinned separately to ~/.executor in main/sidecar.ts — that
// path matches the CLI's default.
app.setName("Executor");
app.setPath("userData", join(app.getPath("appData"), "Executor"));

log.initialize({ preload: true });
log.transports.file.level = "info";

let mainWindow: BrowserWindow | null = null;
let connection: SidecarConnection | null = null;
let authHeaderUnsubscribe: (() => void) | null = null;

const PRELOAD_PATH = fileURLToPath(new URL("../preload/index.js", import.meta.url));

const ensureSingleInstance = () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  return true;
};

const installBasicAuthHeader = (origin: string, password: string | null) => {
  authHeaderUnsubscribe?.();
  authHeaderUnsubscribe = null;
  if (!password) return;
  const credentials = Buffer.from(`${SERVER_SETTINGS_USERNAME}:${password}`).toString("base64");
  const headerValue = `Basic ${credentials}`;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: { ...details.requestHeaders, Authorization: headerValue },
      });
    },
  );
  authHeaderUnsubscribe = () => {
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, null);
  };
};

const resolveLinuxIcon = (): string | undefined => {
  if (process.platform !== "linux") return undefined;
  if (app.isPackaged) return join(process.resourcesPath, "icon.png");
  return join(import.meta.dirname, "..", "..", "build", "icon.png");
};

const createWindow = async (conn: SidecarConnection) => {
  const windowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800,
  });

  installBasicAuthHeader(conn.baseUrl, conn.authPassword);

  const linuxIcon = resolveLinuxIcon();

  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    ...(linuxIcon ? { icon: linuxIcon } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  windowState.manage(mainWindow);

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(conn.baseUrl);
};

const showPortInUseDialog = async (port: number) => {
  await dialog.showMessageBox({
    type: "error",
    title: "Executor port in use",
    message: `Port ${port} is already taken.`,
    detail:
      "Another process is listening on that port. Quit it (or change the desktop server's port in Settings) and relaunch Executor.",
    buttons: ["OK"],
  });
};

const startWithCurrentSettings = async (): Promise<SidecarConnection | null> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: bind failures surface as a user-facing dialog
  try {
    return await startSidecar();
  } catch (error) {
    // oxlint-disable-next-line executor/no-instanceof-tagged-error -- boundary: SidecarPortInUseError is a plain Node Error subclass, not an Effect tagged error
    if (error instanceof SidecarPortInUseError) {
      await showPortInUseDialog(error.port);
      return null;
    }
    log.error("Failed to start executor sidecar", error);
    return null;
  }
};

const restartSidecarAndReload = async (): Promise<{ port: number; baseUrl: string }> => {
  if (connection) {
    await stopSidecar(connection.child);
    connection = null;
  }
  const next = await startWithCurrentSettings();
  if (!next) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: surfaces to renderer as a rejected IPC call
    throw new Error("Sidecar failed to restart — see Settings");
  }
  connection = next;
  installBasicAuthHeader(next.baseUrl, next.authPassword);
  if (mainWindow) await mainWindow.loadURL(next.baseUrl);
  return { port: next.port, baseUrl: next.baseUrl };
};

const registerIpcHandlers = () => {
  ipcMain.handle("executor:settings:get", (): DesktopServerSettings => getServerSettings());
  ipcMain.handle(
    "executor:settings:update",
    (_evt, patch: Partial<DesktopServerSettings>): DesktopServerSettings =>
      updateServerSettings(patch),
  );
  ipcMain.handle(
    "executor:settings:regenerate-password",
    (): DesktopServerSettings => regeneratePassword(),
  );
  ipcMain.handle("executor:server:restart", () => restartSidecarAndReload());
};

const boot = async () => {
  registerIpcHandlers();
  connection = await startWithCurrentSettings();
  if (!connection) {
    // Even when the sidecar can't start, open the window so the user
    // reaches Settings to change the port. Pointing at the (unreachable)
    // baseUrl would just show ECONNREFUSED — a placeholder URL would be
    // worse. For now: quit with the dialog already shown.
    app.quit();
    return;
  }
  await createWindow(connection);
  if (app.isPackaged) {
    autoUpdater.logger = log;
    void autoUpdater.checkForUpdatesAndNotify();
  }
};

if (ensureSingleInstance()) {
  app.whenReady().then(boot);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!connection) return;
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(connection);
  });

  app.on("before-quit", async (event) => {
    if (!connection) return;
    event.preventDefault();
    await stopSidecar(connection.child);
    connection = null;
    app.exit(0);
  });
}
