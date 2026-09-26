import { create } from "zustand"
import { resolveLocale, type Locale } from "../design/locale.ts"

export type Appearance = "dark" | "light" | "system"
export type Surface = "conversation" | "memory" | "search" | "settings" | "plugins"
interface Preferences { appearance: Appearance; fontSize: number; sidebarCollapsed: boolean }
const defaults: Preferences = { appearance: "dark", fontSize: 14, sidebarCollapsed: false }
function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem("ih:ui-preferences") ?? "{}")
    return { appearance: ["dark", "light", "system"].includes(saved?.appearance) ? saved.appearance : "dark",
      fontSize: [13, 14, 16, 18].includes(saved?.fontSize) ? saved.fontSize : 14, sidebarCollapsed: saved?.sidebarCollapsed === true }
  } catch { return defaults }
}
function readLocale(): Locale {
  let saved: string | null = null
  try { saved = localStorage.getItem("ih:locale") } catch { /* Fall back to the system locale. */ }
  return resolveLocale(saved, typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language])
}

// UI state only. SDK state remains owned by the renderer data layer.
export const useUiStore = create<Preferences & {
  providerRevision: number
  selectedWorkspaceId?: string
  selectedSessionId?: string
  setSelectedWorkspaceId(value: string | undefined | ((current: string | undefined) => string | undefined)): void
  setSelectedSessionId(value: string | undefined): void
  locale: Locale
  setLocale(locale: Locale): void
  update(patch: Partial<Preferences>): void
  reset(): void
  surface: Surface
  setSurface(surface: Surface): void
  reviewOpen: boolean
  reviewWidth: number
  setReviewWidth(width: number): void
  toggleReview(): void
}>((set, get) => ({
  ...readPreferences(),
  selectedWorkspaceId: undefined,
  selectedSessionId: undefined,
  setSelectedWorkspaceId: (value) => set((state) => ({ selectedWorkspaceId: typeof value === "function" ? value(state.selectedWorkspaceId) : value })),
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  locale: readLocale(),
  setLocale: (locale) => {
    try { localStorage.setItem("ih:locale", locale) } catch { /* In-memory preference still applies. */ }
    document.documentElement.lang = locale
    set({ locale })
  },
  update: (patch) => {
    const value = { appearance: get().appearance, fontSize: get().fontSize, sidebarCollapsed: get().sidebarCollapsed, ...patch }
    try { localStorage.setItem("ih:ui-preferences", JSON.stringify(value)) } catch { /* In-memory preference still applies. */ }
    set(value)
  },
  reset: () => get().update(defaults),
  surface: "conversation",
  providerRevision: 0,
  setSurface: (surface) => set({ surface }),
  reviewOpen: false,
  reviewWidth: 360,
  setReviewWidth: (width) => set({ reviewWidth: Math.min(640, Math.max(280, Math.round(width))) }),
  toggleReview: () => set((state) => ({ reviewOpen: !state.reviewOpen })),
}))
