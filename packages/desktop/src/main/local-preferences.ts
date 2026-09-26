import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
export interface WindowBounds { x: number; y: number; width: number; height: number }
export interface LocalPreferences { notifications: boolean; locale: "zh-TW" | "en"; bounds?: WindowBounds; maximized?: boolean }
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
  let state: LocalPreferences = { notifications: false, locale: "zh-TW" }
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"))
    state = { notifications: saved?.notifications === true, locale: saved?.locale === "en" ? "en" : "zh-TW",
      ...(validBounds(saved?.bounds) ? { bounds: saved.bounds } : {}), maximized: saved?.maximized === true }
  } catch { /* A missing or damaged UI preference file uses defaults. */ }
  return {
    get: (): LocalPreferences => ({ ...state, ...(state.bounds ? { bounds: { ...state.bounds } } : {}) }),
    update(patch: Partial<LocalPreferences>): LocalPreferences {
      const next = { ...state, ...patch }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(next), "utf8")
      renameSync(`${file}.tmp`, file)
      state = next
      return { ...state }
    },
  }
}
