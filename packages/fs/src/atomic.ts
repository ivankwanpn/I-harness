import { rename, writeFile, mkdir } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname, join, basename } from "node:path"

// 同目錄 temp + rename（POSIX 原子；Windows NTFS rename 同目錄亦原子）。
export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    await writeFile(tmp, content, "utf-8")
    await rename(tmp, path)
  } catch (err) {
    await import("node:fs/promises").then((m) => m.unlink(tmp)).catch(() => {})
    throw err
  }
}
