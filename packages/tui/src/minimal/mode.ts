// @i-harness/tui — G2: minimal/fullscreen mode switching (M38a).
// The mode switch is a SELF-RELAUNCH of the same session (spec §1): the
// prompt text `/minimal` or `/fullscreen` spawns the same host with the
// flipped `--mode` (mode.x → append/replace `--mode` in argv; fullscreen
// strips it — fullscreen is the default). Process-side: process.execPath +
// --import tsx + the current entry + the relaunched argv (Windows-safe:
// execPath is the node binary; argv preserved verbatim).

import { spawn as spawnProcess } from "node:child_process"

/** Relaunch spawn (overridable for tests). */
export type RelaunchSpawn = (argv: string[], mode: "minimal" | "fullscreen") => void

export interface ModeSwitchOptions {
  /** Current process argv (argv.slice(2)) — the relaunch preserves flags. */
  argv: string[]
  /** Injectable spawn — tests record instead of exec (default: self relaunch). */
  spawn?: RelaunchSpawn
}

/** Parse the displayed mode from argv: `--minimal`/`--fullscreen` flags or
 * `--mode minimal|fullscreen` (window of default: undefined). */
export function parseModeArg(argv: string[]): "minimal" | "fullscreen" | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--minimal") return "minimal"
    if (a === "--fullscreen") return "fullscreen"
    if (a === "--mode" && argv[i + 1] !== undefined) {
      const v = argv[i + 1]
      if (v === "minimal") return "minimal"
      if (v === "fullscreen") return "fullscreen"
      i++
      continue
    }
    if (a?.startsWith("--mode=")) {
      const v = a.slice("--mode=".length)
      if (v === "minimal") return "minimal"
      if (v === "fullscreen") return "fullscreen"
    }
  }
  return undefined
}

/** Same-session relaunch argv: strip any existing mode flags (`--minimal`,
 * `--fullscreen`, `--mode <v>`, `--mode=<v>`) then append `--mode minimal`
 * when switching TO minimal (fullscreen = default — nothing appended).
 * `--model` is NOT touched (only the exact `--mode` matches). */
export function relaunchArgs(mode: "minimal" | "fullscreen", argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--minimal" || a === "--fullscreen") continue
    if (a === "--mode") {
      i++ // skip the value too (unknown values are dropped with the flag)
      continue
    }
    if (a?.startsWith("--mode=")) continue
    out.push(a)
  }
  if (mode === "minimal") out.push("--mode", "minimal")
  return out
}

/** Default spawn: the same thin host under the target mode —
 * `node --import tsx <entry> <relaunched args>` with inherited stdio (the
 * new process takes over the terminal; the old one exits after spawning).
 * On Windows process.execPath is node.exe — execPath + tsx import works
 * identically. */
export const defaultRelaunchSpawn: RelaunchSpawn = (argv) => {
  const entry = process.argv[1] ?? "index.ts"
  const child = spawnProcess(process.execPath, ["--import", "tsx", entry, ...argv], {
    stdio: "inherit",
  })
  child.on("error", (err) => {
    console.error(`mode relaunch spawn failed: ${err.message}`)
  })
}

/**
 * The slash relay: recognize `/minimal` / `/fullscreen` (prompt text match —
 * the M37b slash dropdowns are UI; the TEXT match is the relay), spawn the
 * self-relaunch and tell the loop "handled". Anything else (e.g. `/model`,
 * `/help`) is NOT a mode switch and falls through to the normal submit.
 */
export class ModeSwitch {
  constructor(private readonly opts: ModeSwitchOptions) {}

  onSlash(cmd: string): boolean {
    const m = cmd.trim()
    const spawn = this.opts.spawn ?? defaultRelaunchSpawn
    if (m === "/minimal") {
      spawn(relaunchArgs("minimal", this.opts.argv), "minimal")
      return true
    }
    if (m === "/fullscreen") {
      spawn(relaunchArgs("fullscreen", this.opts.argv), "fullscreen")
      return true
    }
    return false
  }
}
