import type { BrowserWindow } from "electron"

export type DesktopQuitState = "running" | "draining" | "ready"

/** Dismiss the window immediately, then let the host decide whether to exit.
 * A tray click, notification or taskbar restore supersedes the close request. */
export function attachCloseLifecycle(window: BrowserWindow, options: {
  hasActiveWork(): Promise<boolean>
  trayAvailable(): boolean
  quitState(): DesktopQuitState
}): () => void {
  let pending: object | undefined
  let allowingClose = false
  const cancel = () => { pending = undefined }
  window.on("restore", cancel)
  window.on("show", cancel)
  window.on("close", (event) => {
    const quit = options.quitState()
    if (quit === "ready" || allowingClose) return
    event.preventDefault()
    if (quit === "draining" || pending) return
    const request = pending = {}
    try {
      if (options.trayAvailable()) window.hide()
      else window.minimize()
    } catch (error) { console.warn("Could not dismiss the workbench window.", error) }
    void Promise.resolve().then(() => options.hasActiveWork()).catch(() => true).then((active) => {
      if (request !== pending) return
      pending = undefined
      if (active || window.isDestroyed() || options.quitState() !== "running") return
      allowingClose = true
      try { window.close() }
      catch (error) { console.warn("Could not close the idle workbench window.", error) }
      finally { allowingClose = false }
    })
  })
  return cancel
}
