import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSession, type Session, type SessionEvent } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { RUNTIME_CONTEXT_SOURCE_PLUGIN } from "@i-harness/runtime-context"
import { createSessionAssembly } from "../src/assembly.ts"
import { rmWorkspaceSync } from "./helpers.ts"

// M6 batch C, C1 (spec 2026-09-21-m6-breadth-design §3.2): the skills
// catalogue, end to end through the REAL assembly. The section's own unit test
// (packages/skills/test/section.test.ts) calls the getter directly; what only
// this file can show is the wiring — the registry the tools read is the
// registry the section renders, the boundary is `agent/pre-step`, and the
// artifact is the snapshot in the session log.
//
// The property is the acceptance table's first row: a changed catalogue appends
// exactly one line, an unchanged one appends NOTHING (the every-step-log-line
// shape must not come back).

function writeSkill(root: string, name: string, description: string): void {
  mkdirSync(join(root, "skills", name), { recursive: true })
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

function snapshots(session: Session): string[] {
  return session.events
    .filter(
      (e): e is Extract<SessionEvent, { type: "user/message" }> =>
        e.type === "user/message" && e.source?.kind === "plugin" && e.source.plugin === RUNTIME_CONTEXT_SOURCE_PLUGIN,
    )
    .map((e) => e.text)
}

describe("the skills catalogue through the assembly (M6 C1)", () => {
  it("appends exactly one `## skills` snapshot; nothing while the set is fixed; one more when a skill appears", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ih-assembly-skills-"))
    const home = mkdtempSync(join(tmpdir(), "ih-assembly-skills-home-"))
    const previousHome = process.env.IH_CONFIG_DIR
    writeSkill(ws, "alpha", "Alpha skill")
    // An instructions file, so the render ORDER of the two sections is
    // observable in the same snapshot (registration order = render order).
    writeFileSync(join(ws, "AGENTS.md"), "always run the tests\n")
    // The global skills root is a real directory on the machine running this
    // test. `$IH_CONFIG_DIR` is this repo's isolation contract (e2e/helpers.ts:29);
    // without pinning it the snapshot would carry the developer's own skills.
    process.env.IH_CONFIG_DIR = home
    // The OUTER finally owns the env var, not just the assertions: a mount that
    // throws must not leave this worker pinned to a temp home that the inner
    // cleanup then deletes — later files sharing the worker would read it.
    try {
      const session = createSession()
      const assembly = await createSessionAssembly({
        workspace: ws,
        session,
        model: createMockClient([{ role: "assistant", text: "ok" }]),
        approveAll: true,
      })
      try {
        const step = async (): Promise<void> => {
          await assembly.ctx.emit("agent/pre-step", { task: "step", session: assembly.session })
        }

        await step()
        const first = snapshots(session)
        expect(first).toHaveLength(1)
        const text = first[0]!
        expect(text).toContain("## skills\n\n- `alpha` — Alpha skill")
        expect(text.indexOf("## instructions")).toBeGreaterThanOrEqual(0)
        expect(text.indexOf("## instructions")).toBeLessThan(text.indexOf("## skills"))
        // Harness bookkeeping, not something the user typed (M59's internal flag,
        // the same one every runtime-context snapshot carries).
        expect(session.events.find((e) => e.type === "user/message")).toMatchObject({
          type: "user/message",
          internal: true,
          source: { kind: "plugin", plugin: RUNTIME_CONTEXT_SOURCE_PLUGIN },
        })

        // The set is unchanged: the next boundary appends NOTHING.
        const afterFirstStep = session.events.length
        await step()
        expect(session.events.length).toBe(afterFirstStep)
        expect(snapshots(session)).toHaveLength(1)

        // One new skill ⇒ exactly one new snapshot, carrying both lines.
        writeSkill(ws, "beta", "Beta skill")
        await step()
        const all = snapshots(session)
        expect(all).toHaveLength(2)
        expect(all[1]).toContain("- `alpha` — Alpha skill")
        expect(all[1]).toContain("- `beta` — Beta skill")
      } finally {
        await assembly.dispose()
      }
    } finally {
      if (previousHome === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = previousHome
      rmWorkspaceSync(ws)
      rmWorkspaceSync(home)
    }
  }, 30_000)
})
