import { Notification, screen, shell, type BrowserWindow } from "electron"
import { DESKTOP_EVENT_CHANNEL, type DesktopEvent } from "../shared/bridge.ts"
import type { NotificationRuleChange } from "../shared/notification-preferences.ts"
import { notificationSummary, notificationTarget } from "./notification-event.ts"
import { createLocalPreferences, restoreBounds, type FollowupDelivery } from "./local-preferences.ts"
import type { TerminalShellChoice } from "../shared/bridge.ts"
import type { createNotificationHistory } from "./notification-history.ts"

export function attachNativeWindow(window: BrowserWindow, preferences: ReturnType<typeof createLocalPreferences>, options: {
  notifications?: ReturnType<typeof createNotificationHistory>
  executionBusy?: (workspaceId: string, sessionId: string) => boolean
  quitInProgress?: () => boolean
} = {}) {
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
  function send(event: DesktopEvent) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(DESKTOP_EVENT_CHANNEL, event)
  }
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
    state() { const value = preferences.get(); return { notifications: value.notifications, notificationRules: value.notificationRules, notificationsSupported: Notification.isSupported(), locale: value.locale, terminalShell: value.terminalShell, terminalFontFamily: value.terminalFontFamily, followupDelivery: value.followupDelivery } },
    async configure(patch: { notifications?: boolean; notificationRule?: NotificationRuleChange; locale?: "zh-TW" | "en"; terminalShell?: TerminalShellChoice; terminalFontFamily?: string; followupDelivery?: FollowupDelivery }) { await preferences.update(patch); return this.state() },
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
      const target = notificationTarget(event, options.executionBusy)
      if (!target || seen.has(target.id)) return
      const { id, workspaceId, sessionId, kind } = target
      const saved = preferences.get()
      const rule = saved.notificationRules[kind]
      const alert = saved.notifications && (rule.enabled || rule.sound === "system")
      const summary = notificationSummary(kind, saved.locale)
      if (sessionId && (kind === "question" || kind === "approval" || alert)) {
        void options.notifications?.record({ id, workspaceId, sessionId, kind, summary })
          .then(() => send({ kind: "notifications/changed" }))
          .catch(error => console.warn("Unable to save notification history", error instanceof Error ? error.message : String(error)))
      }
      if (!alert || window.isFocused() || !Notification.isSupported()) return
      seen.add(id)
      if (seen.size > 512) seen.delete(seen.values().next().value!)
      if (!rule.enabled) { shell.beep(); return }
      const notification = new Notification({ title: "I-harness", body: summary, ...(rule.sound === "off" ? { silent: true } : {}) })
      notification.on("click", () => {
        if (window.isDestroyed() || options.quitInProgress?.()) return
        if (window.isMinimized()) window.restore()
        window.show(); window.focus()
        if (sessionId) send({ kind: "notifications/open", id, workspaceId, sessionId })
      })
      notification.show()
    },
  }
}
