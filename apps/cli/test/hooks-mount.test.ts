import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHookTrustStore, resolveHookTrustPath, sha256File } from "@i-harness/hooks"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { runHeadless } from "../src/run.ts"

// The hooks policy layer, mounted through the REAL run.ts wiring.
//
// Before this mount `packages/hooks` was one of the repo's zero-consumer
// packages: `createHookRegistry` was a complete binder (pre-tool/post-tool,
// permission, prompt/submit, stop) with no caller at all. This is the caller.
//
// The differential below is the whole point: the SAME script with and without
// `<harness home>/hooks.json`, so it is the FILE that makes the difference —
// which is also what "default off" means here (no file ⇒ zero handlers ⇒ no
// flag to get wrong).

describe("hooks mount — the harness home's hooks.json gates a real run", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "i-harness-hooks-home-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
  })

  /** A command handler that prints ONE JSON object, per the hook stdout contract.
   * `.cjs`, not `.mjs`: the contract is a subprocess that reads stdin and writes
   * one JSON line, and `require` is the tersest way to do it — but `require` is
   * undefined under ESM, so an `.mjs` here dies on startup and the hook FAILS
   * CLOSED. That is the correct behaviour and it made the first version of this
   * test unreadable: it passed the "blocked" assertion for a reason that had
   * nothing to do with the policy, with the tell buried in the error text. */
  const reply = (body: object): string =>
    `process.stdin.resume()\nlet s = ""\nprocess.stdin.on("data", (c) => { s += c })\nprocess.stdin.on("end", () => {\n  JSON.parse(s)\n  process.stdout.write(JSON.stringify(${JSON.stringify(body)}))\n})\n`

  /** Write a `read`-matching pre-tool handler into the home's OWN hooks.json. */
  async function writeBlockingHook(): Promise<void> {
    const script = join(home, "deny-read.cjs")
    writeFileSync(script, reply({ block: true, reason: "policy says no" }), "utf8")
    const sha256 = await sha256File(script)
    writeFileSync(
      join(home, "hooks.json"),
      JSON.stringify({
        version: 1,
        handlers: [{
          id: "deny-read",
          event: "pre-tool",
          type: "command",
          matcher: { tool: "read" },
          command: { cmd: process.execPath, args: [script] },
          trust: { script, sha256 },
        }],
        // The home's OWN config, so every declared hash here is self-granting
        // under D1 — no approval store is involved, and this file proves the
        // self-granting half still works after the rule landed.
      }, null, 2),
      "utf8",
    )
  }

  /** The one script both cases run: one `read` call, then a closing turn. */
  const script = () => [
    { role: "assistant" as const, toolCalls: [{ name: "read", args: { path: join(home, "nothing.txt") } }] },
    { role: "assistant" as const, text: "after the call" },
  ]

  it("the hook fires and its block reason reaches the run", async () => {
    await writeBlockingHook()
    const result = await runHeadless("read a file", { workspace: home, approveAll: true, mockScript: script() })
    // The block is OBSERVABLE in the log rather than inferred from the exit code:
    // a `pre-tool` block throws HookBlockedError out of the tool, so what lands
    // is the handler's own reason string.
    expect(JSON.stringify({ error: result.error, events: result.session?.events })).toContain("policy says no")
  })

  it("the control: with NO hooks.json the identical script is not blocked", async () => {
    const result = await runHeadless("read a file", { workspace: home, approveAll: true, mockScript: script() })
    expect(JSON.stringify({ error: result.error, events: result.session?.events })).not.toContain("policy says no")
  })

  // ── a PLUGIN's hooks, which is another tree's config ──────────────────────
  // The whole point of D1, end to end: a plugin can DECLARE a `pre-tool` hook
  // that vetoes tools, and it does not take effect until the user grants that
  // exact script hash. Both halves below run the same plugin; the difference is
  // one entry in the user-layer store.
  async function installPluginWithHook(): Promise<string> {
    const src = mkdtempSync(join(tmpdir(), "i-harness-plugin-hooks-src-"))
    const pdir = join(src, "plugins", "guard")
    mkdirSync(join(pdir, "hooks"), { recursive: true })
    mkdirSync(join(src, ".claude-plugin"), { recursive: true })
    writeFileSync(
      join(src, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "Hooks Mkt", plugins: [{ name: "guard", source: "./plugins/guard" }] }),
      "utf8",
    )
    const handler = join(pdir, "hooks", "deny.cjs")
    writeFileSync(handler, reply({ block: true, reason: "plugin policy says no" }), "utf8")
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
    await registry.install("Hooks Mkt__guard")
    await registry.enable("Hooks Mkt__guard")
    return handler
  }

  it("a plugin's hook is NOT enforced until the user grants its hash", async () => {
    await installPluginWithHook()
    const result = await runHeadless("read a file", { workspace: home, approveAll: true, mockScript: script() })
    // Declared but ungranted: it neither enforces nor blocks.
    expect(JSON.stringify({ error: result.error, events: result.session?.events })).not.toContain("plugin policy says no")
  })

  it("...and IS enforced once that exact hash is approved", async () => {
    const handler = await installPluginWithHook()
    // The grant: the user approves the SCRIPT's hash, which is the only object
    // worth trusting — an id is chosen by the declaring layer and a path can be
    // repointed.
    createHookTrustStore(resolveHookTrustPath()).approve({
      sha256: await sha256File(handler),
      script: handler,
      handlerId: "plugin-deny",
    })
    const result = await runHeadless("read a file", { workspace: home, approveAll: true, mockScript: script() })
    expect(JSON.stringify({ error: result.error, events: result.session?.events })).toContain("plugin policy says no")
  })

  it("a plugin whose hooks.json is in CLAUDE CODE's format does not brick the run", async () => {
    // THE SHAPE THAT MATTERS, and the normal one: our plugin model reads Claude
    // Code's marketplace, and CC plugins ship `hooks/hooks.json` as
    // `{hooks: {<Event>: [...]}}` — the official snapshot has several (hookify,
    // security-guidance, explanatory-output-style, ...). Our loader wants
    // `{version: 1, handlers: [...]}`, so it refuses the file.
    //
    // Refusing is right. REFUSING FATALLY IS NOT. Measured 2026-09-19 against
    // the real home: with `superpowers` enabled — a CC plugin shipping exactly
    // this shape — every runHeadless exited 1 with "hooks config version must be
    // 1", including runs that never touch a hook. The plugin mount's own comment
    // already says a plugin's hooks are "neither enforced nor allowed to block";
    // an unparseable config was the one door left open on that rule, and this is
    // the same "a plugin could brick the agent" bug (c0b941d0) through it.
    const src = mkdtempSync(join(tmpdir(), "i-harness-plugin-ccfmt-"))
    const pdir = join(src, "plugins", "ccfmt")
    mkdirSync(join(pdir, "hooks"), { recursive: true })
    mkdirSync(join(src, ".claude-plugin"), { recursive: true })
    writeFileSync(
      join(src, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "CC Fmt Mkt", plugins: [{ name: "ccfmt", source: "./plugins/ccfmt" }] }),
      "utf8",
    )
    writeFileSync(
      join(pdir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: "startup|clear", hooks: [{ type: "command", command: "echo hi", shell: "bash" }] }],
        },
      }, null, 2),
      "utf8",
    )
    const registry = new PluginRegistry({ root: join(home, "plugins") })
    await registry.addSource(src)
    await registry.install("CC Fmt Mkt__ccfmt")
    await registry.enable("CC Fmt Mkt__ccfmt")

    const result = await runHeadless("read a file", { workspace: home, approveAll: true, mockScript: script() })
    // The run completes. The plugin's hooks contribute nothing — which is the
    // same outcome as an ungranted declaration, and the one its author intended.
    expect(result.error).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
})
