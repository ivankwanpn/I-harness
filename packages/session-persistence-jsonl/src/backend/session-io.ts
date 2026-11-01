import { open, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import type { SessionEvent } from "@i-harness/core-session"
import { createOwnedDocumentWrite } from './document-write.ts'

/** Both modes belong to the original session creation owner. The legacy mode
 * retains its existing void behavior; the held mode retains its exact candidate. */
export function createSessionFile(path: string, bytes: string) {
  return writeFile(path, bytes, { flag: 'wx' })
}
export function stageOwnedSessionFile(path: string, bytes: Uint8Array, guard: () => void, verifyRoot: () => Promise<void>, preimage?: { bytes: Uint8Array; identity: { dev: bigint; ino: bigint } }) {
  return createOwnedDocumentWrite({ path, bytes, guard, verifyRoot, preimage, maxBytes: null })
}
export async function replaceSessionFile(path: string, headerLine: string, events: SessionEvent[]): Promise<void> {
  const body = [headerLine, ...events.map((event) => JSON.stringify(event)), ""].join("\n")
  await replaceRawSessionFile(path, body)
}

export async function replaceRawSessionFile(path: string, body: string | Buffer): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  const handle = await open(tmp, "wx")
  try {
    await handle.writeFile(body, { encoding: "utf-8" })
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw error
  }
  await handle.close()
  try {
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  // Directory fsync is not supported uniformly on Windows. Best-effort keeps
  // the stronger durability path on platforms/filesystems that allow it.
  const directory = await open(dirname(path), "r").catch(() => undefined)
  if (directory !== undefined) {
    try { await directory.sync() } catch { /* best-effort */ }
    await directory.close().catch(() => {})
  }
}

