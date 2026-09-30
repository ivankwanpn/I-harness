import { open, readlink } from "node:fs/promises"
import type { PinnedReviewFile } from "./review-handle.ts"

export interface PinnedEditableFile extends PinnedReviewFile {
  write(bytes: Buffer): Promise<void>
}

/** Keep containment checks and writes on the same open regular file. */
export async function openPinnedFileForEdit(path: string): Promise<PinnedEditableFile> {
  if (process.platform === "win32") {
    const { openWindowsEditableFile } = await import("./review-edit-win32.ts")
    return openWindowsEditableFile(path)
  }
  if (process.platform !== "linux") throw new Error("secure file editing unavailable on this platform")
  const file = await open(path, "r+")
  try {
    const finalPath = await readlink(`/proc/self/fd/${file.fd}`)
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error("edit target must be a regular file with one link")
    return {
      finalPath,
      async read(maxBytes) {
        const bytes = Buffer.alloc(maxBytes)
        let count = 0
        while (count < bytes.length) {
          const result = await file.read(bytes, count, bytes.length - count, count)
          if (result.bytesRead === 0) break
          count += result.bytesRead
        }
        return { bytes: bytes.subarray(0, count), count }
      },
      async write(bytes) {
        let offset = 0
        while (offset < bytes.length) {
          const result = await file.write(bytes, offset, bytes.length - offset, offset)
          if (result.bytesWritten === 0) throw new Error("file save made no progress")
          offset += result.bytesWritten
        }
        await file.truncate(bytes.length)
        await file.sync()
      },
      close: () => file.close(),
    }
  } catch (error) { await file.close(); throw error }
}
