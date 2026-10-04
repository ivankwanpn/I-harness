import { create } from "zustand"
import { resolveLocale, type Locale } from "../design/locale.ts"
import type { FollowupDelivery } from "../../main/local-preferences.ts"

export type Appearance = "dark" | "light" | "system"
export type Surface = "conversation" | "memory" | "search" | "settings" | "plugins" | "projects"
interface Preferences { appearance: Appearance; fontSize: number; sidebarCollapsed: boolean; sidebarWidth: number; reviewWidth: number }
const defaults: Preferences = { appearance: "dark", fontSize: 14, sidebarCollapsed: false, sidebarWidth: 240, reviewWidth: 360 }
const boundedWidth = (value: unknown, fallback: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem("ih:ui-preferences") ?? "{}")
    return { appearance: ["dark", "light", "system"].includes(saved?.appearance) ? saved.appearance : "dark",
      fontSize: [13, 14, 16, 18].includes(saved?.fontSize) ? saved.fontSize : 14, sidebarCollapsed: saved?.sidebarCollapsed === true,
      sidebarWidth: boundedWidth(saved?.sidebarWidth, 240, 200, 520), reviewWidth: boundedWidth(saved?.reviewWidth, 360, 280, 1200) }
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
  followupDelivery: FollowupDelivery
  setFollowupDelivery(value: FollowupDelivery): void
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
  setSidebarWidth(width: number): void
  setReviewWidth(width: number): void
  toggleReview(): void
}>((set, get) => ({
  ...readPreferences(),
  // Native local preferences own persistence; this is the renderer's live mirror.
  followupDelivery: "queue",
  setFollowupDelivery: (followupDelivery) => set({ followupDelivery }),
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
    const value = { appearance: get().appearance, fontSize: get().fontSize, sidebarCollapsed: get().sidebarCollapsed, sidebarWidth: get().sidebarWidth, reviewWidth: get().reviewWidth, ...patch }
    value.sidebarWidth = boundedWidth(value.sidebarWidth, 240, 200, 520)
    value.reviewWidth = boundedWidth(value.reviewWidth, 360, 280, 1200)
    try { localStorage.setItem("ih:ui-preferences", JSON.stringify(value)) } catch { /* In-memory preference still applies. */ }
    set(value)
  },
  reset: () => get().update(defaults),
  surface: "conversation",
  providerRevision: 0,
  setSurface: (surface) => set({ surface }),
  reviewOpen: false,
  setSidebarWidth: (sidebarWidth) => get().update({ sidebarWidth }),
  setReviewWidth: (reviewWidth) => get().update({ reviewWidth }),
  toggleReview: () => set((state) => ({ reviewOpen: !state.reviewOpen })),
}))
