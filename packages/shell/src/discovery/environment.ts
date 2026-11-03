import { win32 } from "node:path"
import { resolveBashExe } from "./windows.ts"

export function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

/** Keep nested `bash` — a `#!/usr/bin/env bash` script, a `bash -c`, an npm
 * script that shells out — in the HARNESS's own runtime rather than whatever the
 * host PATH happens to name first.
 *
 * WHY THE DIRECTORY AND NOT A FLAG: on Windows the host PATH lists the WSL
 * launcher before any real Unix shell (`…\Microsoft\WindowsApps\bash.exe`), so a
 * bare `bash` runs a DIFFERENT filesystem — measured on this host from the pwsh
 * tool, `bash -c "uname -s"` printed `Linux` while the bash tool's own child
 * printed `MINGW64_NT-…`. Prepending the resolved bash's directory makes the
 * harness's bash win for THIS child only.
 *
 * A launched command that IS a bash keeps its OWN directory: an Agent Shell
 * deliberately set to Rtools/MSYS Bash must keep using it (the 2026-10-01
 * tooling audit's conclusion). Every other shell gets the harness's resolved
 * bash, and nothing is prepended when no bash can be resolved at all. This
 * changes only the launched command's environment, never global PATH. */
export function shellCommandEnvironment(executable: string): { env?: Record<string, string> } {
  if (process.platform !== "win32") return {}
  const bash = win32.basename(executable).toLowerCase() === "bash.exe" ? executable : resolveBashExe()
  if (bash === undefined) return {}
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "PATH"
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return { env: { ...inherited, [key]: `${win32.dirname(bash)};${process.env[key] ?? ""}` } }
}
