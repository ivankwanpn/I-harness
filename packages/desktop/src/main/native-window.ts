import { Notification, screen, type BrowserWindow } from "electron"
import type { DesktopEvent } from "../shared/bridge.ts"
import { createLocalPreferences, restoreBounds, type FollowupDelivery } from "./local-preferences.ts"
import type { TerminalShellChoice } from "../shared/bridge.ts"

export function attachNativeWindow(window: BrowserWindow, preferences: ReturnType<typeof createLocalPreferences>) {
  window.on("close", () => {
    try { preferences.update({ bounds: window.getNormalBounds(), maximized: window.isMaximized() }) }
    catch (error) { console.warn("Unable to save window preferences", error instanceof Error ? error.message : String(error)) }
  })
  const seen = new Set<string>()
  return {
    state() { const value = preferences.get(); return { notifications: value.notifications, notificationsSupported: Notification.isSupported(), locale: value.locale, terminalShell: value.terminalShell, terminalFontFamily: value.terminalFontFamily, followupDelivery: value.followupDelivery } },
    configure(patch: { notifications?: boolean; locale?: "zh-TW" | "en"; terminalShell?: TerminalShellChoice; terminalFontFamily?: string; followupDelivery?: FollowupDelivery }) { preferences.update(patch); return this.state() },
    control(action: "minimize" | "toggle-maximize" | "close") {
      if (action === "minimize") window.minimize()
      else if (action === "toggle-maximize") { if (window.isMaximized()) window.unmaximize(); else window.maximize() }
      else setTimeout(() => { if (!window.isDestroyed()) window.close() }, 0)
      return { maximized: window.isMaximized() }
    },
    resetBounds() {
      if (window.isMaximized()) window.unmaximize()
      const bounds = restoreBounds(undefined, [screen.getPrimaryDisplay().workArea])
      window.setBounds(bounds); preferences.update({ bounds, maximized: false })
      return { reset: true }
    },
    onEvent(event: DesktopEvent) {
      if (window.isDestroyed() || window.isFocused() || !preferences.get().notifications || !Notification.isSupported()) return
      if (event.kind !== "sdk/notification" || event.method !== "desktop/interaction/request") return
      const request = event.params as { requestId?: unknown }
      if (!request || typeof request.requestId !== "string") return
      const key = `${event.workspaceId}:${request.requestId}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 512) seen.delete(seen.values().next().value!)
      const notification = new Notification({ title: "I-harness Desktop", body: preferences.get().locale === "en" ? "A conversation needs your attention." : "有會話等待你的確認或回答。" })
      notification.on("click", () => { if (!window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
      notification.show()
    },
  }
}
