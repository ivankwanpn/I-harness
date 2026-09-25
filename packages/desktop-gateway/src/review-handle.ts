import { open, readlink } from "node:fs/promises"

/** The path and bytes belong to the SAME open OS file, not to a mutable name. */
export interface PinnedReviewFile {
  finalPath: string
  read(maxBytes: number): Promise<{ bytes: Buffer; count: number }>
  close(): Promise<void>
}

export async function openPinnedFileForReview(path: string): Promise<PinnedReviewFile> {
  if (process.platform === "win32") {
    const { openWindowsReviewFile } = await import("./review-win32.ts")
    return openWindowsReviewFile(path)
  }
  if (process.platform !== "linux") throw new Error("secure file preview unavailable on this platform")
  const file = await open(path, "r")
  try {
    const finalPath = await readlink(`/proc/self/fd/${file.fd}`)
    const info = await file.stat()
    if (!info.isFile()) throw new Error("review target is not a regular file")
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
      close: () => file.close(),
    }
  } catch (error) {
    await file.close()
    throw error
  }
}
