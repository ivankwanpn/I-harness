import type { SpawnOptions } from "./types.ts"

type Factory = NonNullable<SpawnOptions["childShellFactory"]>
type Input = Omit<Parameters<Factory>[0], "retainCleanup">

/** The child already serializes teardown. Keep each original disposer until
 * it succeeds, including when construction fails before publication. */
export function createChildNativeToolMount() {
  const cleanup: (() => Promise<void>)[] = []
  return {
    async mount(factory: Factory, input: Input) {
      let open = true
      try {
        await factory({ ...input, retainCleanup(close) {
          if (!open || typeof close !== "function") throw new Error("Child native tool mount is closed")
          cleanup.push(close)
        } })
      } finally { open = false }
    },
    async close() {
      while (cleanup.length) {
        const close = cleanup[cleanup.length - 1]!
        await close()
        cleanup.pop()
      }
    },
  }
}
