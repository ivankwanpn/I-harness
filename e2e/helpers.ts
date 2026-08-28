import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts")

// `--import tsx` (bare specifier) resolves node_modules from the SPAWN cwd —
// an e2e workspace under the OS temp root has none, so the bare form fails
// with ERR_MODULE_NOT_FOUND (cli.test.ts:344 only ever spawns with cwd = repo
// root, where it resolves). The ABSOLUTE file URL of tsx's loader entry
// (package exports "." → dist/loader.mjs) works from any cwd — verified
// empirically on this repo before pinning it here.
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href

export interface CliRun {
  status: number // null (spawn failure / timeout kill) normalized to -1
  stdout: string
  stderr: string
}

// Run the REAL CLI as a real process: `node --import <tsx> apps/cli/src/index.ts run ...`
// The CLI has NO --workspace flag — workspace = spawn cwd (index.ts hard-codes
// `workspace: process.cwd()`), so `cwd` IS the workspace.
export function runCli(args: string[], cwd: string): CliRun {
  const res = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  })
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

export function makeWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

// Shell-tool paths (bash redirect targets): forward slashes are accepted by
// the Windows APIs and avoid backslash-escape ambiguity inside double quotes.
export function toShellPath(p: string): string {
  return p.replace(/\\/g, "/")
}
