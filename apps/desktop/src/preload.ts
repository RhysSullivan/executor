import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  selectScope: () => ipcRenderer.invoke("select-scope"),
  getCurrentScope: () => ipcRenderer.invoke("get-current-scope"),
  getRecentScopes: () => ipcRenderer.invoke("get-recent-scopes"),
  switchScope: (scopePath: string) => ipcRenderer.invoke("switch-scope", scopePath),
});
