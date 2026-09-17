import { createRequire } from "node:module"

// M27-H-1: the host's /api/health version — the CLI package's own version is
// the single constant (read at module load). M45: the bundle drops the
// manifest BESIDE the bundle (dist/package.json → "./package.json"); the
// source run has it ONE LEVEL UP (apps/cli/package.json → "../package.json").
// The dual-path fallback serves both; the bundle's require is esbuild-safe
// (a scoped createRequire — calls are not rewritten).
//
// M65 T1: moved here verbatim from src/web.ts, which owned it because the web
// host's health route also read it. `--version` is the surviving reader, so the
// constant outlives the frontend and the file that defined it.
const require = createRequire(import.meta.url)
function packageJsonVersion(): string {
  try {
    return (require("./package.json") as { version: string }).version
  } catch {
    return (require("../package.json") as { version: string }).version
  }
}

/** `i-harness --version` — the CLI package.json version. */
export const CLI_VERSION = packageJsonVersion()
