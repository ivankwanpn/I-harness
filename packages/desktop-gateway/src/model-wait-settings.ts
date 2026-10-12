import { validModelWaitSeconds } from "@i-harness/settings"
import { withDesktopSettings } from "./settings-file.ts"

export function createModelWaitSettings(path: string) {
  return {
    state: () => withDesktopSettings(path, async store => ({ ...store.get().modelWait })),
    async configure(firstResponseSeconds: unknown, progressSeconds: unknown) {
      if (!validModelWaitSeconds(firstResponseSeconds) || !validModelWaitSeconds(progressSeconds)) {
        throw new Error("Model wait deadlines must be 0 (disabled) or an integer from 30 to 3600 seconds")
      }
      return withDesktopSettings(path, async store => {
        const modelWait = { firstResponseSeconds, progressSeconds }
        await store.set({ modelWait })
        return modelWait
      })
    },
  }
}
