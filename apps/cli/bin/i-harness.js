#!/usr/bin/env node
// M44: the global-command shim. `i-harness` / `ih` (both names point here)
// spawn the real CLI with the tsx loader resolved by ABSOLUTE path from THIS
// install (a global install serves any cwd — `--import tsx` alone would
// resolve from the user's folder and fail).
//
// Lives in apps/cli — the same bin file serves both names (package.json bin).
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"

const require = createRequire(import.meta.url)
let loader
let entry
try {
  loader = require.resolve("tsx") // absolute path into OUR install
  entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts")
} catch (e) {
  console.error(`[i-harness] shim bootstrap failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

// Windows: --import must be a file:// URL (a raw D:\ path is rejected by the
// ESM loader) — but the ENTRY stays a plain path (tsx's resolver re-URLs it
// and a URL would become "file:\D:\…").
const child = spawn(process.execPath, ["--import", pathToFileURL(loader).href, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
})
child.on("exit", (code, signal) => process.exit(code ?? (signal != null ? 1 : 0)))
child.on("error", (e) => {
  console.error(`[i-harness] spawn failed: ${e.message}`)
  process.exit(1)
})
