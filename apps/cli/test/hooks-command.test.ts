import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256File, createHookTrustStore, resolveHookTrustPath } from "@i-harness/hooks"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { listDeclaredHooks, parseHooksArgs, renderHookTable, runHooksCommand } from "../src/hooks.ts"

// The CLI face of the D1 grant. The rule is on the engine; this is how a human
// actually GRANTS, which until now nothing could do — a plugin's hook was
// permanently ungranted because no surface existed to approve it.
//
// Shape follows `sessions.ts`: parse → gather → render → run, each piece pure
// and separately testable, with the store shared with the run path so the two
// cannot disagree about where grants live.

describe("parseHooksArgs", () => {
  it("reads the three subcommands and their target", () => {
    expect(parseHooksArgs(["hooks", "list"])).toEqual({ subcommand: "list" })
    expect(parseHooksArgs(["hooks", "approve", "abc123"])).toEqual({ subcommand: "approve", target: "abc123" })
    expect(parseHooksArgs(["hooks", "revoke", "abc123"])).toEqual({ subcommand: "revoke", target: "abc123" })
  })

  it("bare `hooks` is help, not a silent no-op", () => {
    expect(parseHooksArgs(["hooks"])).toEqual({ subcommand: "help" })
    expect(parseHooksArgs(["hooks", "help"])).toEqual({ subcommand: "help" })
  })

  it("approve/revoke without a target is a usage error, never a guess", () => {
    expect(parseHooksArgs(["hooks", "approve"])).toEqual({ subcommand: "help", error: "approve requires a handler hash" })
    expect(parseHooksArgs(["hooks", "revoke"])).toEqual({ subcommand: "help", error: "revoke requires a handler hash" })
  })

  it("an unknown subcommand is reported rather than treated as a target", () => {
    expect(parseHooksArgs(["hooks", "aproove", "x"])).toEqual({ subcommand: "help", error: "unknown hooks subcommand: aproove" })
  })
})

describe("renderHookTable", () => {
  it("shows status, and names the hash a grant would use", () => {
    const out = renderHookTable([
      { source: "home", id: "user-hook", event: "pre-tool", script: "/h/a.cjs", sha256: "a".repeat(64), status: "granted" },
      { source: "plugin:Hooks Mkt__guard", id: "plugin-deny", event: "pre-tool", script: "/p/b.cjs", sha256: "b".repeat(64), status: "ungranted" },
    ])
    expect(out).toContain("user-hook")
    expect(out).toContain("granted")
    expect(out).toContain("plugin-deny")
    expect(out).toContain("ungranted")
    // the hash is what `approve` takes, so it must be printed
    expect(out).toContain("b".repeat(64))
  })

  it("says so when there is nothing declared, rather than printing a bare header", () => {
    expect(renderHookTable([])).toMatch(/no .*hooks/i)
  })
})

describe("runHooksCommand — the grant round trip", () => {
  let home: string
  let previous: string | undefined
  let src: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "i-harness-hookcmd-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home

    src = mkdtempSync(join(tmpdir(), "i-harness-hookcmd-src-"))
    const pdir = join(src, "plugins", "guard")
    mkdirSync(join(pdir, "hooks"), { recursive: true })
    mkdirSync(join(src, ".claude-plugin"), { recursive: true })
    writeFileSync(
      join(src, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "Cmd Mkt", plugins: [{ name: "guard", source: "./plugins/guard" }] }),
      "utf8",
    )
    const handler = join(pdir, "hooks", "deny.cjs")
    writeFileSync(handler, "process.stdout.write('{}')\n", "utf8")
    writeFileSync(
      join(pdir, "hooks", "hooks.json"),
      JSON.stringify({
        version: 1,
        handlers: [{
          id: "plugin-deny", event: "pre-tool", type: "command", matcher: { tool: "read" },
          command: { cmd: process.execPath, args: [handler] },
          trust: { script: handler, sha256: await sha256File(handler) },
        }],
      }, null, 2),
      "utf8",
    )
    const registry = new PluginRegistry({ root: join(home, "plugins") })
    await registry.addSource(src)
    await registry.install("Cmd Mkt__guard")
    await registry.enable("Cmd Mkt__guard")
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  })

  it("lists a plugin's hook as ungranted, then granted after `approve`", async () => {
    const before = await listDeclaredHooks()
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ id: "plugin-deny", event: "pre-tool", status: "ungranted" })
    const hash = before[0]!.sha256

    expect(await runHooksCommand(["hooks", "approve", hash])).toBe(0)

    const after = await listDeclaredHooks()
    expect(after[0]).toMatchObject({ id: "plugin-deny", status: "granted" })
    // and the grant IS the store the run path reads — one location, not two
    expect(createHookTrustStore(resolveHookTrustPath()).isApproved(hash)).toBe(true)
  })

  it("a UNIQUE hash prefix works, and an ambiguous one is refused", async () => {
    const [row] = await listDeclaredHooks()
    expect(await runHooksCommand(["hooks", "approve", row!.sha256.slice(0, 12)])).toBe(0)
    expect(createHookTrustStore(resolveHookTrustPath()).isApproved(row!.sha256)).toBe(true)
    // an unmatched prefix grants nothing and says so
    expect(await runHooksCommand(["hooks", "approve", "f".repeat(12)])).toBe(1)
  })

  it("`revoke` takes the grant back", async () => {
    const [row] = await listDeclaredHooks()
    await runHooksCommand(["hooks", "approve", row!.sha256])
    expect(await runHooksCommand(["hooks", "revoke", row!.sha256])).toBe(0)
    expect(createHookTrustStore(resolveHookTrustPath()).isApproved(row!.sha256)).toBe(false)
    expect((await listDeclaredHooks())[0]!.status).toBe("ungranted")
  })

  it("a fresh home with NO plugins lists nothing and stays quiet", async () => {
    // The ordinary first-run state: `<home>/plugins/state.json` does not exist.
    // Building the registry for a READ-ONLY listing made the plugin layer emit
    // "state file is missing or unreadable … rebuilding defaults" on every
    // invocation — a warning about rebuilding something that was never there.
    // Observed on the real machine, not imagined: `hooks list` printed it.
    const fresh = mkdtempSync(join(tmpdir(), "i-harness-hookcmd-fresh-"))
    process.env.IH_CONFIG_DIR = fresh
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await listDeclaredHooks()).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})
