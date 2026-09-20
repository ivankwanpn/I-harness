import { describe, expect, it, afterEach, beforeEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { runHeadless } from "../src/run.ts"

// The plugin mount, end to end through the REAL run.ts wiring (design:
// docs/superpowers/specs/2026-09-17-plugin-mount-design.md).
//
// Before this wiring existed, `runtimeInputs()` had no production consumer at
// all: the deleted TUI read it to DISPLAY (`/plugins`, `/mcps` panels) and the
// assembly's `pluginMcp` / `skills.extraDirs` seams were passed by exactly one
// caller — a test. A plugin's skill could therefore never reach the model.

const FIXTURE_DIR = fileURLToPath(
  // Three levels: apps/cli/test -> apps/cli -> apps -> the repo root.
  new URL("../../../packages/plugin-registry/test/fixtures/marketplace-a", import.meta.url),
)
const HELLO_ID = "Marketplace A__hello"

describe("plugin mount — the registry's runtime inputs reach the agent", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "i-harness-plugin-home-"))
    previous = process.env.IH_CONFIG_DIR
    // The registry root run.ts resolves is `<harness home>/plugins`, and the
    // harness home is this variable. Isolating here is the whole reason the
    // skills global root had to start honouring it.
    process.env.IH_CONFIG_DIR = home
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
  })

  it("a plugin-provided skill is findable by the model in a real run", async () => {
    // Install + enable the committed fixture into THIS home's registry — the same
    // root `runHeadless` resolves internally.
    const registry = new PluginRegistry({ root: join(home, "plugins") })
    await registry.addSource(FIXTURE_DIR)
    await registry.install(HELLO_ID)
    await registry.enable(HELLO_ID)

    const result = await runHeadless("use the hello skill", {
      workspace: home,
      approveAll: true,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "skill_search", args: { query: "hello" } }] },
        { role: "assistant", text: "done" },
      ],
    })
    expect(result.exitCode).toBe(0)

    const results = result.session!.events.filter((e) => e.type === "tool/result") as {
      name: string
      output: unknown
    }[]
    const search = results.find((e) => e.name === "skill_search")
    // THE ASSERTION THAT MATTERS. Without the mount this search returns nothing:
    // the fixture skill lives under `<home>/plugins/skills/…`, which no other
    // root would have pointed the skills scanner at. Workspace is `home` and
    // there is no `<home>/skills`, so the plugin overlay is the only source.
    expect(JSON.stringify(search?.output)).toContain("hello")
    expect(JSON.stringify(search?.output)).toContain("Greets the user by name")
  })

  it("the run is unaffected when the registry is empty", async () => {
    // The ordinary case: no plugins installed. One state read, no directories,
    // and nothing about the agent changes.
    const result = await runHeadless("say hi", {
      workspace: home,
      approveAll: true,
      mockScript: [{ role: "assistant", text: "hi" }],
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toContain("hi")
  })

  // NOT a test of the command registration, and named so it cannot be mistaken
  // for one. A mutation that deletes run.ts's `registerPromptCommand` loop leaves
  // this test GREEN — verified, not assumed — because `HeadlessResult` exposes no
  // assembly context, so there is nothing here to observe a registration in. What
  // it does pin is that the registry OFFERS the fixture's command and that a run
  // carrying one completes. The registration WIRING is therefore uncovered at the
  // integration level; its outcome (`{kind:"prompt"}` rather than a reply) is
  // covered at the unit level in packages/interaction/test/prompt-command.test.ts.
  // Closing the gap means exposing the context on HeadlessResult, which is an API
  // change owed its own decision rather than a test's convenience.
  it("the registry offers the fixture's command, and a run carrying one completes", async () => {
    const registry = new PluginRegistry({ root: join(home, "plugins") })
    await registry.addSource(FIXTURE_DIR)
    await registry.install(HELLO_ID)
    await registry.enable(HELLO_ID)
    expect(registry.runtimeInputs().commandDescriptors.map((d) => d.name)).toContain("hello")

    const result = await runHeadless("hello", {
      workspace: home,
      approveAll: true,
      mockScript: [{ role: "assistant", text: "ok" }],
    })
    expect(result.exitCode).toBe(0)
  })
})

// ── a plugin's agent role reaching a real run ───────────────────────────────
// The SAME differential shape as the skill case above, and for the same reason:
// `runtimeInputs().agentDescriptors` is a new output, and a new output with no
// production consumer is exactly the orphan this audit keeps finding. The
// control run below is the identical script with no plugin installed, so the
// wiring — not the assertion — is what makes the difference.
describe("plugin mount — a plugin's subagent role reaches the agent", () => {
  let home: string
  let previous: string | undefined
  let src: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "i-harness-plugin-agents-home-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
    // A marketplace built here rather than added to the committed fixtures:
    // putting agents/ on `hello` would change every other test's exact runtime
    // shape for the benefit of this one case.
    src = mkdtempSync(join(tmpdir(), "i-harness-plugin-agents-src-"))
    mkdirSync(join(src, ".claude-plugin"), { recursive: true })
    mkdirSync(join(src, "plugins", "helper", "agents"), { recursive: true })
    writeFileSync(
      join(src, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "Agents Mkt", plugins: [{ name: "helper", source: "./plugins/helper" }] }),
      "utf8",
    )
    // NOTE the tools: the plugin writes CLAUDE CODE's vocabulary. Nothing here
    // would resolve without the mount-side translation.
    writeFileSync(
      join(src, "plugins", "helper", "agents", "code-simplifier.md"),
      ["---", "name: code-simplifier", "description: Simplifies code.", "tools: Read, Glob, Grep", "---",
        "You are a code simplification specialist."].join("\n"),
      "utf8",
    )
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  })

  /** The one script both cases run: ask for the plugin's role BY NAME, blocking
   * so the child's turn is deterministic.
   *
   * A FACTORY, not a shared array: createMockClient consumes its script with
   * `shift()` — it is a one-shot cassette. A shared constant made the control
   * run against an exhausted cassette, which ends the run cleanly at exit 0 and
   * made the "no plugin → cannot resolve" control pass for entirely the wrong
   * reason. Caught by that control failing, not by reading the helper. */
  const script = () => [
    { role: "assistant" as const, toolCalls: [{ name: "spawn_agent", args: { message: "simplify", task_name: "helper", agent_type: "code-simplifier", background: false } }] },
    { role: "assistant" as const, text: "child done" }, // the child's turn
    { role: "assistant" as const, text: "parent done" }, // the parent's continuation
  ]

  it("spawn_agent resolves the plugin's role in a real run", async () => {
    const registry = new PluginRegistry({ root: join(home, "plugins") })
    await registry.addSource(src)
    await registry.install("Agents Mkt__helper")
    await registry.enable("Agents Mkt__helper")

    const result = await runHeadless("spawn the simplifier", {
      workspace: home,
      approveAll: true,
      mockScript: script(),
    })

    expect(result.exitCode).toBe(0)
    expect(result.finalText).toContain("parent done")
  })

  it("the control: with no plugin the identical script cannot resolve the role", async () => {
    const result = await runHeadless("spawn the simplifier", {
      workspace: home,
      approveAll: true,
      mockScript: script(),
    })

    // THIS is the control that makes the case above meaningful: the wiring is
    // the only difference. Before M5 T4 block ① the spawn tool's throw ended
    // the run non-zero, and `result.error` — not a tool result — carried the
    // reason. A tool BODY throw is now soft (the turn continues), so the reason
    // is asserted on the channel it travels: the spawn's tool/result.
    expect(result.exitCode).toBe(0)
    const toolResults = result.session!.events.filter((e) => e.type === "tool/result") as {
      name: string
      output: unknown
    }[]
    const spawn = toolResults.find((e) => e.name === "spawn_agent")
    expect(String((spawn?.output as { error?: string } | undefined)?.error)).toContain("unknown role: code-simplifier")

    // …and the role really did not resolve: no child consumed the second script
    // step, so the parent's continuation takes it and says "child done" — while
    // the plugin case (above) reaches "parent done" only because a child DID.
    expect(result.finalText).toContain("child done")
    expect(result.finalText).not.toContain("parent done")
  })
})
