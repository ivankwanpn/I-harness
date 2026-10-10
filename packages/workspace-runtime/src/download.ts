import { createHash } from "node:crypto"
import { NODE_PIN, MAX_ARCHIVE_BYTES } from "./pin.ts"

export function verifyArchiveDigest(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Managed runtime download limit exceeded")
  if (createHash("sha256").update(bytes).digest("hex") !== NODE_PIN.sha256) throw new Error("Managed runtime archive digest mismatch")
}
/** Fixed official source, no credentials or redirects, finite time and byte caps. */
export async function downloadNodeArchive(fetcher: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  const stop = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
  const response = await fetcher(NODE_PIN.url, { redirect: "error", signal: stop, credentials: "omit" })
  if (!response.ok || !response.body) throw new Error(`Official Node archive download failed (${response.status})`)
  const length = response.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ARCHIVE_BYTES)) {
    await response.body.cancel(); throw new Error("Managed runtime download limit exceeded")
  }
  const reader = response.body.getReader(), chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      stop.throwIfAborted()
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_ARCHIVE_BYTES) throw new Error("Managed runtime download limit exceeded")
      chunks.push(Buffer.from(result.value))
    }
  } catch (cause) { await reader.cancel().catch(() => {}); throw cause }
  finally { reader.releaseLock() }
  const bytes = Buffer.concat(chunks, size)
  verifyArchiveDigest(bytes)
  return bytes
}
