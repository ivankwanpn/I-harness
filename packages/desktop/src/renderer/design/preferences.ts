import { useEffect } from "react"
import { create } from "zustand"
import { useLocale } from "./i18n.ts"
export type Appearance = "dark" | "light" | "system"
interface Preferences { appearance: Appearance; fontSize: number; sidebarCollapsed: boolean }
const defaults: Preferences = { appearance: "dark", fontSize: 14, sidebarCollapsed: false }
function read(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem("ih:ui-preferences") ?? "{}")
    return { appearance: ["dark", "light", "system"].includes(saved?.appearance) ? saved.appearance : "dark",
      fontSize: [13, 14, 16, 18].includes(saved?.fontSize) ? saved.fontSize : 14,
      sidebarCollapsed: saved?.sidebarCollapsed === true }
  } catch { return defaults }
}
export const usePreferences = create<Preferences & { update(patch: Partial<Preferences>): void; reset(): void }>((set, get) => ({
  ...read(),
  update: (patch) => {
    const value = { appearance: get().appearance, fontSize: get().fontSize, sidebarCollapsed: get().sidebarCollapsed, ...patch }
    try { localStorage.setItem("ih:ui-preferences", JSON.stringify(value)) } catch { /* Memory remains available. */ }
    set(value)
  },
  reset: () => get().update(defaults),
}))
export function useAppearance() {
  const locale = useLocale((state) => state.locale)
  const appearance = usePreferences((state) => state.appearance)
  const fontSize = usePreferences((state) => state.fontSize)
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)")
    const apply = () => {
      document.documentElement.lang = locale
      document.documentElement.dataset.theme = appearance === "system" ? media?.matches ? "dark" : "light" : appearance
      document.documentElement.style.setProperty("--ui-font-size", `${fontSize}px`)
    }
    apply(); media?.addEventListener("change", apply)
    return () => media?.removeEventListener("change", apply)
  }, [appearance, fontSize, locale])
}
