// M46b G3 (final): case-023 — the MOUSE MATRIX at REAL-PTY level. The main
// test drives host-023 scene "023" with SGR 1006 sequences (wheel / no-button
// motion / press+release / held-button drag) through the REAL tui-core
// InputParser → loop.onInput → G1 hover engine + scroll stream → G2 router:
// wheel offset, hover bg-blend + timestamp swap, single-click selection
// (engine witness), double-click fold + a fresh-pair expand, drag + auto-copy
// (RECORDER clipboard — the injected-copy hard rule) + "Copied!" toast,
// scrollbar jump, permission double-fire (seam-built modal → decision.json),
// byte budget + exit 0. A SECOND test runs host-023 scene "023m" (minimal
// mode over the inline live-region engine — NO tui-core terminal): the
// captured byte stream provably contains NO mouse-mode enable sequence
// ("?1000h") — the minimal no-capture red line — with the region's committed
// text as the positive control.

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

const HOST_FILE = fileURLToPath(new URL("./host-023.ts", import.meta.url))

test(
  "case-023: mouse matrix — wheel/hover+ts-swap/click-select/double-fold/drag+autocopy/scrollbar/permission-double",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-023.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-023-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["023", `${scene.size[0]}x${scene.size[1]}`],
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
      // The selection witness' LAST observed selection is the drag's span
      // (the flash never expires on the frozen clock — the state persists).
      const sel = readFileSync(join(markerDir, "selection.json"), "utf8")
      expect(sel).toContain('"a":5')
      expect(sel).toContain('"b":9')
      // The RECORDER clipboard holds the drag auto-copy payload exactly.
      const clip = readFileSync(join(markerDir, "clipboard.json"), "utf8")
      expect(clip).toBe("data-1\ndata-2\n …\ndata-4\ndata-5")
      // The permission decision fired once (the double-click).
      const decision = JSON.parse(readFileSync(join(markerDir, "decision.json"), "utf8"))
      expect(decision).toMatchObject({ surfaceId: "p1", verdict: "always", approved: true, index: 0 })
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

test(
  "case-023: minimal no-capture — the byte stream contains NO mouse-mode enable sequence",
  async () => {
    // The minimal scene (host-023 "023m"): mode "minimal" over the REAL inline
    // live-region engine — the host NEVER creates the tui-core terminal, so
    // there is no init/teardown byte at all (the five-mode set absent).
    const scene: Scene = {
      name: "case-023-minimal-no-capture",
      host: "test/harness/host-023.ts",
      size: [80, 24],
      steps: [
        { "await-marker": { name: "scene-ready" } },
        { "await-marker": { name: "events-seeded" } },
        { "await-marker": { name: "frame-6" } },
        { "await-quiescent": { ms: 300 } },
        { "assert-glyph-integrity": {} },
        { "request-marker": { name: "request-exit" } },
        { "await-marker": { name: "teardown-wrote" } },
        { "assert-byte-budget": { writes: 6 } },
        { "wait-exit": { code: 0 } },
      ],
    }

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-023m-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    let captured = ""
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["023m", `${scene.size[0]}x${scene.size[1]}`],
      })
      off = runner.onData((d) => {
        captured += d
      })
      const virtual = new VirtualTerminal(scene.size[0], scene.size[1])
      const res = await runScenario(scene, { runner, virtual, markerDir })
      expect(res.ok, res.ok ? "ok" : `scenario failed: ${res.error}`).toBe(true)
      // NEGATIVE: the mouse-mode capture enable sequence is absent.
      expect(captured).not.toContain("?1000h")
      expect(captured).not.toContain("?1002h")
      // POSITIVE control: the region's committed text IS in the stream (the
      // capture is real, the absence is a mouse-specific claim).
      expect(captured).toContain("minimal line")
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
  90_000,
)
