import { readFileSync } from "node:fs"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import type { TerminalShellChoice } from "../shared/bridge.ts"
import { parseNotificationRuleChange, readNotificationRules, type NotificationRuleChange, type NotificationRules } from "../shared/notification-preferences.ts"
export interface WindowBounds { x: number; y: number; width: number; height: number }
export type FollowupDelivery = "queue" | "steer"
export interface LocalPreferences { notifications: boolean; notificationRules: NotificationRules; locale: "zh-TW" | "en"; terminalShell: TerminalShellChoice; terminalFontFamily: string; followupDelivery: FollowupDelivery; bounds?: WindowBounds; maximized?: boolean }
const SHELL_CHOICES = new Set<TerminalShellChoice>(["auto", "git-bash", "pwsh", "powershell", "cmd", "bash", "zsh", "sh"])
function validBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return ["x", "y", "width", "height"].every((key) => typeof row[key] === "number" && Number.isInteger(row[key])) && (row.width as number) >= 640 && (row.height as number) >= 480
}
export function restoreBounds(saved: WindowBounds | undefined, displays: WindowBounds[]): WindowBounds {
  if (!validBounds(saved)) saved = undefined
  const primary = displays[0] ?? { x: 0, y: 0, width: 1340, height: 860 }
  const target = saved && validBounds(saved) ? displays.find((area) => saved.x < area.x + area.width && saved.x + saved.width > area.x && saved.y < area.y + area.height && saved.y + saved.height > area.y) ?? primary : primary
  const width = Math.min(target.width, Math.max(640, saved?.width ?? 1340))
  const height = Math.min(target.height, Math.max(480, saved?.height ?? 860))
  return { width, height,
    x: Math.round(Math.min(target.x + target.width - width, Math.max(target.x, saved?.x ?? target.x + (target.width - width) / 2))),
    y: Math.round(Math.min(target.y + target.height - height, Math.max(target.y, saved?.y ?? target.y + (target.height - height) / 2))) }
}
export function createLocalPreferences(file: string) {
  let state: LocalPreferences = { notifications: false, notificationRules: readNotificationRules(), locale: "zh-TW", terminalShell: "auto", terminalFontFamily: "", followupDelivery: "queue" }
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"))
    state = { notifications: saved?.notifications === true, notificationRules: readNotificationRules(saved?.notificationRules), locale: saved?.locale === "en" ? "en" : "zh-TW",
      terminalShell: SHELL_CHOICES.has(saved?.terminalShell) ? saved.terminalShell : "auto",
      terminalFontFamily: typeof saved?.terminalFontFamily === "string" && saved.terminalFontFamily.length <= 128 && !/[\u0000-\u001f\u007f]/.test(saved.terminalFontFamily) ? saved.terminalFontFamily.trim() : "",
      followupDelivery: saved?.followupDelivery === "steer" ? "steer" : "queue",
      ...(validBounds(saved?.bounds) ? { bounds: saved.bounds } : {}), maximized: saved?.maximized === true }
  } catch { /* A missing or damaged UI preference file uses defaults. */ }
  const get = (): LocalPreferences => ({ ...state, notificationRules: readNotificationRules(state.notificationRules), ...(state.bounds ? { bounds: { ...state.bounds } } : {}) })
  let tail = Promise.resolve()
  return {
    get,
    update({ notificationRule, ...patch }: Partial<Omit<LocalPreferences, "notificationRules">> & { notificationRule?: NotificationRuleChange }): Promise<LocalPreferences> {
      const rule = notificationRule === undefined ? undefined : parseNotificationRuleChange(notificationRule)
      if (patch.followupDelivery !== undefined && patch.followupDelivery !== "queue" && patch.followupDelivery !== "steer") throw new Error("Invalid follow-up delivery preference")
      const change = { ...patch, ...(patch.bounds ? { bounds: { ...patch.bounds } } : {}) }
      const write = tail.then(async () => {
        const next = { ...state, ...change, followupDelivery: change.followupDelivery ?? state.followupDelivery }
        if (rule) {
          const { event, ...fields } = rule
          next.notificationRules = { ...state.notificationRules, [event]: { ...state.notificationRules[event], ...fields } }
        }
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.${randomUUID()}.tmp`
        const handle = await open(temp, "wx")
        try {
          try { await handle.writeFile(JSON.stringify(next), "utf8") }
          finally { await handle.close() }
          await rename(temp, file)
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {})
          throw error
        }
        state = next
        return get()
      })
      tail = write.then(() => {}, () => {})
      return write
    },
    async flush() {
      let current
      do { current = tail; await current } while (current !== tail)
    },
  }
}
