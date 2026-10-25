import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Missing/zero identities remain path-counted; never guess from timestamps. */
export function physicalIdentity(info: { dev: number | bigint; ino: number | bigint }): string | undefined {
  const valid = (n: number | bigint) => typeof n === 'bigint' ? n > 0n : Number.isSafeInteger(n) && n > 0
  return valid(info.dev) && valid(info.ino) ? `${info.dev}:${info.ino}` : undefined
}

/** Physical bytes include managed staging, pins, legacy data and search. */
export async function physicalBytes(root: string): Promise<number> {
  // One tree-wide metadata queue under the existing workspace mutation lock.
  // Listing and stat share32 slots; nested directories never multiply pools.
  // Inventory work remains O(directory entries), including unknown/staged data.
  return new Promise<number>((accept, reject) => {
    type Work = { kind: 'directory' | 'stat'; path: string; initial?: true }
    const work: Work[] = [{ kind: 'directory', path: root, initial: true }]
    let head = 0, active = 0, total = 0, failed = false, failure: unknown
    const inodes = new Set<string>()
    const enqueue = (entry: Work) => { if (!failed) work.push(entry) }
    async function run(entry: Work): Promise<void> {
      if (entry.kind === 'directory') {
        let entries
        try { entries = await readdir(entry.path, { withFileTypes: true }) }
        catch (cause) { if (entry.initial && (cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause }
        for (const child of entries) enqueue({ kind: 'stat', path: resolve(entry.path, child.name) })
        return
      }
      const info = await lstat(entry.path, { bigint: true })
      if (info.isSymbolicLink()) throw new Error('Artifact path unavailable')
      if (info.isDirectory()) enqueue({ kind: 'directory', path: entry.path })
      else {
        const key = physicalIdentity(info)
        if (key && inodes.has(key)) return
        if (key) inodes.add(key)
        if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Artifact disk accounting overflow')
        total += Number(info.size)
        if (!Number.isSafeInteger(total)) throw new Error('Artifact disk accounting overflow')
      }
    }
    function pump(): void {
      while (!failed && active < 32 && head < work.length) {
        const entry = work[head++]!
        active++
        void run(entry).catch(cause => { if (!failed) { failed = true; failure = cause } }).finally(() => {
          active--
          // A failed scan cannot admit another operation. Join every already
          // started native I/O before exposing the failure to its quota caller.
          if (failed) { if (active === 0) reject(failure); return }
          if (head >= 1024 && head > work.length / 2) { work.splice(0, head); head = 0 }
          if (head === work.length && active === 0) accept(total)
          else pump()
        })
      }
    }
    pump()
  })
}
export async function requireSpace(root: string, quota: number, growth: number): Promise<void> {
  if (!Number.isSafeInteger(growth) || growth < 0 || !Number.isSafeInteger(quota) || quota < 1) throw new Error('Invalid artifact quota')
  const total = await physicalBytes(root)
  if (!Number.isSafeInteger(total + growth) || total + growth > quota) throw Object.assign(new Error('Artifact disk quota exceeded'), { code: 'ARTIFACT_QUOTA' })
}
