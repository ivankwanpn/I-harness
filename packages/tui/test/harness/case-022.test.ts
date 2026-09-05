// M46a G2: case-022 — the SLASH REGISTRY + KEYS TRUTH at REAL-PTY level
// (spec §2): Ctrl+S stash/pop round-trip (the keys truth — stash text → type
// → restore), /theme cycle (the palette actually re-resolves — cellColor
// changes), /timestamps (rows gain the ts column), /find (search bar mode),
// /history (the prompt-history panel), /skills (REAL registry rows over a
// temp workspace skill), /usage (the token meter panel from backend.context),
// byte budget + exit 0. Frozen clock keeps all frames deterministic.

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

const HOST_FILE = fileURLToPath(new URL("./host-022.ts", import.meta.url))

test(
  "case-022: slash registry + keys truth — stash/F3→sessions theme timestamps find history skills usage",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-022.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-022-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["022", `${scene.size[0]}x${scene.size[1]}`],
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
  150_000,
)
