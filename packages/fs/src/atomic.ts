import { rename, writeFile, mkdir, stat } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname, join, basename } from "node:path"
import type { NativeBoundary } from '@i-harness/core-tools'

// 同目錄 temp + rename（POSIX 原子；Windows NTFS rename 同目錄亦原子）。
// `mode`（可選）會套用在 temp 檔案上（rename 後一樣繼承），因此密碼檔的
// temp 視窗與 rename 後視窗都不會鬆於 0o600——win32 上 mode 由 Node 忽略
//（最好努力，Windows ACL 生效）。
export async function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  mode?: number,
  before?: (boundary: NativeBoundary) => void,
): Promise<void> {
  before?.({ target: path, operation: 'mkdir' })
  await mkdir(dirname(path), { recursive: true })
  // The destination's permission bits must survive the replace: a fresh temp
  // file would otherwise drop 0755 (and setuid/setgid) on every edit.
  const effectiveMode = mode ?? await stat(path).then((s) => s.mode & 0o7777).catch(() => undefined)
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    before?.({ target: path, operation: 'temp-write' })
    await writeFile(tmp, content, effectiveMode === undefined ? "utf-8" : { encoding: "utf-8", mode: effectiveMode })
    before?.({ target: path, operation: 'rename' })
    await rename(tmp, path)
  } catch (err) {
    await import("node:fs/promises").then((m) => m.unlink(tmp)).catch(() => {})
    throw err
  }
}
