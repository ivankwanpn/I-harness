import type { BrowserWindow } from "electron"

/** Keep the close event synchronous while the SDK decides whether the host is
 * safe to stop. Unknown state follows the same retain path as active work. */
export function attachCloseLifecycle(window: BrowserWindow, options: {
  hasActiveWork(): Promise<boolean>
  trayAvailable(): boolean
  isQuitting(): boolean
}): void {
  let deciding = false
  let allowingClose = false
  window.on("close", (event) => {
    if (options.isQuitting() || allowingClose) return
    event.preventDefault()
    if (deciding) return
    deciding = true
    void Promise.resolve().then(() => options.hasActiveWork()).catch(() => true).then((active) => {
      if (options.isQuitting() || window.isDestroyed()) return
      if (!active) {
        allowingClose = true
        window.close()
        return
      }
      if (options.trayAvailable()) window.hide()
      else window.minimize()
    }).catch(() => {
      if (!options.isQuitting() && !window.isDestroyed()) window.minimize()
    }).finally(() => { deciding = false })
  })
}
