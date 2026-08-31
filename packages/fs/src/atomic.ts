import { rename, writeFile, mkdir } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname, join, basename } from "node:path"

// 同目錄 temp + rename（POSIX 原子；Windows NTFS rename 同目錄亦原子）。
// `mode`（可選）會套用在 temp 檔案上（rename 後一樣繼承），因此密碼檔的
// temp 視窗與 rename 後視窗都不會鬆於 0o600——win32 上 mode 由 Node 忽略
//（最好努力，Windows ACL 生效）。
export async function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    await writeFile(tmp, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode })
    await rename(tmp, path)
  } catch (err) {
    await import("node:fs/promises").then((m) => m.unlink(tmp)).catch(() => {})
    throw err
  }
}
