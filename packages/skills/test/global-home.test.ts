import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSkillRegistry } from "../src/registry.ts"

// `$IH_CONFIG_DIR` is this repo's harness-home override and its isolation
// contract (e2e/helpers.ts:29, settings, hooks and the session store all honour
// it). The skills global root did not: it was a module-level
// `join(homedir(), ".i-harness", "skills")`, so a test that pinned IH_CONFIG_DIR
// to a temp dir still read the developer's real skills. That matters here
// because the plugin mount is tested by isolating exactly this way.

const SKILL_MD = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

describe("the skills global root honours $IH_CONFIG_DIR", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "i-harness-skills-home-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
  })

  it("reads <IH_CONFIG_DIR>/skills/<name>/SKILL.md as the global root", () => {
    const dir = join(home, "skills", "from-home")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), SKILL_MD("from-home", "From the harness home"))

    // No workspace and no explicit globalDir: the global root is the only root.
    const reg = createSkillRegistry()
    const found = reg.list().find((s) => s.name === "from-home")
    expect(found).toBeDefined()
    expect(found?.source).toBe("global")
  })

  it("resolves the env per call, not once at import", () => {
    // A module-level const would have captured the FIRST value it ever saw.
    const first = join(home, "skills", "early")
    mkdirSync(first, { recursive: true })
    writeFileSync(join(first, "SKILL.md"), SKILL_MD("early", "Early"))
    expect(createSkillRegistry().list().map((s) => s.name)).toContain("early")

    // Point the home elsewhere; a fresh registry must follow it.
    const second = mkdtempSync(join(tmpdir(), "i-harness-skills-home2-"))
    try {
      process.env.IH_CONFIG_DIR = second
      const dir = join(second, "skills", "late")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "SKILL.md"), SKILL_MD("late", "Late"))
      const names = createSkillRegistry().list().map((s) => s.name)
      expect(names).toContain("late")
      expect(names).not.toContain("early")
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })

  it("an explicit globalDir still wins over the env", () => {
    const pinned = mkdtempSync(join(tmpdir(), "i-harness-skills-pinned-"))
    try {
      const dir = join(pinned, "pinned")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "SKILL.md"), SKILL_MD("pinned", "Pinned"))
      const names = createSkillRegistry({ globalDir: pinned }).list().map((s) => s.name)
      expect(names).toContain("pinned")
    } finally {
      rmSync(pinned, { recursive: true, force: true })
    }
  })

  // The probe-roots path, which the cases above do NOT exercise — they go through
  // list(). probeRoots is the fallback for a skill the SCAN skipped because its
  // file is broken; without the env-derived root there it reports NOT_FOUND.
  it("a broken skill under the env-derived home surfaces its real error", async () => {
    const dir = join(home, "skills", "broken")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), "---\nname: broken\n---\nbody") // no description → scan skips it
    const reg = createSkillRegistry()
    expect(reg.list().map((s) => s.name)).not.toContain("broken")
    await expect(reg.getSkill("broken")).rejects.toThrow()
  })
})
