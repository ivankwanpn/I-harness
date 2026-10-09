import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface WebCache {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<boolean>
}
interface Entry { key: string; at: number; value: unknown }
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ENTRY_BYTES = 600_000
const MAX_ENTRIES = 128
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Local, bounded cache. Scope is a trusted workspace identity, never model input.
 * Cache records are external content, not index grants or execution authority. */
export function createWebCache(options: { root?: string; scope?: string } = {}): WebCache {
  const file = options.root ? join(options.root, `${createHash("sha256").update(options.scope ?? "default").digest("hex")}.json`) : undefined
  let entries: Entry[] = []
  let loaded = false
  let tail: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work); tail = result.catch(() => undefined); return result
  }
  async function load() {
    if (loaded) return
    loaded = true
    if (!file) return
    let handle
    try {
      handle = await open(file, "r")
      if ((await handle.stat()).size > MAX_BYTES) return
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_BYTES) return
      const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
      if (!Array.isArray(parsed) || parsed.length > MAX_ENTRIES) return
      entries = parsed.filter((entry): entry is Entry => !!entry && typeof entry === "object"
        && typeof entry.key === "string" && entry.key.length <= 8192 && Number.isFinite(entry.at)
        && Date.now() - entry.at < MAX_AGE_MS && Buffer.byteLength(JSON.stringify(entry)) <= MAX_ENTRY_BYTES)
    } catch { /* Absent, corrupt, or unreadable cache is a cache miss. */ }
    finally { await handle?.close() }
  }
  return {
    get: key => serial(async () => {
      await load()
      const found = entries.find(entry => entry.key === key && Date.now() - entry.at < MAX_AGE_MS)
      return found ? structuredClone(found.value) as never : undefined
    }),
    put: (key, value) => serial(async () => {
      await load()
      if (key.length > 8192) return false
      const entry = {key, at: Date.now(), value: structuredClone(value)}
      if (Buffer.byteLength(JSON.stringify(entry)) > MAX_ENTRY_BYTES) return false
      entries = [...entries.filter(old => old.key !== key && Date.now() - old.at < MAX_AGE_MS), entry].slice(-MAX_ENTRIES)
      while (Buffer.byteLength(JSON.stringify(entries)) > MAX_BYTES) entries.shift()
      if (!file) return true
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await mkdir(options.root!, {recursive: true})
        await writeFile(temporary, JSON.stringify(entries), {flag: "wx", mode: 0o600})
        await rename(temporary, file)
        return true
      } catch { return false }
      finally { await unlink(temporary).catch(() => undefined) }
    }),
  }
}
