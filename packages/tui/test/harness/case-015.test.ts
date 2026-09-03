// M38a G3: case-015 — the minimal-mode PTY proof:
//   (a) TuiApp in mode "minimal" with the REAL G1 inline engine
//       (createInlineLiveRegion) driven by a deterministic scripted backend —
//       the production minimal path, no tui-core terminal (no alt screen);
//   (b) the REAL @xterm/headless normal buffer is the print-once ledger:
//       committed rows sit in the terminal's own buffer in chronological
//       order with the live region bottom-pinned; byte-budget writes=11 =
//       init has no write at all + 7 events (4 commits + 7 frames) + the
//       post-resize commit pair — NO replay and NO anim-pump repaint
//       (every sleep runs while the turn is idle — anim writes would inflate
//       the count and the frozen clock cannot suppress them: loop.frameMinimal
//       has no identical-frame suppression, a G2 reality this case paces
//       around; see host-015.ts header);
//   (c) resizing during a live region (46x24→34x18 via the fs app-resize
//       channel — the ConPTY master resize is unobservable to the child in
//       this pairing, see host-015.ts) + one more commit: the region re-places
//       at the new bottom, the scrollback stays intact, exactly 2 more writes;
//   (d) the self-relaunch: after the scene the host spawns ITSELF with
//       --mode fullscreen (relaunchArgs) into a second marker dir; the child's
//       REAL fullscreen chrome (prompt box) is asserted through the same pty
//       stream (it flips to the alt screen and back; the normal buffer is
//       untouched by the child);
//   (e) exit code 0.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { expect, test } from "vitest"
import { spawnHost } from "./runner.ts"
import type { HostPty } from "./runner.ts"
import { VirtualTerminal } from "./virtual.ts"
import { runScenario } from "./referee.ts"
import type { Scene } from "./referee.ts"

const HOST_FILE = fileURLToPath(new URL("./host-015.ts", import.meta.url))

/** The yaml's `$RELAUNCH_DIR` placeholder → the run's second marker dir. */
function resolvePlaceholders(scene: Scene, vars: Record<string, string>): Scene {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (Object.prototype.hasOwnProperty.call(vars, v)) return vars[v]
      return v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val)
      return out
    }
    return v
  }
  return walk(scene) as Scene
}

test(
  "case-015: minimal-mode print-once (native scrollback commit proof + byte budget + resize + relaunch)",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-015.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-015-"))
    const relaunchDir = mkdtempSync(join(tmpdir(), "tui-case-015r-"))
    const scene2 = resolvePlaceholders(scene, { $RELAUNCH_DIR: relaunchDir })
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["015", `${scene.size[0]}x${scene.size[1]}`, "34x18", relaunchDir],
      })
      const virtual = new VirtualTerminal(scene.size[0], scene.size[1])
      off = runner.onData((d) => virtual.write(d))

      const result = await runScenario(scene2, { runner, virtual, markerDir })
      if (!result.ok) {
        const dump: string[] = []
        for (let y = 0; y < 70; y++) dump.push(`${y}: ${JSON.stringify(virtual.rowText(y))}`)
        const keep = process.env.TUI_KEEP_DIR
        if (keep !== undefined && keep !== "") writeFileSync(join(markerDir, "screen-dump.txt"), dump.join("\n"))
      }
      expect(result.ok, result.ok ? "ok" : `scenario failed: ${result.error}`).toBe(true)
    } finally {
      off?.()
      if (runner !== undefined) {
        try {
          runner.pty.kill()
        } catch {
          /* already dead */
        }
      }
      if ((process.env.TUI_KEEP_DIR ?? "") !== "") {
        console.log(`[keep] markerDir=${markerDir} relaunchDir=${relaunchDir}`)
      } else {
        rmSync(markerDir, { recursive: true, force: true })
        rmSync(relaunchDir, { recursive: true, force: true })
      }
    }
  },
  120_000,
)
