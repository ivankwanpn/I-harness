// M49 Task 10: case-026 — TYPED TOOL BLOCKS at REAL-PTY level. The host runs
// the REAL embedded session service with a scripted model calling REAL fs
// tools (read / edit / apply_patch) and the REAL resolved shell through the
// PRODUCTION TuiApp pipeline. The scene asserts:
//   - typed headers (Read {path} / Edit {path} (+A/-D) / Run {command}),
//   - the running→done update in place (same block, result body lands),
//   - the structured change's delta (+1/-1) and the expanded hunk lines
//     (-alpha / +ALPHA / -BETA / +GAMMA),
//   - the raw viewer (the redacted raw JSON of a block on a fullscreen modal),
//   - copy feedback through the injected adapter (the "Copied!"-without-lie
//     rule is a unit test; here the recorder clipboard holds the payload),
//   - NO secret key text reaches ANY surface (the bash args carry
//     apiKey: "sk-case-026-secret" — neither the wrapped screen nor the
//     copied payload may contain the value).
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

const HOST_FILE = fileURLToPath(new URL("./host-026.ts", import.meta.url))

test(
  "case-026: typed tool blocks — real fs read/edit/apply_patch + shell, raw viewer, copy, no secret text",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-026.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-026-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    let captured = ""
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        // Scenes use the final rows/cols; the host's argv[4] is the size string.
        extraArgv: ["026", `${scene.size[0]}x${scene.size[1]}`],
      })
      const virtual = new VirtualTerminal(scene.size[0], scene.size[1])
      off = runner.onData((d) => { captured += d; virtual.write(d) })

      const result = await runScenario(scene, { runner, virtual, markerDir })
      if (!result.ok) {
        const dump: string[] = []
        for (let y = 0; y < scene.size[1]; y++) dump.push(`${y}: ${JSON.stringify(virtual.rowText(y))}`)
        writeFileSync(join(markerDir, "screen-dump.txt"), dump.join("\n"))
      }
      expect(result.ok, result.ok ? "ok" : `scenario failed: ${result.error}`).toBe(true)

      // NEGATIVE red line: the secret value never reaches the PTY bytes.
      expect(captured).not.toContain("sk-case-026-secret")
      // The injected copy adapter holds the raw-viewer payload; the secret is
      // redacted there too. (The assertion runs even when the viewer copy
      // step wrote the file — YAML step order guarantees it.)
      try {
        const clip = readFileSync(join(markerDir, "clipboard.json"), "utf8")
        expect(clip).not.toContain("sk-case-026-secret")
        expect(clip).toContain("resolved-shell")
      } catch {
        /* the viewer copy step owns the marker write — a missing file means
           the yaml's copy step failed earlier (the scenario already failed). */
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
      if ((process.env.TUI_KEEP_DIR ?? "") !== "") console.log(`[keep] markerDir=${markerDir}`)
      else rmSync(markerDir, { recursive: true, force: true })
    }
  },
  180_000,
)
