// M37a G4: case-014 — resize DURING a streaming turn across a real node-pty.
// The host re-grids its renderer + re-wraps its engine at 34x18 INSIDE a
// 1200ms idle window (turn already idle), the test resizes the PTY ~350ms in,
// and the next event flushes the resize's full-paint frame. Assertions:
// no broken glyphs after the resize, row widths == cols per row, the final
// screen contains the expected texts, zero-byte idle in the windows, exit 0.

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

test(
  "case-014: resize during streaming + zero-byte idle + glyph integrity",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-014.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-014-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        // argv[4] = first size (scene.size), argv[5] = second size (resize target)
        extraArgv: ["014", `${scene.size[0]}x${scene.size[1]}`, "34x18"],
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
