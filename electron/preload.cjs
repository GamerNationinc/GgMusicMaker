// The only bridge between the page and the OS (see main.cjs). Everything the
// page can do natively is listed here; src/state/platform.ts is its client.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ggmmNative", {
  saveFile: (bytes, defaultName, filters, path) => ipcRenderer.invoke("save-file", { bytes, defaultName, filters, path }),
  openFile: (filters) => ipcRenderer.invoke("open-file", { filters }),
  confirm: (message, title) => ipcRenderer.invoke("confirm", { message, title }),
  appInfo: () => ipcRenderer.invoke("app-info"),
  /** `handler` resolves true to let the window close. */
  onCloseRequested: (handler) => {
    ipcRenderer.on("close-requested", async () => {
      if (await handler()) ipcRenderer.send("close-ok");
    });
  },
});
