import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises"
import { dirname } from "node:path"
import { InstructionMigrationError, instructionDocumentHash } from "./instruction-migration.ts"

/** One store owns the whole read/stage/write/publish operation, including failed writes. */
export class SettingsWriteQueue {
  private tail: Promise<void> = Promise.resolve()
  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation)
    this.tail = next.then(() => {}, () => {})
    return next
  }
  drain(): Promise<void> { return this.tail }
}

/** The digest recheck detects foreign changes, but is not filesystem CAS: hosts
 * must exclusively own migration. A foreign last-rename after this check can win. */
export async function writeSettingsDocument(path: string, text: string, expectedHash?: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  let handle: FileHandle | undefined
  let owned = false
  try {
    await mkdir(dirname(path), { recursive: true })
    handle = await open(tmp, "wx")
    owned = true
    await writeFile(handle, text, "utf8")
    await handle.close()
    handle = undefined
    // Windows rejects replacement while even our own readFile handle is open.
    // Keep the same completed stage and retry only that native sharing window;
    // never truncate the live document or repeat its higher-level mutation.
    const deadline = performance.now() + 500
    let delayMs = 10
    for (;;) {
      if (expectedHash !== undefined) {
        const current = await readFile(path).catch(() => undefined)
        if (current === undefined || instructionDocumentHash(current) !== expectedHash.toLowerCase()) {
          throw new InstructionMigrationError("conflict", "profile changed before legacy import rename")
        }
      }
      try {
        await rename(tmp, path)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        const remaining = deadline - performance.now()
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(code ?? '') || remaining <= 0) throw error
        await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remaining)))
        if (performance.now() >= deadline) throw error
        delayMs = Math.min(delayMs * 2, 50)
      }
    }
  } catch (error) {
    if (expectedHash !== undefined && !(error instanceof InstructionMigrationError)) {
      throw new InstructionMigrationError("write-failed", `cannot commit legacy import: ${String(error)}`)
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
    if (owned) await unlink(tmp).catch(() => {})
  }
}
