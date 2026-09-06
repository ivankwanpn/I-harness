import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

const HOST_FILE = fileURLToPath(new URL("./host-024.ts", import.meta.url))
const YAML_FILE = fileURLToPath(new URL("./case-024.yaml", import.meta.url))

function sceneFor(cols: 80 | 120, rows: 24 | 32): Scene {
  const scene = parse(readFileSync(YAML_FILE, "utf8")) as Scene
  scene.size = [cols, rows]
  if (cols === 120) {
    const modelStatus = scene.steps[2]!["wait-screen"] as { region: { startRow: number } }
    const promptRail = scene.steps[7]!["assert-cell-colors"] as { cells: Array<{ row: number }> }
    modelStatus.region.startRow = 13
    for (const cell of promptRail.cells) cell.row = 10
  }
  return scene
}

async function runCase(cols: 80 | 120, rows: 24 | 32): Promise<{ captured: string; virtual: VirtualTerminal }> {
  const scene = sceneFor(cols, rows)
  const markerDir = mkdtempSync(join(tmpdir(), `tui-case-024-${cols}-`))
  let runner: HostPty | undefined
  let off: (() => void) | undefined
  let captured = ""
  const virtual = new VirtualTerminal(cols, rows)
  try {
    runner = spawnHost({
      hostFile: HOST_FILE,
      markerDir,
      cols,
      rows,
      extraArgv: [`${cols}x${rows}`],
    })
    off = runner.onData((data) => {
      captured += data
      virtual.write(data)
    })
    const result = await runScenario(scene, { runner, virtual, markerDir })
    if (!result.ok) {
      const dump = Array.from({ length: rows }, (_, y) => `${y}: ${JSON.stringify(virtual.rowText(y))}`)
      writeFileSync(join(markerDir, "screen-dump.txt"), dump.join("\n"))
    }
    expect(result.ok, result.ok ? "ok" : `scenario failed: ${result.error}`).toBe(true)
    expect(existsSync(join(markerDir, "submission"))).toBe(false)
    expect(captured).not.toContain("tool/result")
    expect(captured).not.toContain("assistant response")
    expect(virtual.cols).toBe(cols)
    expect(virtual.rows).toBe(rows)
    return { captured, virtual }
  } finally {
    off?.()
    if (runner !== undefined) {
      try { runner.pty.kill() } catch {}
    }
    if ((process.env.TUI_KEEP_DIR ?? "") !== "") console.log(`[keep] markerDir=${markerDir}`)
    else rmSync(markerDir, { recursive: true, force: true })
  }
}

test("case-024: 80x24 Welcome keeps an unconfigured prompt and routes Enter to Models & Providers", async () => {
  await runCase(80, 24)
}, 90_000)

test("case-024: 120x32 Welcome preserves wide layout, glyphs, and the same model gate", async () => {
  await runCase(120, 32)
}, 90_000)
