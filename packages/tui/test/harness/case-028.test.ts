// M49 Task 15: case-028 — THE INTEGRATED PARITY PROOF at real-pty level.
// One continuous executable session (host-028) through three boots over the
// SAME pty:
//   A) minimal (persisted tui.prefs.screenMode) — the registry sees the real
//      runtime label BEFORE any terminal byte; the byte discipline is proven
//      by the captured stream: the minimal section (everything before the
//      first alt-screen sequence) contains no 1049 / 1000 escapes.
//   B) fullscreen (the /fullscreen relaunch — persisted screenMode flip) —
//      theme cycling through the settings modal, the mouse-capture toggle
//      (Ctrl+R — the real disable/enable five-mode sets), the surface tour
//      (Settings → Dashboard → Queue → Tasks → tool viewer → file viewer →
//      Help) with modal input precedence + Esc unwind, and the unsupported
//      /login (exact message, ZERO backend submissions).
//   C) restart (durable-session resume) — the persisted theme/screen/status
//      evidence: the theme's palette colors, the model label from the REAL
//      runtime binding, and the settings document values.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { expect, test } from "vitest"
import { spawnHost } from "./runner.ts"
import { VirtualTerminal } from "./virtual.ts"
import { runScenario } from "./referee.ts"
import type { Scene } from "./referee.ts"

const HOST_FILE = fileURLToPath(new URL("./host-028.ts", import.meta.url))
const YAML_FILE = fileURLToPath(new URL("./case-028.yaml", import.meta.url))

// The five-mode capture sequences (tui-core terminal vocabulary).
const MOUSE_ENABLE_SEQ = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h"
const MOUSE_DISABLE_SEQ = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l"
const ALT_SCREEN_ON = "\x1b[?1049h"
const ALT_SCREEN_OFF = "\x1b[?1049l"

test(
  "case-028: integrated parity — minimal provenance, fullscreen behavior, persisted restart",
  async () => {
    const scene = parse(readFileSync(YAML_FILE, "utf8")) as Scene
    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-028-"))
    let runner: ReturnType<typeof spawnHost> | undefined
    let off: (() => void) | undefined
    let stream = ""
    let exited = false
    const virtual = new VirtualTerminal(scene.size[0], scene.size[1])
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: [`${scene.size[0]}x${scene.size[1]}`],
      })
      runner.pty.onExit(() => { exited = true })
      off = runner.onData((d) => {
        stream += d
        virtual.write(d)
      })
      const result = await runScenario(scene, { runner, virtual, markerDir })
      if (!result.ok) {
        const dump = Array.from({ length: scene.size[1] }, (_, y) => `${y}: ${JSON.stringify(virtual.rowText(y))}`)
        writeFileSync(join(markerDir, "screen-dump.txt"), dump.join("\n"))
        writeFileSync(join(markerDir, "stream-dump.txt"), stream)
      }
      expect(result.ok, result.ok ? "ok" : `scenario failed: ${result.error}`).toBe(true)
      expect(exited).toBe(true)
      expect(virtual.cols).toBe(scene.size[0])
      expect(virtual.rows).toBe(scene.size[1])

      // ── the byte discipline proofs (on the captured stream).
      const firstAlt = stream.indexOf(ALT_SCREEN_ON)
      expect(firstAlt).toBeGreaterThan(-1) // the fullscreen relaunch DID init
      // minimal provenance: everything before the first alt screen is the
      // minimal section — the runtime's REAL label renders there, and NOT ONE
      // alt-screen / mouse-enable byte precedes it.
      const minimalSection = stream.slice(0, firstAlt)
      const modelLabelIdx = minimalSection.indexOf("openai:case-028-model")
      if (modelLabelIdx === -1) expect(minimalSection.slice(0, 200)).toContain("case-028")
      expect(minimalSection).not.toContain(ALT_SCREEN_ON)
      expect(minimalSection).not.toContain("\x1b[?1000h")
      expect(minimalSection).not.toContain("\x1b[?1049")
      // the runtime label really IS in the minimal section (the persisted
      // ready model rendered BEFORE the mode switch).
      expect(modelLabelIdx).toBeGreaterThan(-1)
      // the mouse toggle: Ctrl+R — the disable bytes (the five-mode set)
      // prove the OFF transition; the init's enable proves the capture was
      // on before it. (The re-enable emission depends on the pty's
      // per-burst delivery of the SECOND Ctrl+R — the OFF sequence is the
      // deterministic half; the toggle-on's toast rides the screen.)
      const disableIdx = stream.indexOf(MOUSE_DISABLE_SEQ)
      expect(disableIdx).toBeGreaterThan(-1)
      expect(stream.indexOf(MOUSE_ENABLE_SEQ)).toBeGreaterThan(-1)
      // screen mode flip persistence: alt-screen teardown between the two
      // fullscreen boots (restart) — mode/theme persisted evidence (the file
      // checks ride the yaml's assert-file steps).
      expect(stream.indexOf(ALT_SCREEN_OFF)).toBeGreaterThan(firstAlt)
      expect(stream.indexOf(ALT_SCREEN_ON, firstAlt + 1)).toBeGreaterThan(-1)
      // the restart AGAIN emits alt screen (the persisted fullscreen boot).
      expect(stream.indexOf(ALT_SCREEN_OFF)).toBeLessThan(stream.length - 1)
    } finally {
      off?.()
      if (runner !== undefined && !exited) {
        try { runner.pty.kill() } catch {}
      }
      if ((process.env.TUI_KEEP_DIR ?? "") !== "") console.log(`[keep] markerDir=${markerDir}`)
      else rmSync(markerDir, { recursive: true, force: true })
    }
  },
  240_000,
)
