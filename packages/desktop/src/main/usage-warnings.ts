import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import type { DesktopEvent } from "../shared/bridge.ts"

const incomplete = "Some requests could not be fully recorded. Historical usage statistics may be incomplete."
const unavailable = "Usage recording diagnostics are unavailable; historical completeness cannot be verified."

/** Native app-wide diagnostic bit. Never persists gateway event contents. */
export function createUsageWarnings(path: string) {
  let observed = false
  let pending = Promise.resolve()
  return {
    observe(event: DesktopEvent) {
      if (event.kind !== "sdk/notification" || event.method !== "desktop/usage/recording-warning" || observed) return
      observed = true
      pending = (async () => {
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(temporary, JSON.stringify({ version: 1, incomplete: true }), { flag: "wx", mode: 0o600 })
          await rename(temporary, path)
        } finally { await unlink(temporary).catch(() => {}) }
      })().catch(() => { /* The in-memory diagnostic remains visible even on a full/read-only disk. */ })
    },
    async read(): Promise<string[]> {
      if (observed) return [incomplete]
      try {
        const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; incomplete?: unknown }
        if (value?.version !== 1 || value.incomplete !== true) return [unavailable]
        return [incomplete]
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : [unavailable]
      }
    },
    async flush() { await pending },
  }
}
