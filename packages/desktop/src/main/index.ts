import { app, BrowserWindow } from "electron"
import { createDesktopWindow } from "./window.ts"

app.whenReady().then(() => {
  createDesktopWindow()
  app.on("activate", () => {
    if (process.platform === "darwin" && BrowserWindow.getAllWindows().length === 0) createDesktopWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
