import { parentPort, workerData } from "node:worker_threads"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDocument } from "./attachment-reader-core.ts"
// This worker accepts byte data only. It never receives a selected path or URL.
void parseDocument(workerData.bytes, workerData.format, dirname(fileURLToPath(import.meta.url))).then(
  (result) => parentPort?.postMessage({ result }),
  (error) => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }),
)
