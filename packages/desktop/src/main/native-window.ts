import { Notification, screen, type BrowserWindow } from "electron"
import type { DesktopEvent } from "../shared/bridge.ts"
import { createLocalPreferences, restoreBounds, type FollowupDelivery } from "./local-preferences.ts"
import type { TerminalShellChoice } from "../shared/bridge.ts"
import type { createNotificationHistory } from "./notification-history.ts"

export function attachNativeWindow(window: BrowserWindow, preferences: ReturnType<typeof createLocalPreferences>, options: { notifications?: ReturnType<typeof createNotificationHistory>; quitInProgress?: () => boolean } = {}) {
  function windowState() { return { maximized: window.isMaximized(), visible: window.isVisible() && !window.isMinimized() } }
  let savedOnClose = false
  const reopened = () => { savedOnClose = false }
  window.on("restore", reopened)
  window.on("show", reopened)
  function logBoundsFailure(error: unknown) {
    console.warn("Unable to save window preferences", error instanceof Error ? error.message : String(error))
  }
  function captureBounds() {
    if (window.isDestroyed() || (savedOnClose && (!window.isVisible() || window.isMinimized()))) return
    try {
      const bounds = window.getNormalBounds()
      const maximized = window.isMaximized()
      const saved = preferences.get()
      if (saved.maximized !== maximized || !saved.bounds
        || saved.bounds.x !== bounds.x || saved.bounds.y !== bounds.y
        || saved.bounds.width !== bounds.width || saved.bounds.height !== bounds.height) {
        void preferences.update({ bounds, maximized }).catch(logBoundsFailure)
      }
      savedOnClose = true
    }
    catch (error) { logBoundsFailure(error) }
  }
  window.on("close", () => { if (!options.quitInProgress?.()) captureBounds() })
  const seen = new Set<string>()
  return {
    captureBounds,
    windowState,
    onWindowStateChanged(listener: (state: ReturnType<typeof windowState>) => void) {
      let active = true
      const publish = () => { if (active && !window.isDestroyed()) listener(windowState()) }
      window.on("maximize", publish)
      window.on("unmaximize", publish)
      window.on("minimize", publish)
      window.on("restore", publish)
      window.on("show", publish)
      window.on("hide", publish)
      return () => {
        if (!active) return
        active = false
        window.removeListener("maximize", publish)
        window.removeListener("unmaximize", publish)
        window.removeListener("minimize", publish)
        window.removeListener("restore", publish)
        window.removeListener("show", publish)
        window.removeListener("hide", publish)
      }
    },
    state() { const value = preferences.get(); return { notifications: value.notifications, notificationsSupported: Notification.isSupported(), locale: value.locale, terminalShell: value.terminalShell, terminalFontFamily: value.terminalFontFamily, followupDelivery: value.followupDelivery } },
    async configure(patch: { notifications?: boolean; locale?: "zh-TW" | "en"; terminalShell?: TerminalShellChoice; terminalFontFamily?: string; followupDelivery?: FollowupDelivery }) { await preferences.update(patch); return this.state() },
    control(action: "minimize" | "toggle-maximize" | "close") {
      if (action === "minimize") window.minimize()
      else if (action === "toggle-maximize") { if (window.isMaximized()) window.unmaximize(); else window.maximize() }
      else setTimeout(() => { if (!window.isDestroyed()) window.close() }, 0)
      return windowState()
    },
    async resetBounds() {
      if (window.isMaximized()) window.unmaximize()
      const bounds = restoreBounds(undefined, [screen.getPrimaryDisplay().workArea])
      window.setBounds(bounds); await preferences.update({ bounds, maximized: false })
      return { reset: true }
    },
    onEvent(event: DesktopEvent) {
      if (window.isDestroyed()) return
      if (event.kind !== "sdk/notification" || event.method !== "desktop/interaction/request") return
      const request = event.params as { requestId?: unknown; sessionId?: unknown; kind?: unknown }
      if (!request || typeof request.requestId !== "string") return
      const key = `${event.workspaceId}:${request.requestId}`
      if (seen.has(key)) return
      if (typeof request.sessionId === "string") void options.notifications?.record({ id: key, workspaceId: event.workspaceId, sessionId: request.sessionId, kind: request.kind === "question" ? "question" : "approval", summary: preferences.get().locale === "en" ? "A conversation needs your attention." : "有會話等待你的確認或回答。" }).catch(error => console.warn("Unable to save notification history", error instanceof Error ? error.message : String(error)))
      if (window.isFocused() || !preferences.get().notifications || !Notification.isSupported()) return
      seen.add(key)
      if (seen.size > 512) seen.delete(seen.values().next().value!)
      const notification = new Notification({ title: "I-harness", body: preferences.get().locale === "en" ? "A conversation needs your attention." : "有會話等待你的確認或回答。" })
      notification.on("click", () => { if (!window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
      notification.show()
    },
  }
}
