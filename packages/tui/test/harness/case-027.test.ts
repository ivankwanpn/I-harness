// M49 Task 13: case-027 — the LOCAL DASHBOARD + TRUTHFUL STATUS LINE at
// real-pty level. Host-027 drives the REAL embedded service (a gated spawn —
// one REAL running subagent, one queued prompt, a second listing-only durable
// session) through the PRODUCTION key/mouse path:
//   Ctrl+\ dashboard · type-to-filter · p peek · P pin · Enter open · Esc back
//   · Ctrl+; queue pane · Ctrl+G tasks pane · mouse [cancel] + [✗].

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

const HOST_FILE = fileURLToPath(new URL("./host-027.ts", import.meta.url))
const YAML_FILE = fileURLToPath(new URL("./case-027.yaml", import.meta.url))

test(
  "case-027: local dashboard, queue/tasks cancels, truthful status counts",
  async () => {
    const scene = parse(readFileSync(YAML_FILE, "utf8")) as Scene
    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-027-"))
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
    } finally {
      off?.()
      if (runner !== undefined && !exited) {
        try { runner.pty.kill() } catch {}
      }
      if ((process.env.TUI_KEEP_DIR ?? "") !== "") console.log(`[keep] markerDir=${markerDir}`)
      else rmSync(markerDir, { recursive: true, force: true })
    }
  },
  // This budget MUST exceed the scenario's own worst-case step budget, or the
  // outer timeout fires first and every inner `timeoutMs` is decoration. Sum
  // of case-027.yaml's waits: 150s (spawn-running — the REAL nested session
  // spawn, starved under full-suite load) + 40s (queued-prompt) + 30s
  // (queue-cancelled) + 30s (task-cancelled) + 40s (live-tasks-zero) + 60s
  // (teardown-wrote) + ~20 assert-cell-colors polls at 5s + 3 quiescent
  // ≈ 250s. At the old 120s the scenario could NEVER report which step hung:
  // vitest killed it mid-step and the report said only "Test timed out" —
  // which is why raising the marker budget alone (M61) did not stop the flake.
  300_000,
)
