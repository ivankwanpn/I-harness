// M37b G4: case-013 — the @i-harness/tui REAL-PTY permission-overlay gate:
//   (a) the host builds app.state().overlay with the PRODUCTION G4 binder
//       (bindPermissionOverlay — the public surface export), so the modal's
//       draw (prompt-slot precedence) and the key routing go through the
//       REAL G1↔G2 seam + loop dispatch,
//   (b) the pty's real keys drive it: j (clamped no-op), k (cursor → row 2),
//       1 (Always allow) — the seam's onDecision records the verdict to
//       <markerDir>/answered (asserted by content) and onClose clears the
//       overlay,
//   (c) byte-budget in writes mode: init + modal frame + k frame + modal-gone
//       frame + teardown = 5 (the clamped j frame is identical → flush ""),
//   (d) glyph integrity + exit 0.

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

const HOST_FILE = fileURLToPath(new URL("./host-013.ts", import.meta.url))

test(
  "case-013: permission overlay via the seam (j/k cursor + 1 → approved)",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-013.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-013-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["013", `${scene.size[0]}x${scene.size[1]}`],
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
  60_000,
)
