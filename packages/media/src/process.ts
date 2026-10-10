import { spawn } from "node:child_process"

/** Bounded binary stdout, bounded diagnostics, and cancellation without a shell. */
export function runMediaProcess(executable: string, args: string[], options: { maxBytes: number; timeoutMs: number; signal?: AbortSignal }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error("Video reading cancelled")); return }
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let bytes = 0, diagnostic = "", failure: Error | undefined, settled = false
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL") }
    const abort = () => stop(new Error("Video reading cancelled"))
    const timer = setTimeout(() => stop(new Error("Video decoder exceeded its time limit")), options.timeoutMs)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort)
      if (error) reject(error); else resolve(Buffer.concat(chunks, bytes))
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return
      bytes += chunk.length
      if (bytes > options.maxBytes) { stop(new Error("Video decoder output exceeded its byte limit")); return }
      chunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => { if (diagnostic.length < 2048) diagnostic += chunk.toString("utf8").slice(0, 2048 - diagnostic.length) })
    child.once("error", (error) => finish(new Error(`Video decoder could not start: ${error.message}`)))
    child.once("close", (code) => finish(failure ?? (code !== 0 ? new Error(`Video decoder failed (${code}): ${diagnostic.trim()}`) : undefined)))
  })
}
