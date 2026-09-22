// e2e/skills.e2e.ts — M25 §2.1: the REAL skills mount (M24b) scanning real
// SKILL.md files from the workspace, plus the fail-closed missing-skill path.
//
// Tool-driving goes through runHeadless + mockScript (see team.e2e.ts for the
// mock-injection ruling).
import { describe, expect, it } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runHeadless } from "../apps/cli/src/run.ts"
import { makeWorkspace, removeWorkspace } from "./helpers.ts"

describe("e2e skills", () => {
  it("skill_search finds a real SKILL.md; skill_get returns its usable body", async () => {
    const dir = makeWorkspace("i-harness-e2e-skills-")
    try {
      mkdirSync(join(dir, "skills", "alpha"), { recursive: true })
      writeFileSync(
        join(dir, "skills", "alpha", "SKILL.md"),
        "---\nname: alpha\ndescription: Rebuild the search indexer cache.\n---\n\nRun scripts/rebuild.sh first, then warm the cache with scripts/warm.js.",
        "utf8",
      )
      const result = await runHeadless("apply the alpha skill", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "skill_search", args: { query: "rebuild indexer" } }] },
          { role: "assistant", toolCalls: [{ name: "skill_get", args: { name: "alpha" } }] },
          { role: "assistant", text: "skill applied" },
        ],
      })
      expect(result.exitCode, result.error).toBe(0)
      const results = result.session?.events.filter((e) => e.type === "tool/result") as { name: string; output: unknown }[]
      // The search hit the REAL on-disk SKILL.md.
      const search = results.find((e) => e.name === "skill_search")
      expect(JSON.stringify(search?.output)).toContain("alpha")
      // skill_get returned the real file body.
      const get = results.find((e) => e.name === "skill_get")
      expect(JSON.stringify(get?.output)).toContain("scripts/rebuild.sh")
    } finally {
      removeWorkspace(dir)
    }
  })

  it("skill_get on a missing skill fails closed — the reason reaches the model and the turn continues", async () => {
    const dir = makeWorkspace("i-harness-e2e-skills-")
    try {
      mkdirSync(join(dir, "skills", "alpha"), { recursive: true })
      writeFileSync(
        join(dir, "skills", "alpha", "SKILL.md"),
        "---\nname: alpha\ndescription: Present but not the one requested.\n---\n\nbody",
        "utf8",
      )
      const result = await runHeadless("load the missing skill", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "skill_get", args: { name: "missing" } }] },
          // The model's continuation, which the soft path now reaches: the
          // one-step cassette otherwise dies on "mock script exhausted".
          { role: "assistant", text: "saw the failure, continuing" },
        ],
      })
      // M5 T4 block ① made a tool BODY throw SOFT: the run no longer exits 1,
      // because the turn continues and the reason travels with the call's
      // tool/result instead of the turn's error. The substantive claim is
      // unchanged — skill_get fails CLOSED and the reason is never swallowed —
      // only the channel moved. (This file lives outside
      // `pnpm -r --no-bail test`, which is why block ①'s rewrite census, scoped
      // to the workspace packages, missed it.)
      expect(result.exitCode, result.error).toBe(0)
      const results = result.session?.events.filter((e) => e.type === "tool/result") as { name: string; output: unknown }[]
      const failed = results.find((e) => e.name === "skill_get")
      expect(String((failed?.output as { error?: string } | undefined)?.error)).toContain("SKILL_NOT_FOUND")
    } finally {
      removeWorkspace(dir)
    }
  })
})
