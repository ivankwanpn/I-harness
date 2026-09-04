// M43 G2: case-020 — the REWIND end-to-end proof at REAL-PTY level.
// The host (host-020.ts) drives the real app pipeline + the real stdin input
// path: two REAL recording turns (fs writes through the M42 recorder into a
// REAL RewindStore) then Esc/Esc → rewind picker → Enter (turn 1) → `a`
// (both) → `y` (confirm) — the production loop drives the REAL RewindService
// execute: the disk `src/data.txt` is restored to "v1" and the engine draws
// `Rewound to turn 1`. Pacing: marker-cued.
//
// The strict assertions: (a) the BYTE-EXACT fs readback — this test reads the
// temp workspace the host wrote (`workspace-dir` marker) and asserts the
// content is `v1`; (b) the scrollback system row (`Rewound to turn 1` — the
// yaml's wait-screen); plus the byte budget + exit 0. The delta: G1's engine
// currently appends the marker row WITHOUT hiding the rewound rows (the
// deriveMessages cut is core-session model level, not the TUI engine) — see
// the M43 report.

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

const HOST_FILE = fileURLToPath(new URL("./host-020.ts", import.meta.url))

test(
  "case-020: rewind — real service restore proof (Esc-Esc picker → execute → disk v1 + line)",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-020.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-020-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["020", `${scene.size[0]}x${scene.size[1]}`],
      })
      const virtual = new VirtualTerminal(scene.size[0], scene.size[1])
      off = runner.onData((d) => virtual.write(d))

      const result = await runScenario(scene, { runner, virtual, markerDir })
      if (!result.ok) {
        const dump: string[] = []
        for (let y = 0; y < 30; y++) dump.push(`${y}: ${JSON.stringify(virtual.rowText(y))}`)
        writeFileSync(join(markerDir, "screen-dump.txt"), dump.join("\n"))
      }
      expect(result.ok, result.ok ? "ok" : `scenario failed: ${result.error}`).toBe(true)

      // (a) the byte-exact disk assert — the M42 restore wrote "v1" back.
      const workspace = readFileSync(join(markerDir, "workspace-dir"), "utf8")
      const content = readFileSync(join(workspace, "src", "data.txt"), "utf8")
      expect(content).toBe("v1")
    } finally {
      off?.()
      if (runner !== undefined) {
        try {
          runner.pty.kill()
        } catch {
          /* already dead */
        }
      }
      if ((process.env.TUI_KEEP_DIR ?? "") !== "") console.log(`[keep] markerDir=${markerDir}`)
      else rmSync(markerDir, { recursive: true, force: true })
    }
  },
  150_000,
)
