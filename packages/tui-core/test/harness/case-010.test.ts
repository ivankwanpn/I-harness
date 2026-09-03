// M36 G3: the first REAL-PTY harness case — the gate:
//   (a) the host renders a fixed frame through tui-core into a real node-pty
//       pseudo-terminal (ConPTY on Windows) with NO live probe,
//   (b) a REAL VT parser (@xterm/headless) validates the resulting screen
//       row-by-row plus glyph-integrity (width accounting),
//   (c) zero-byte idle: the pty emits NO bytes during the host's sleep windows,
//   (d) resize invariants: pty.resize + re-render at a new size → the parser
//       screen matches the new grid and integrity holds after the resize too.

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

const HOST_FILE = fileURLToPath(new URL("./host-010.ts", import.meta.url))

/** The host re-renders frame 2 at the size of the FIRST resize step. */
function secondSizeOf(scene: Scene): string {
  for (const step of scene.steps) {
    const resize = step["resize"] as Record<string, unknown> | undefined
    if (resize !== undefined && resize["cols"] !== undefined) {
      return `${String(resize["cols"])}x${String(resize["rows"])}`
    }
  }
  return "30x8"
}

test(
  "case-010: real-pty render + zero-byte idle + resize invariants",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-010.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-core-case-010-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        // argv[3] = first size (scene.size), argv[4] = second size (first resize step)
        extraArgv: [`${scene.size[0]}x${scene.size[1]}`, secondSizeOf(scene)],
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
