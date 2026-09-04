// M38b G3: case-016 — the markdown checkpoint streaming PTY proof:
//   (a) a deterministic markdown assistant stream (paragraph close → open
//       tail → tail close → python fence OPEN → fence CLOSE → tail) flows
//       through the REAL app pipeline (TuiApp + ScrollbackEngine + Presenter +
//       tui-core renderer) into a real node-pty pseudo-terminal;
//   (b) the checkpoint machine is proven AS-YOU-GO on the rendered screen:
//       a blank-line paragraph flushes and PERSISTS while the open tail
//       re-renders its row in place ("Para two " → "Para two line.");
//   (c) the fence styling is proven at CELL level on the parsed stream
//       (@xterm/headless): fence OPEN → plain md-code (#3a95ab, non-bold on
//       md_code_bg #1c1c1c); fence CLOSED → hljs (keyword bold, number
//       accent-assistant #bb9af7) — plus exact SGR byte substrings on the
//       captured pty stream;
//   (d) byte budget writes=10 = init(1) + 8 frames + teardown(1) + glyph
//       integrity + exit 0.

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

const HOST_FILE = fileURLToPath(new URL("./host-016.ts", import.meta.url))

/** The exact SGR markers of the markdown checkpoint story — every one
 * verified against the captured pty stream (NOTE: ConPTY re-encodes the
 * host's flush bytes — it paints cursor-RELATIVE jumps (\x1b[3C skip over
 * unchanged cells) and emits its own resets — so the pins carry ConPTY's
 * emission shape, not the app's raw bytes; the COLORS are unchanged):
 *  - fence OPEN frame: plain md-code at the code row (38;2;58;149;171 =
 *    #3a95ab, NO bold) right before "print(1)" (\x1b[3C jumps the rail/pad);
 *  - fence CLOSED frame: keyword bold (\x1b[1m) reuses the md-code fg for
 *    "print" (hljs-built_in → md-code), the number lands in accent-assistant
 *    (38;2;187;154;247 = #bb9af7, hljs-number) right after a 22m bold-off and
 *    a 1C skip over the unchanged "(";
 *  - the tail-row in-place rewrite: row 6 (1-based) re-rendered from
 *    "Para two " to "Para two line." — the flushed tail keeps its prefix and
 *    the completion lands in the same row (CUP 6;7H + text color 225;225;225). */
const SGR_FENCE_OPEN_PLAIN = "\x1b[38;2;58;149;171m\x1b[3Cprint(1)"
const SGR_FENCE_CLOSED_KEYWORD_BOLD = "\x1b[1m\x1b[3Cprint"
const SGR_FENCE_CLOSED_NUMBER = "\x1b[38;2;187;154;247m\x1b[22m\x1b[1C1"
const SGR_TAIL_REWRITE = "\x1b[6;7HPara two \x1b[m\x1b[38;2;225;225;225mline."

test(
  "case-016: markdown checkpoint streaming (per-paragraph flush + fence-close highlight + byte budget)",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-016.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-016-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    let stream = ""
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["016", `${scene.size[0]}x${scene.size[1]}`],
      })
      const virtual = new VirtualTerminal(scene.size[0], scene.size[1])
      off = runner.onData((d) => {
        stream += d
        virtual.write(d)
      })

      const result = await runScenario(scene, { runner, virtual, markerDir })
      expect(result.ok, result.ok ? "ok" : `scenario failed: ${result.error}`).toBe(true)

      // The four exact SGR byte pins (see header) on the complete pty stream.
      for (const [label, pin] of [
        ["fence-open plain code SGR", SGR_FENCE_OPEN_PLAIN],
        ["fence-closed keyword bold SGR", SGR_FENCE_CLOSED_KEYWORD_BOLD],
        ["fence-closed number accent-assistant SGR", SGR_FENCE_CLOSED_NUMBER],
        ["tail row in-place rewrite", SGR_TAIL_REWRITE],
      ] as const) {
        if (!stream.includes(pin)) {
          expect.fail(
            `${label}: stream does not contain ${JSON.stringify(pin)}` +
              (process.env.TUI_KEEP_DIR !== undefined && process.env.TUI_KEEP_DIR !== ""
                ? ` (stream dumped to ${markerDir}/stream-dump.txt)`
                : ""),
          )
        }
      }
    } finally {
      off?.()
      if (runner !== undefined) {
        try {
          runner.pty.kill()
        } catch {
          /* already dead */
        }
      }
      if ((process.env.TUI_KEEP_DIR ?? "") !== "") {
        // Also dump the raw stream for pin inspection in the kept dir.
        writeFileSync(join(markerDir, "stream-dump.txt"), stream)
        console.log(`[keep] markerDir=${markerDir}`)
      } else {
        rmSync(markerDir, { recursive: true, force: true })
      }
    }
  },
  90_000,
)
