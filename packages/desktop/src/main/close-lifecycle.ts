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
  let retry: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { clearTimeout(retry); retry = undefined; pending = undefined }
  async function inspect(request: object) {
    if (pending !== request || window.isDestroyed() || options.quitState() !== "running") return
    let active = true
    try { active = await options.hasActiveWork() }
    catch { /* Retain the host until its owners can confirm it is idle. */ }
    if (pending !== request || window.isDestroyed() || options.quitState() !== "running") return
    if (active) {
      // Only a dismissed window with an outstanding close request rechecks.
      // A turn can be visible in history before its input finalizers settle.
      retry = setTimeout(() => { retry = undefined; void inspect(request) }, 3000)
      retry.unref()
      return
    }
    pending = undefined
    allowingClose = true
    try { window.close() }
    catch (error) { console.warn("Could not close the idle workbench window.", error) }
    finally { allowingClose = false }
  }
  window.on("restore", cancel)
  window.on("show", cancel)
  window.on("closed", cancel)
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
    void inspect(request)
  })
  return cancel
}
