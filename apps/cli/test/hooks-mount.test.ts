import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256File } from "@i-harness/hooks"
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
})
