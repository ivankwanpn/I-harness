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

  it("skill_get on a missing skill fails closed (run exits 1 with SKILL_NOT_FOUND)", async () => {
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
        ],
      })
      // SkillToolError throws → throw-fails-turn → clean exitCode-1 result.
      expect(result.exitCode).toBe(1)
      expect(result.error).toContain("SKILL_NOT_FOUND")
    } finally {
      removeWorkspace(dir)
    }
  })
})
