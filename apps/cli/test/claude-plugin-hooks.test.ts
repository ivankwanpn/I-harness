import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { bashAvailable } from "@i-harness/shell"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { listDeclaredHooks, renderHookTable, runHooksCommand } from "../src/hooks.ts"
import { runHeadless } from "../src/run.ts"

describe("CLI Claude plugin SessionStart hooks", () => {
  let home: string
  let source: string
  let previousHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ih cli claude home "))
    source = mkdtempSync(join(tmpdir(), "ih cli claude source "))
    previousHome = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousHome === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previousHome
    rmSync(home, { recursive: true, force: true })
    rmSync(source, { recursive: true, force: true })
  })

  async function install(options: { count?: number; matcher?: string; unsupported?: boolean } = {}) {
    const plugin = join(source, "plugins", "context")
    mkdirSync(join(plugin, "hooks"), { recursive: true })
    mkdirSync(join(source, ".claude-plugin"), { recursive: true })
    writeFileSync(join(source, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "CLI Claude", plugins: [{ name: "context", source: "./plugins/context" }],
    }))
    // Executions are recorded outside the approved plugin tree so running the
    // hook cannot itself change the content fingerprint being reviewed.
    writeFileSync(join(plugin, "hooks", "start.sh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "read -r input || true",
      'printf \'%s\\n\' "$input" >> "${CLAUDE_PROJECT_DIR}/claude-hook-inputs.jsonl"',
      "printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"CLI_CLAUDE_CONTEXT\"}}'",
      "",
    ].join("\n"))
    const hooks = Array.from({ length: options.count ?? 1 }, () => ({
      type: "command", command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/start.sh"', shell: "bash", async: false,
    }))
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: {
      SessionStart: [{ ...(options.matcher ? { matcher: options.matcher } : {}), hooks }],
      ...(options.unsupported ? { Stop: [{ hooks: [{ type: "command", command: "echo unsupported-stop" }] }] } : {}),
    } }))
    const registry = new PluginRegistry({ root: join(home, "plugins") })
    await registry.addSource(source)
    await registry.install("CLI Claude__context")
    await registry.enable("CLI Claude__context")
    return join(home, "plugins", "CLI Claude__context")
  }

  function captureModel() {
    const requests: LLMRequest[] = []
    const model: ModelClient = {
      async *stream(request) {
        requests.push(request)
        yield { type: "text/chunk", text: "done" }
        yield { type: "end" }
      },
    }
    return { model, requests }
  }

  function inputs() {
    return readFileSync(join(home, "claude-hook-inputs.jsonl"), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line))
  }

  it("lists supported start handlers and diagnoses an unsupported sibling", async () => {
    await install({ count: 2, unsupported: true })
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const rows = await listDeclaredHooks()
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.status === "ungranted" && row.event === "session/start" && row.trustScope === "plugin" && row.sourceEvent === "SessionStart")).toBe(true)
    expect(warning.mock.calls.flat().join("\n")).toContain("Stop")
    expect(renderHookTable(rows)).toContain("plugin contents:")
    expect(renderHookTable(rows)).toContain("same reviewed plugin configuration")
    expect(existsSync(join(home, "claude-hook-inputs.jsonl"))).toBe(false)
  })

  it("approves the reviewed plugin contents for all supported handlers sharing its hash", async () => {
    const plugin = await install({ count: 2 })
    const rows = await listDeclaredHooks()
    expect(rows).toHaveLength(2)
    expect(rows[0]!.sha256).toBe(rows[1]!.sha256)
    expect(await runHooksCommand(["hooks", "approve", rows[0]!.sha256])).toBe(0)
    expect((await listDeclaredHooks()).every(row => row.status === "granted")).toBe(true)
    // A new script body must be reviewed again rather than inheriting the grant.
    writeFileSync(join(plugin, "hooks", "start.sh"), "printf '%s' 'changed content'\n")
    const changed = await listDeclaredHooks()
    expect(changed.every(row => row.status === "ungranted")).toBe(true)
    expect(changed[0]!.sha256).not.toBe(rows[0]!.sha256)
  })

  it("leaves unapproved Claude hooks inert while the model run succeeds", async () => {
    await install({ matcher: "startup|clear|compact" })
    const { model, requests } = captureModel()
    const result = await runHeadless("continue", { workspace: home, sessionId: "cli-unapproved", approveAll: true, model })
    expect(result.error).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(home, "claude-hook-inputs.jsonl"))).toBe(false)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests[0]!.systemPrompt).not.toContain("CLI_CLAUDE_CONTEXT")
  })

  it.skipIf(!bashAvailable())("runs an approved installed hook before the model receives the first prompt", async () => {
    await install({ matcher: "startup|clear|compact" })
    const [row] = await listDeclaredHooks()
    expect(await runHooksCommand(["hooks", "approve", row!.sha256])).toBe(0)
    const { model, requests } = captureModel()
    const result = await runHeadless("continue", { workspace: home, sessionId: "cli-startup", approveAll: true, model })
    expect(result.error).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests[0]!.systemPrompt).toContain("CLI_CLAUDE_CONTEXT")
    expect(inputs()).toEqual([expect.objectContaining({ session_id: "cli-startup", hook_event_name: "SessionStart", source: "startup", cwd: home })])
  })

  it.skipIf(!bashAvailable())("starts an ephemeral run with one stable hook session identity", async () => {
    await install({ count: 2 })
    const [row] = await listDeclaredHooks()
    await runHooksCommand(["hooks", "approve", row!.sha256])
    const { model, requests } = captureModel()
    const result = await runHeadless("continue", { workspace: home, approveAll: true, model })
    expect(result.exitCode).toBe(0)
    expect(requests[0]!.systemPrompt).toContain("CLI_CLAUDE_CONTEXT")
    const received = inputs()
    expect(received).toHaveLength(2)
    expect(typeof received[0].session_id).toBe("string")
    expect(received[0].session_id.length).toBeGreaterThan(0)
    expect(received[1].session_id).toBe(received[0].session_id)
    expect(received.every(input => input.source === "startup")).toBe(true)
  })

  it.skipIf(!bashAvailable())("passes resume to the start matcher instead of calling it startup", async () => {
    await install({ matcher: "resume" })
    const [row] = await listDeclaredHooks()
    await runHooksCommand(["hooks", "approve", row!.sha256])
    const { model, requests } = captureModel()
    const result = await runHeadless("continue", { workspace: home, resumeSessionId: "cli-restored", approveAll: true, model })
    expect(result.exitCode).toBe(0)
    expect(requests[0]!.systemPrompt).toContain("CLI_CLAUDE_CONTEXT")
    expect(inputs()).toEqual([expect.objectContaining({ session_id: "cli-restored", source: "resume" })])
  })

  it("keeps the authored home format strict instead of opting it into plugin compatibility", async () => {
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo home" }] }] } }))
    const { model, requests } = captureModel()
    const result = await runHeadless("continue", { workspace: home, sessionId: "cli-authored", approveAll: true, model })
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain("hook")
    expect(requests).toHaveLength(0)
  })
})
