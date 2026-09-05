// M46a G1: case-021 — the FULL provider/model flow at REAL-PTY level.
// The host (host-021.ts) drives the real app + the real stdin path against
// REAL settings/credentials stores (temp dir) with the DISCOVERY FETCH
// INJECTED (two fake DeepSeek models — no CI network).
//
// The strict asserts: (a) the saved TUI section snapshot — the ProviderEntry
// with the credential REF (never the raw key) + activeProviderId; (b) the
// default-model adoption record (llm.defaultModel = deepseek:deepseek-chat);
// (c) the ui screens (menu / wizard / picker / settings-Models rows) plus the
// byte budget + exit 0.

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

const HOST_FILE = fileURLToPath(new URL("./host-021.ts", import.meta.url))

test(
  "case-021: provider/model flow — /provider wizard (DeepSeek, refs-not-raw) → /model picker → default adoption → /settings Models",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-021.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-021-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["021", `${scene.size[0]}x${scene.size[1]}`],
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

      // (a) the TUI section: refs-only (the RAW key is never in settings),
      // activeProviderId pinned, entry protocol/baseUrl verbatim.
      const tui = JSON.parse(readFileSync(join(markerDir, "tui-section-snapshot.json"), "utf8"))
      expect(tui.providers.version).toBe(1)
      expect(tui.providers.activeProviderId).toBe("deepseek")
      expect(tui.providers.providers.deepseek).toEqual({
        id: "deepseek",
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-compatible",
        apiKeyRef: "DEEPSEEK_API_KEY",
      })
      // the whole settings document never carries the raw key:
      const docText = readFileSync(join(markerDir, "settings-doc-snapshot.json"), "utf8")
      expect(docText).not.toContain("sk-dummy")
      // the credential FILE holds the value (the refs-not-values split):
      const creds = JSON.parse(readFileSync(join(markerDir, "credentials.json"), "utf8"))
      expect(creds.refs.DEEPSEEK_API_KEY).toBe("sk-dummykey-123456")

      // (b) the adoption record: the picker selection became the settings default.
      const dm = JSON.parse(readFileSync(join(markerDir, "default-model.json"), "utf8"))
      expect(dm).toEqual({ provider: "deepseek", model: "deepseek-chat" })
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
