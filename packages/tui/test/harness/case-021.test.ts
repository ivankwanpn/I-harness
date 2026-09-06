// M49 Task 6: case-021 — the Models & Providers flow at REAL-PTY level.
// The host (host-021.ts) drives the real app + the real stdin path against
// REAL settings/credentials stores (temp dir) with the DISCOVERY PROBE and
// the building CLIENT INJECTED (two fake DeepSeek models + the literal
// `fixture response` — no CI network).
//
// The strict asserts: (a) the saved settings document — canonical
// llm.providers with the credential REF (never the raw key), the discovery
// merge (manual + discovered models) and NO tui.providers section; (b) the
// adopted default {deepseek, deepseek-reasoner}; (c) the client actually
// received `hello` and the screen shows the literal `fixture response`.

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
  "case-021: Models & Providers flow — canonical llm.providers + refs-only → discovery merge → default selection → fixture response",
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

      // (a) the CANONICAL llm section: refs-only (the RAW key never lands in
      // settings), the protocol/baseURL canonical, the discovery merge kept
      // BOTH the manual row and the discovered one.
      const llm = JSON.parse(readFileSync(join(markerDir, "llm-section-snapshot.json"), "utf8"))
      expect(llm.providers.deepseek).toEqual({
        baseURL: "https://api.deepseek.com",
        protocol: "openai-completions",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [
          { id: "deepseek-chat", name: "DeepSeek Chat" },
          { id: "deepseek-reasoner", name: "DeepSeek R1" },
        ],
      })
      // the whole settings document never carries the raw key OR the legacy
      // provider section:
      const docText = readFileSync(join(markerDir, "settings-doc-snapshot.json"), "utf8")
      expect(docText).not.toContain("sk-dummy")
      expect(docText).not.toContain('"activeProviderId"')
      expect(docText).not.toContain('"apiKeyRef"')
      // the credential FILE holds the value (the refs-not-values split):
      const creds = JSON.parse(readFileSync(join(markerDir, "credentials.json"), "utf8"))
      expect(creds.refs.DEEPSEEK_API_KEY).toBe("sk-dummykey-123456")

      // (b) the discovered model became the durable default.
      expect(llm.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-reasoner" })

      // (c) the injected client received `hello` and streamed the response.
      const request = JSON.parse(readFileSync(join(markerDir, "client-request.json"), "utf8"))
      expect(request.prompt).toBe("hello")
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
