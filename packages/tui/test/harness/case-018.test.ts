// M40 G2 (C11): case-018 — mouse wheel scroll at REAL-PTY level.
// The host drives the real app pipeline + the real stdin input path (raw pty
// bytes → tui-core InputParser → TuiApp.onInput); the pty master writes SGR
// 1006 wheel sequences and the scrollback scrolls (±3, follow-aware).
// Pacing: marker-cued (frame-N markers + wait-screen polls + the fs exit
// gate) — no cross-channel ordering assumed.

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

const HOST_FILE = fileURLToPath(new URL("./host-018.ts", import.meta.url))

test(
  "case-018: mouse wheel scrolls the scrollback (follow-aware ±3)",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-018.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-018-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["018", `${scene.size[0]}x${scene.size[1]}`],
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
  120_000,
)
