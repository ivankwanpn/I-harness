// M37b G4: case-012 — the @i-harness/tui REAL-PTY keyboard-interaction gate:
//   (a) a deterministic stream runs the REAL app pipeline into a real
//       node-pty (ConPTY) — same as case-011, PLUS
//   (b) the pty carries REAL KEYS: the child's raw-mode stdin → the REAL
//       tui-core InputParser → the TuiApp input pump (apps/tui's path), so
//       the whole scene (type "hi", Enter submit, Up history, Esc dismiss,
//       Ctrl-C arm-alive, Shift-Tab plan mode, Esc quit → exit 0) is driven
//       through the production keymap,
//   (c) zero-byte discipline: `assert-byte-budget` in WRITES mode — every
//       keystroke repaint is exactly one frame; identical frames flush ""
//       (the j-clamp and the arm frames of case-013/012 print nothing), and
//   (d) glyph integrity + exit 0.

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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

const HOST_FILE = fileURLToPath(new URL("./host-012.ts", import.meta.url))

test(
  "case-012: real-key interaction (submit → history → plan mode → quit)",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-012.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-012-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["012", `${scene.size[0]}x${scene.size[1]}`],
      })
      const virtual = new VirtualTerminal(scene.size[0], scene.size[1])
      off = runner.onData((d) => virtual.write(d))

      const result = await runScenario(scene, { runner, virtual, markerDir })
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
      rmSync(markerDir, { recursive: true, force: true })
    }
  },
  60_000,
)
