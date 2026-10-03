import { Worker } from "node:worker_threads"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { DocumentSnapshot } from "./attachment-reader-core.ts"
// Keep this main adapter free of raw parser imports; Electron externalizes
// production packages. Parser dependencies are bundled into the shipped worker.
export { documentFormat, READER_LIMITS } from "./attachment-reader-format.ts"
const workerPath = () => {
  const directory = dirname(fileURLToPath(import.meta.url))
  return directory.endsWith("main") && directory.includes(`${process.platform === "win32" ? "\\" : "/"}src${process.platform === "win32" ? "\\" : "/"}`)
    ? join(directory, "../..", "out/main/attachment-reader-worker.mjs") : join(directory, "attachment-reader-worker.mjs")
}
export function readDocumentSnapshot(bytes: Buffer, format: string, path = workerPath()): Promise<DocumentSnapshot> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path, { workerData: { bytes: new Uint8Array(bytes), format }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } })
    let settled = false
    const finish = (error?: Error, result?: DocumentSnapshot) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); if (error) reject(error); else resolve(result!) }
    const timer = setTimeout(() => finish(new Error("Attachment parsing exceeded the 15 second time limit")), 15_000)
    worker.once("message", (message: { result?: DocumentSnapshot; error?: string }) => {
      if (message.error) finish(new Error(message.error))
      else if (!message.result || typeof message.result.text !== "string" || Buffer.byteLength(message.result.text) > 32 * 1024) finish(new Error("Invalid attachment reader output"))
      else finish(undefined, message.result)
    })
    worker.once("error", (error) => finish(new Error(`Attachment reader failed: ${error.message}`)))
    worker.once("exit", (code) => { if (!settled) finish(new Error(`Attachment reader exited before producing a snapshot (${code})`)) })
  })
}
