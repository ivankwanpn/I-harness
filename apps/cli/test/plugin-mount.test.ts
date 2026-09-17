import { describe, expect, it, afterEach, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
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
