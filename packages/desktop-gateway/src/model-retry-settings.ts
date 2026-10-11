import { withDesktopSettings } from "./settings-file.ts"

export function createModelRetrySettings(path: string) {
  return {
    state: () => withDesktopSettings(path, async store => ({ maxRetries: store.get().modelRetryLimit })),
    async configure(maxRetries: unknown) {
      if (typeof maxRetries !== "number" || !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 100) {
        throw new Error("Model retry limit must be an integer from 0 to 100")
      }
      return withDesktopSettings(path, async store => {
        await store.set({ modelRetryLimit: maxRetries })
        return { maxRetries }
      })
    },
  }
}
