import { afterEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"
import { createMockClient } from "@i-harness/llm-mock"
import { createHookRegistry, loadHooksConfig, HookBlockedError } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const official = join(import.meta.dirname, "fixtures", "claude-official")
const python = process.env.IH_CLAUDE_TEST_PYTHON ?? (process.platform === "win32"
  ? join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : "/usr/bin/python3")
const jq = process.env.IH_CLAUDE_TEST_JQ ?? (process.platform === "win32"
  ? resolve(import.meta.dirname, "../../../.tmp/claude-hook-test-deps/jq.exe") : "/usr/bin/jq")

async function fixture(name: "hookify" | "ralph-loop") {
  const root = await mkdtemp(join(tmpdir(), "ih-claude-events-")); roots.push(root)
  const plugin = join(root, "plugin with spaces"), cwd = join(root, "project with spaces"), bin = join(root, "bin")
  await cp(join(official, name), plugin, { recursive: true })
  await mkdir(join(cwd, ".claude"), { recursive: true }); await mkdir(bin)
  if (existsSync(python)) await writeFile(join(bin, "python3"), `#!/bin/sh\nexec '${python.replaceAll("\\", "/")}' "$@"\n`, { mode: 0o755 })
  if (existsSync(jq)) await cp(jq, join(bin, process.platform === "win32" ? "jq.exe" : "jq"))
  const configPath = join(plugin, "hooks", "hooks.json"), granted = new Set<string>()
  const approvals = { isApproved: (hash: string) => granted.has(hash), approve: ({ sha256 }: { sha256: string }) => { granted.add(sha256) }, revoke: (hash: string) => { granted.delete(hash) }, list: () => [] }
  const initial = await loadHooksConfig(configPath, plugin, approvals, { claudePluginRoot: plugin })
  for (const handler of initial) granted.add(handler.spec.trust.sha256)
  return { root, plugin, cwd, configPath, approvals, initial,
    env: { PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`, PYTHONDONTWRITEBYTECODE: "1" } }
}

describe("official Claude synchronous command hooks", () => {
  it("normalizes all four official hookify command events into IH handlers", async () => {
    const f = await fixture("hookify")
    expect(f.initial.map(handler => handler.spec.event)).toEqual(["pre-tool", "post-tool", "stop", "prompt/submit"])
    expect(f.initial.every(handler => handler.unapproved && handler.spec.claude?.pluginRoot === f.plugin)).toBe(true)
  })

  it.skipIf(!existsSync(python))("runs the official hookify PreToolUse rule against an IH write alias and blocks its actual side effect", async () => {
    const f = await fixture("hookify")
    await writeFile(join(f.cwd, ".claude", "hookify.protected.local.md"), "---\nname: protect-file\nenabled: true\nevent: file\naction: block\nconditions:\n  - field: file_path\n    operator: regex_match\n    pattern: protected\\.txt$\n---\nProtected file may not be written.\n")
    const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
    const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session, sessionId: "s" })
    const file = join(f.cwd, "protected.txt")
    tools.register({ name: "write", description: "", inputSchema: {}, execute: async () => { await writeFile(file, "should be blocked"); return { ok: true } } })
    try {
      await expect(tools.execute({ name: "write", args: { path: file, text: "blocked" } })).rejects.toBeInstanceOf(HookBlockedError)
      expect(existsSync(file)).toBe(false)
    } finally { await registry.dispose() }
  })

  it.skipIf(!existsSync(python))("delivers official hookify prompt context once across multiple model steps", async () => {
    const f = await fixture("hookify")
    await writeFile(join(f.cwd, ".claude", "hookify.prompt.local.md"), "---\nname: prompt-note\nenabled: true\nevent: prompt\naction: warn\nconditions:\n  - field: user_prompt\n    operator: regex_match\n    pattern: requested\n---\nPrompt-specific guidance.\n")
    const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
    const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session, sessionId: "s" })
    tools.register({ name: "read", description: "", inputSchema: {}, execute: async () => ({ text: "read" }) })
    const script = createMockClient([{ role: "assistant", toolCalls: [{ name: "read", args: { path: "file.txt" } }] }, { role: "assistant", text: "done" }])
    const requests: Parameters<typeof script.stream>[0][] = []
    const agent = createAgent(ctx, { session, tools, sessionId: "s", systemPrompt: "test",
      model: { async *stream(request) { requests.push(structuredClone(request)); yield* script.stream(request) } },
    })
    try {
      await agent.run("requested")
      const notes = session.events.filter(event => event.type === "user/message" && event.source?.kind === "plugin" && event.text.includes("Prompt-specific guidance"))
      expect(notes).toHaveLength(1)
      expect(requests[0]!.messages.at(-1)?.content).toContain("Plugin hook feedback (untrusted")
    } finally { await registry.dispose() }
  })

  it.skipIf(!existsSync(python))("runs the official hookify Stop rule against the projected real assistant transcript", async () => {
    const f = await fixture("hookify")
    await writeFile(join(f.cwd, ".claude", "hookify.verify.local.md"), "---\nname: verify-before-stop\nenabled: true\nevent: stop\naction: block\nconditions:\n  - field: transcript\n    operator: not_contains\n    pattern: VERIFIED_RESULT\n---\nComplete the verification before stopping.\n")
    const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
    const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session, sessionId: "s" })
    const agent = createAgent(ctx, { session, tools, sessionId: "s", systemPrompt: "test",
      model: createMockClient([{ role: "assistant", text: "draft" }, { role: "assistant", text: "VERIFIED_RESULT" }]),
    })
    try {
      expect(await agent.run("requested")).toMatchObject({ finalText: "VERIFIED_RESULT", turns: 2 })
      expect(session.events.filter(event => event.type === "user/message" && event.source?.kind === "plugin")).toMatchObject([
        { text: expect.stringContaining("Complete the verification before stopping.") },
      ])
    } finally { await registry.dispose() }
  })

  it.skipIf(!existsSync(jq))("runs the unmodified official Ralph Loop script through a bounded stop continuation and completion promise", async () => {
    const f = await fixture("ralph-loop")
    const state = join(f.cwd, ".claude", "ralph-loop.local.md")
    await writeFile(state, "---\nactive: true\niteration: 1\nmax_iterations: 4\ncompletion_promise: \"DONE\"\nsession_id: s\n---\nContinue until the task has been verified.\n")
    const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
    const registry = await createHookRegistry(ctx, { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, session, sessionId: "s" })
    const agent = createAgent(ctx, { session, tools, sessionId: "s", systemPrompt: "test",
      model: createMockClient([{ role: "assistant", text: "draft" }, { role: "assistant", text: "<promise>DONE</promise>" }]),
    })
    try {
      expect(await agent.run("requested")).toMatchObject({ finalText: "<promise>DONE</promise>", turns: 2 })
      expect(session.events.filter(event => event.type === "user/message" && event.source?.kind === "plugin")).toMatchObject([
        { text: expect.stringContaining("Continue until the task has been verified.") },
      ])
      expect(existsSync(state)).toBe(false)
    } finally { await registry.dispose() }
  })
})
