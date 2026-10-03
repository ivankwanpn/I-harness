import { readFileSync } from "node:fs"
import { withDesktopSettings } from "./settings-file.ts"

/** Reads at the next title operation. Corrupt preferences cannot opt into inference. */
export function createAutoTitleSettings(path: string) {
  function enabled(): boolean {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
      return !!raw && typeof raw === "object" && !Array.isArray(raw)
        && ((raw as { autoTitle?: unknown }).autoTitle === undefined || (raw as { autoTitle?: unknown }).autoTitle === true)
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" }
  }
  return {
    enabled,
    state: () => ({ enabled: enabled() }),
    async configure(autoTitle: unknown) {
      if (typeof autoTitle !== "boolean") throw new Error("Invalid auto-title preference")
      return withDesktopSettings(path, async store => { await store.set({ autoTitle }); return { enabled: autoTitle } })
    },
  }
}
