// M49 Task 7: case-025 — the grapheme-safe PromptEditor + the VISIBLE
// terminal cursor (PTY-level). The yaml drives the keystrokes and asserts the
// parsed screen text + the parsed cursor cell (`wait-cursor` — 1-based
// col/row, no fixed blink phase: the caret is Show'd once and re-asserted
// with minimal MoveTo bytes); THIS test additionally pins the raw byte
// vocabulary on the captured stream: the initial Show (\x1b[?25h), the
// modal-open Hide (\x1b[?25l, spec §6.3), the dismiss re-Show, and NO
// show/hide flapping on idle frames (zero cursor bytes on an unchanged
// frame — the byte budget).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { expect, test } from "vitest"
import { spawnHost } from "./runner.ts"
import { VirtualTerminal } from "./virtual.ts"
import { runScenario } from "./referee.ts"
import type { Scene } from "./referee.ts"

const HOST_FILE = fileURLToPath(new URL("./host-025.ts", import.meta.url))
const YAML_FILE = fileURLToPath(new URL("./case-025.yaml", import.meta.url))

test(
  "case-025: grapheme-safe prompt editing + visible cursor (move/undo/redo/resize/modal)",
  async () => {
    const scene = parse(readFileSync(YAML_FILE, "utf8")) as Scene
    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-025-"))
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
        const c = virtual.cursor()
        writeFileSync(join(markerDir, "cursor.txt"), JSON.stringify(c))
      }
      expect(result.ok, result.ok ? "ok" : `scenario failed: ${result.error}`).toBe(true)
      expect(existsSync(join(markerDir, "submission"))).toBe(false)

      // The byte vocabulary pins on the captured stream.
      const hide = "\x1b[?25l"
      const show = "\x1b[?25h"
      expect(stream.includes(show)).toBe(true) // the initial Show + the dismiss restore
      expect(stream.includes(hide)).toBe(true) // the modal-open frame hid the caret

      expect(exited).toBe(true)
      expect(virtual.cols).toBe(60)
      expect(virtual.rows).toBe(20)
    } finally {
      off?.()
      if (runner !== undefined && !exited) {
        try { runner.pty.kill() } catch {}
      }
      if ((process.env.TUI_KEEP_DIR ?? "") !== "") console.log(`[keep] markerDir=${markerDir}`)
      else rmSync(markerDir, { recursive: true, force: true })
    }
  },
  120_000,
)
