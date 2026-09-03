// M37a G4: case-011 — the @i-harness/tui REAL-PTY harness gate:
//   (a) a deterministic agent turn streams through the REAL app pipeline
//       (TuiApp + ScrollbackEngine + Presenter + tui-core renderer) into a
//       real node-pty pseudo-terminal (ConPTY on Windows) with NO live probe,
//   (b) a REAL VT parser (@xterm/headless) validates the resulting screen
//       frame-by-frame (user / system line / tool running / tool done /
//       assistant / turn end),
//   (c) zero-byte idle: the pty emits NO bytes in the 700ms sleep windows
//       between frames — even while the turn runs (the host's frozen clock
//       keeps the anim pump's repaints identical → flush ""),
//   (d) glyph integrity across the whole final screen + exit code 0.

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

const HOST_FILE = fileURLToPath(new URL("./host-011.ts", import.meta.url))
const SIZE2 = "34x18" // unused by the 011 scene (no resize) — passed for parity

test(
  "case-011: live streaming agent turn + zero-byte idle + final screen",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-011.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-011-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["011", `${scene.size[0]}x${scene.size[1]}`, SIZE2],
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
