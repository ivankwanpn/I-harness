import { useEffect } from "react"
import { useUiStore } from "../shell/ui-store.ts"
import { useLocale } from "./i18n.ts"
export type { Appearance } from "../shell/ui-store.ts"
export const usePreferences = useUiStore
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
