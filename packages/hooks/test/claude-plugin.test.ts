import { afterEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createHookRegistry, HookConfigError, HookOutputError, HookTrustError, loadHooksConfig, runHookHandler, sha256File, validateHookOutput } from "../src/index.ts"
import { resolveClaudeShell } from "../src/claude.ts"

const roots: string[] = []
afterEach(async () => { delete process.env.IH_CONFIG_DIR; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function document(hooks = [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start', shell: "bash", async: false }], matcher = "startup|clear|compact") {
  return { hooks: { SessionStart: [{ matcher, hooks }] } }
}

async function fixture(body: unknown = document(), script?: string) {
  const root = await mkdtemp(join(tmpdir(), "ih-claude-")); roots.push(root)
  // Dollar syntax is literal path data, not an executable shell fragment.
  const plugin = join(root, "plugin space $(untrusted)")
  const cwd = join(root, "project"), configPath = join(plugin, "hooks", "hooks.json")
  await mkdir(join(plugin, "hooks"), { recursive: true }); await mkdir(cwd)
  await mkdir(join(plugin, "skills", "using-superpowers"), { recursive: true })
  await writeFile(join(plugin, "skills", "using-superpowers", "SKILL.md"), "trusted startup skill")
  await writeFile(join(plugin, "hooks", "run-hook.cmd"), ": << 'CMDBLOCK'\n@echo off\nset \"HOOK_DIR=%~dp0\"\nbash \"%HOOK_DIR%%~1\" %2 %3 %4 %5 %6 %7 %8 %9\nexit /b %ERRORLEVEL%\nCMDBLOCK\nSCRIPT_DIR=\"$(cd \"$(dirname \"$0\")\" && pwd)\"\nSCRIPT_NAME=\"$1\"\nshift\nexec bash \"${SCRIPT_DIR}/${SCRIPT_NAME}\" \"$@\"\n", { mode: 0o755 })
  await writeFile(join(plugin, "hooks", "session-start"), script ?? "#!/usr/bin/env bash\nset -euo pipefail\ninput=$(cat)\nprintf '%s' \"$input\" > \"$HOOK_CAPTURE\"\nprintf x >> \"$HOOK_COUNTER\"\nskill=$(cat \"${CLAUDE_PLUGIN_ROOT}/skills/using-superpowers/SKILL.md\")\nprintf '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"%s\"}}' \"$skill\"\n", { mode: 0o755 })
  await writeFile(configPath, JSON.stringify(body))
  const counter = join(cwd, "counter.txt"), capture = join(cwd, "input.json")
  const env = { HOOK_COUNTER: counter, HOOK_CAPTURE: capture }
  return { root, plugin, cwd, configPath, counter, capture, env }
}

function store(granted = new Set<string>()) {
  return { isApproved: (hash: string) => granted.has(hash), approve: ({ sha256 }: { sha256: string }) => { granted.add(sha256) }, revoke: (hash: string) => { granted.delete(hash) }, list: () => [] }
}

async function approvedFixture(body?: unknown, script?: string) {
  const f = await fixture(body, script), approvals = store()
  const [initial] = await loadHooksConfig(f.configPath, f.plugin, approvals, { claudePluginRoot: f.plugin })
  expect(initial).toBeDefined()
  approvals.approve({ sha256: initial!.spec.trust.sha256 })
  const [loaded] = await loadHooksConfig(f.configPath, f.plugin, approvals, { claudePluginRoot: f.plugin })
  return { ...f, approvals, spec: loaded!.spec }
}

describe("explicit Claude plugin SessionStart adaptation", () => {
  it("loads installed superpowers shape as an unapproved plugin bundle without self-grant", async () => {
    const f = await fixture(); process.env.IH_CONFIG_DIR = join(f.plugin, "hooks")
    const [loaded] = await loadHooksConfig(f.configPath, f.plugin, undefined, { claudePluginRoot: f.plugin })
    expect(loaded).toMatchObject({ valid: false, unapproved: true, spec: { event: "session/start", type: "command", claude: { pluginRoot: f.plugin, event: "SessionStart", matcher: "startup|clear|compact", trustScope: "plugin-tree-v1" } } })
    expect(loaded!.spec.trust.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(loaded!.spec.trust.script).toBe(f.configPath)
  })

  it("reports unsupported handlers individually and retains the supported startup command", async () => {
    const body = { hooks: { ...document().hooks, PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }], SessionStart: [{ hooks: [{ type: "command", command: "echo supported" }, { type: "command", command: "echo background", async: true }, { type: "prompt", prompt: "inspect" }, { type: "command", command: "echo conditional", if: "${CLAUDE_PLUGIN_ROOT}/check" }] }] } }
    const f = await fixture(body), diagnostics: Array<{ id: string; event: string; message: string }> = []
    const handlers = await loadHooksConfig(f.configPath, f.plugin, undefined, { claudePluginRoot: f.plugin, onUnsupported: diagnostic => diagnostics.push(diagnostic) })
    expect(handlers).toHaveLength(1)
    expect(diagnostics).toHaveLength(4)
    expect(diagnostics.map(row => row.event)).toEqual(["SessionStart", "SessionStart", "SessionStart", "PreToolUse"])
    expect(diagnostics.every(row => row.id && row.message)).toBe(true)
  })

  it("reports the exec args form without silently dropping its arguments", async () => {
    const f = await fixture({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo supported" }, { type: "command", command: "echo exec", args: ["literal argument"] }] }] } }), diagnostics: Array<{ id: string; event: string; message: string }> = []
    const handlers = await loadHooksConfig(f.configPath, f.plugin, undefined, { claudePluginRoot: f.plugin, onUnsupported: diagnostic => diagnostics.push(diagnostic) })
    expect(handlers).toHaveLength(1); expect(diagnostics).toHaveLength(1); expect(diagnostics[0]!.message).toMatch(/args|exec/i)
  })

  it.each([ { hooks: { SessionStart: [{ hooks: "bad" }] } }, { hooks: { SessionStart: [{ matcher: "[", hooks: [{ type: "command", command: "echo x" }] }] } }, { hooks: { SessionStart: [{ hooks: [{ type: "command", command: 42 }] }] } } ])("rejects malformed Claude declarations instead of declaring them ready", async body => {
    const f = await fixture(body)
    await expect(loadHooksConfig(f.configPath, f.plugin, undefined, { claudePluginRoot: f.plugin })).rejects.toBeInstanceOf(HookConfigError)
  })

  it("never accepts runtime Claude metadata in a native declaration", async () => {
    const f = await approvedFixture()
    await writeFile(f.configPath, JSON.stringify({ version: 1, handlers: [f.spec] }))
    await expect(loadHooksConfig(f.configPath, f.plugin, { isApproved: () => true }, { claudePluginRoot: f.plugin })).rejects.toBeInstanceOf(HookConfigError)
  })

  it("requires the configured hooks file to remain inside the approved plugin root", async () => {
    const f = await fixture(); const other = join(f.root, "external.json"); await writeFile(other, JSON.stringify(document()))
    await expect(loadHooksConfig(other, f.plugin, undefined, { claudePluginRoot: f.plugin })).rejects.toBeInstanceOf(HookConfigError)
  })

  it.each(["hooks/session-start", "skills/using-superpowers/SKILL.md", "hooks/hooks.json"])("invalidates approval when %s changes in the plugin tree", async file => {
    const f = await approvedFixture()
    await writeFile(join(f.plugin, file), file.endsWith("json") ? JSON.stringify(document([{ type: "command", command: "echo changed", shell: "bash", async: false }])) : "changed bytes")
    await expect(runHookHandler(f.spec, { event: "session/start", sessionId: "s" }, f.plugin, { env: f.env, cwd: f.cwd })).rejects.toBeInstanceOf(HookTrustError)
    expect(existsSync(f.counter)).toBe(false)
    const [fresh] = await loadHooksConfig(f.configPath, f.plugin, f.approvals, { claudePluginRoot: f.plugin })
    expect(fresh).toMatchObject({ valid: false, unapproved: true })
  })

  it("ignores Git metadata while binding every runtime file to the bundle approval", async () => {
    const f = await approvedFixture(); await mkdir(join(f.plugin, ".git")); await writeFile(join(f.plugin, ".git", "HEAD"), "ref: refs/heads/main")
    const [same] = await loadHooksConfig(f.configPath, f.plugin, f.approvals, { claudePluginRoot: f.plugin })
    expect(same!.valid).toBe(true)
    await writeFile(join(f.plugin, "new-runtime-file"), "added")
    const [changed] = await loadHooksConfig(f.configPath, f.plugin, f.approvals, { claudePluginRoot: f.plugin })
    expect(changed).toMatchObject({ valid: false, unapproved: true })
  })

  it("rejects linked directories instead of trusting bytes outside the plugin", async () => {
    const f = await fixture(), external = join(f.root, "external"); await mkdir(external); await writeFile(join(external, "secret"), "outside")
    await symlink(external, join(f.plugin, "linked"), process.platform === "win32" ? "junction" : "dir")
    await expect(loadHooksConfig(f.configPath, f.plugin, { isApproved: () => true }, { claudePluginRoot: f.plugin })).rejects.toBeInstanceOf(HookConfigError)
  })

  it("refuses an oversized plugin bundle before reading or granting the artifact", async () => {
    const f = await fixture(), artifact = await open(join(f.plugin, "too-large.dat"), "w")
    try { await artifact.truncate(65 * 1024 * 1024) } finally { await artifact.close() }
    await expect(loadHooksConfig(f.configPath, f.plugin, { isApproved: () => true }, { claudePluginRoot: f.plugin })).rejects.toBeInstanceOf(HookConfigError)
  })
})

describe("trusted startup execution and context lifetime", () => {
  it.each([
    ["success then exit failure", false, "exit 7"],
    ["exit failure then success", true, "exit 7"],
    ["success then output failure", false, "printf '{\"additionalContext\":42}'"],
    ["output failure then success", true, "printf '{\"additionalContext\":42}'"],
  ] as const)("retains a successful sibling and its dedupe after %s", async (_name, failureFirst, failure) => {
    const good = { type: "command", command: "printf x >> \"$HOOK_COUNTER\"; printf 'successful sibling context'" }, bad = { type: "command", command: failure }
    const f = await approvedFixture({ hooks: { SessionStart: [{ hooks: failureFirst ? [bad, good] : [good, bad] }] } }), errors: unknown[] = []
    const registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: error => errors.push(error) })
    try {
      await registry.beginSession("s"); expect(registry.context()).toBe("successful sibling context")
      expect(errors).toHaveLength(1)
      await registry.beginSession("s"); expect(registry.context()).toBe("successful sibling context")
      expect(errors).toHaveLength(2); expect(await readFile(f.counter, "utf8")).toBe("x")
    } finally { await registry.dispose() }
  })

  it("withdraws successful sibling context if another command tampers with the shared plugin bundle", async () => {
    const f = await approvedFixture({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "printf 'must be withdrawn'" }, { type: "command", command: "printf changed > \"${CLAUDE_PLUGIN_ROOT}/skills/using-superpowers/SKILL.md\"; printf 'must not publish'" }] }] } }), errors: unknown[] = []
    const registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: error => errors.push(error) })
    try { await registry.beginSession("s"); expect(registry.context()).toBe(""); expect(errors.some(error => error instanceof HookTrustError)).toBe(true) } finally { await registry.dispose() }
  })

  it("executes the wrapper through native Bash, sends Claude stdin, and injects the trusted skill once", async () => {
    const f = await approvedFixture(), errors: unknown[] = []
    const registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: error => errors.push(error) })
    try {
      await registry.beginSession("new-session", "startup")
      expect(registry.context()).toBe("trusted startup skill")
      expect(JSON.parse(await readFile(f.capture, "utf8"))).toMatchObject({ session_id: "new-session", hook_event_name: "SessionStart", source: "startup", cwd: f.cwd })
      await registry.beginSession("new-session", "startup")
      const refresh = registry.refreshTrust(f.approvals)
      expect(registry.context()).toBe("")
      await refresh
      await registry.beginSession("new-session", "startup")
      expect(await readFile(f.counter, "utf8")).toBe("x")
      expect(registry.context()).toBe("trusted startup skill")
      expect(errors).toEqual([])
    } finally { await registry.dispose() }
  })

  it("does not execute or inject a startup-only matcher while resuming a session", async () => {
    const f = await approvedFixture(), registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: () => {} })
    try { await registry.beginSession("existing", "resume"); expect(registry.context()).toBe(""); expect(existsSync(f.counter)).toBe(false) } finally { await registry.dispose() }
  })

  it("clears context on revocation and runs newly approved startup without replaying an unchanged approval", async () => {
    const f = await approvedFixture(), registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: () => {} })
    try {
      await registry.beginSession("s"); expect(registry.context()).toBe("trusted startup skill")
      f.approvals.revoke(f.spec.trust.sha256); await registry.refreshTrust(f.approvals)
      expect(registry.context()).toBe(""); await registry.beginSession("s"); expect(await readFile(f.counter, "utf8")).toBe("x")
      f.approvals.approve({ sha256: f.spec.trust.sha256 }); await registry.refreshTrust(f.approvals); await registry.beginSession("s")
      expect(registry.context()).toBe("trusted startup skill"); expect(await readFile(f.counter, "utf8")).toBe("xx")
    } finally { await registry.dispose() }
  })

  it("rechecks cached startup trust before reuse and clears context when a referenced skill changed", async () => {
    const f = await approvedFixture(), errors: unknown[] = [], registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: error => errors.push(error) })
    try {
      await registry.beginSession("s"); expect(registry.context()).toBe("trusted startup skill")
      await writeFile(join(f.plugin, "skills", "using-superpowers", "SKILL.md"), "edited")
      await registry.beginSession("s")
      expect(registry.context()).toBe(""); expect(await readFile(f.counter, "utf8")).toBe("x"); expect(errors.some(error => error instanceof HookTrustError)).toBe(true)
    } finally { await registry.dispose() }
  })

  it.each([ ["plain context", "printf 'plain trusted context'", "plain trusted context"], ["numbered prose", "printf '1. Read the startup skill'", "1. Read the startup skill"], ["incomplete object text", "printf '{incomplete'", "{incomplete"], ["array text", "printf '[1,2]'", "[1,2]"], ["numeric text", "printf 2026", "2026"], ["top-level context", "printf '{\"additionalContext\":\"top-level trusted context\"}'", "top-level trusted context"], ["empty output", "true", ""] ])("accepts %s from an approved synchronous startup command", async (_name, script, expected) => {
    const f = await approvedFixture(undefined, script), output = await runHookHandler(f.spec, { event: "session/start", sessionId: "s" }, f.plugin, { env: f.env, cwd: f.cwd })
    expect(output.additionalContext ?? "").toBe(expected)
  })

  it("rejects oversized startup stdout before it can enter session context", async () => {
    const f = await approvedFixture(undefined, "head -c 70000 /dev/zero | tr '\\000' x")
    const error = await runHookHandler(f.spec, { event: "session/start", sessionId: "s" }, f.plugin, { env: f.env, cwd: f.cwd }).then(() => undefined, error => error)
    expect(error).toBeInstanceOf(HookOutputError)
  })

  it("isolates the Claude branch from inherited Cursor and Copilot plugin indicators", async () => {
    const f = await approvedFixture(undefined, "if [ -n \"${CURSOR_PLUGIN_ROOT:-}\" ] || [ -n \"${COPILOT_CLI:-}\" ]; then printf 'wrong host'; else printf 'Claude host'; fi")
    const output = await runHookHandler(f.spec, { event: "session/start", sessionId: "s" }, f.plugin, { env: { ...f.env, CURSOR_PLUGIN_ROOT: "foreign root", COPILOT_CLI: "1" }, cwd: f.cwd })
    expect(output.additionalContext).toBe("Claude host")
  })

  it.skipIf(process.platform !== "win32")("does not inject context or claim a ready handler when only WSL Bash is available", async () => {
    const f = await approvedFixture(), errors: unknown[] = [], registry = await createHookRegistry(createContext(), { ...f, env: { ...f.env, ProgramFiles: join(f.root, "empty"), "ProgramFiles(x86)": join(f.root, "empty"), PATH: "C:\\Windows\\System32" }, configDir: f.plugin, claudePluginRoot: f.plugin, report: error => errors.push(error) })
    try { await registry.beginSession("s"); expect(registry.context()).toBe(""); expect(existsSync(f.counter)).toBe(false); expect(errors.some(error => error instanceof HookConfigError && /native Git Bash/.test(error.message))).toBe(true) } finally { await registry.dispose() }
  })

  it("dedupes concurrent startup calls while a trusted command is still running", async () => {
    const f = await approvedFixture(undefined, "printf x >> \"$HOOK_COUNTER\"\nsleep 0.1\nprintf 'once context'"), registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: () => {} })
    try { await Promise.all([registry.beginSession("s"), registry.beginSession("s")]); expect(await readFile(f.counter, "utf8")).toBe("x"); expect(registry.context()).toBe("once context") } finally { await registry.dispose() }
  })

  it("drops context immediately if the shared approval was revoked without a completed refresh", async () => {
    const f = await approvedFixture(), registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: () => {} })
    try { await registry.beginSession("s"); expect(registry.context()).toBe("trusted startup skill"); f.approvals.revoke(f.spec.trust.sha256); expect(registry.context()).toBe("") } finally { await registry.dispose() }
  })

  it.each([ "printf '{\"additionalContext\":42}'", "printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"bad\"}}'", "printf '{bad syntax}'", "printf '{\"hookSpecificOutput\":{\"additionalContext\":\"missing event\"}}'", "exit 7" ])("rejects failed or malformed startup output", async script => {
    const f = await approvedFixture(undefined, script)
    await expect(runHookHandler(f.spec, { event: "session/start", sessionId: "s" }, f.plugin, { env: f.env, cwd: f.cwd })).rejects.toBeInstanceOf(HookOutputError)
    expect(() => validateHookOutput({ additionalContext: "foreign" }, "native")).toThrow(HookOutputError)
  })

  it.each(["revoke", "dispose", "new session"] as const)("never publishes in-flight startup context after %s", async action => {
    const f = await approvedFixture(undefined, "printf x > \"$HOOK_COUNTER\"\nwhile [ ! -f \"$HOOK_CAPTURE\" ]; do sleep 0.02; done\nprintf 'late context'"), registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: () => {} })
    try {
      const pending = registry.beginSession("s")
      for (let attempt = 0; attempt < 100 && !existsSync(f.counter); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(existsSync(f.counter)).toBe(true)
      if (action === "revoke") { f.approvals.revoke(f.spec.trust.sha256); await registry.refreshTrust(f.approvals) }
      else if (action === "dispose") await registry.dispose()
      else await registry.beginSession("different", "resume")
      await writeFile(f.capture, "release")
      await pending
      expect(registry.context()).toBe("")
    } finally { await registry.dispose() }
  })

  it("does not let an obsolete failed run clear the newly approved generation's context", async () => {
    const f = await approvedFixture(undefined, "if [ ! -f \"$HOOK_COUNTER\" ]; then\nprintf x > \"$HOOK_COUNTER\"\nwhile [ ! -f \"$HOOK_CAPTURE\" ]; do sleep 0.02; done\nexit 7\nfi\nprintf 'current context'"), errors: unknown[] = [], registry = await createHookRegistry(createContext(), { ...f, configDir: f.plugin, claudePluginRoot: f.plugin, report: error => errors.push(error) })
    try {
      const old = registry.beginSession("s")
      for (let attempt = 0; attempt < 100 && !existsSync(f.counter); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(existsSync(f.counter)).toBe(true)
      f.approvals.revoke(f.spec.trust.sha256); await registry.refreshTrust(f.approvals)
      f.approvals.approve({ sha256: f.spec.trust.sha256 }); await registry.refreshTrust(f.approvals)
      await registry.beginSession("s"); expect(registry.context()).toBe("current context")
      await writeFile(f.capture, "release old"); await old
      expect(registry.context()).toBe("current context"); expect(errors).toEqual([])
    } finally { await registry.dispose() }
  })
})

describe("Claude hook native shell selection", () => {
  it("pins Git Bash ahead of WSL launchers and other PATH bash executables", () => {
    const installed = new Set(["C:\\Windows\\System32\\bash.exe", "D:\\Other\\bash.exe", "C:\\Programs\\Git\\bin\\bash.exe"])
    expect(resolveClaudeShell("bash", { ProgramFiles: "C:\\Programs", PATH: "C:\\Windows\\System32;D:\\Other" }, "win32", file => installed.has(file))).toBe("C:\\Programs\\Git\\bin\\bash.exe")
  })
  it("reports native Bash unavailable instead of falling back to a WSL launcher", () => {
    expect(() => resolveClaudeShell("bash", { ProgramFiles: "C:\\Empty", "ProgramFiles(x86)": "C:\\Empty", PATH: "C:\\Windows\\System32;C:\\User\\WindowsApps" }, "win32", file => /(?:System32|WindowsApps)\\bash\.exe$/.test(file))).toThrow(HookConfigError)
  })
  it("discovers Git Bash relative to Git on PATH when installed outside Program Files", () => {
    const installed = new Set(["D:\\Tools\\Git\\cmd\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe"])
    expect(resolveClaudeShell("bash", { ProgramFiles: "C:\\Empty", "ProgramFiles(x86)": "C:\\Empty", PATH: "D:\\Tools\\Git\\cmd" }, "win32", file => installed.has(file))).toBe("D:\\Tools\\Git\\bin\\bash.exe")
  })
})

it("preserves native startup observer replay and detached-registry lifecycle behavior", async () => {
  const f = await fixture(), script = join(f.plugin, "native.cjs")
  await writeFile(script, `require('node:fs').appendFileSync(process.env.HOOK_COUNTER, 'x'); console.log('{}')`)
  const hash = await sha256File(script), approvals = store(new Set([hash]))
  await writeFile(f.configPath, JSON.stringify({ version: 1, handlers: [{ id: "native", event: "session/start", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256: hash } }] }))
  const registry = await createHookRegistry(createContext(), { ...f, approvals, configDir: f.plugin })
  try {
    await registry.beginSession("s"); await registry.beginSession("s")
    expect(await readFile(f.counter, "utf8")).toBe("xx"); expect(registry.context()).toBe("")
    await registry.dispose(); await expect(registry.beginSession("s")).resolves.toBeUndefined()
    expect(await readFile(f.counter, "utf8")).toBe("xx")
  } finally { await registry.dispose() }
})
