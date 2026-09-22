import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSkillRegistry } from "../src/registry.ts"

// 2026-09-17: `skills.extraDirs` existed as an assembly option — passed, commented
// as "plugin overlay skill roots" — and was silently discarded, because
// `SkillsMountConfig` had no such field and TypeScript does not excess-property
// check spread properties. These tests pin the root the plugin mount needs.

const SKILL_MD = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

function setup(): { base: string; ws: string; global: string; extra: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "i-harness-skills-extra-"))
  const ws = join(base, "ws")
  const global = join(base, "global")
  const extra = join(base, "plugin-skills")
  for (const d of [join(ws, "skills"), global, join(extra, "plug")]) mkdirSync(d, { recursive: true })
  return { base, ws, global, extra, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

const put = (root: string, name: string, description: string): void => {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, "SKILL.md"), SKILL_MD(name, description))
}

describe("SkillRegistry extraDirs — the plugin overlay root", () => {
  it("finds a skill in an extra dir and reports its source as plugin", () => {
    const { ws, extra, cleanup } = setup()
    try {
      put(extra, "plug", "A plugin skill")
      const reg = createSkillRegistry({ workspace: ws, extraDirs: [extra] })
      const found = reg.list().find((s) => s.name === "plug")
      expect(found).toBeDefined()
      expect(found?.description).toBe("A plugin skill")
      expect(found?.source).toBe("plugin")
    } finally {
      cleanup()
    }
  })

  it("scans several extra dirs", () => {
    const { ws, extra, cleanup } = setup()
    try {
      const second = join(extra, "..", "plugin-skills-2")
      put(extra, "one", "First")
      put(second, "two", "Second")
      const reg = createSkillRegistry({ workspace: ws, extraDirs: [extra, second] })
      const names = reg.list().map((s) => s.name)
      expect(names).toContain("one")
      expect(names).toContain("two")
    } finally {
      cleanup()
    }
  })

  // The precedence has to be DECIDED, not left to whatever order the code happens
  // to run in. Chosen and pinned here: global < plugin < workspace. The user's own
  // workspace is the most specific thing in play and wins; a plugin is a
  // machine-level addition like the global root, and being an explicit install is
  // why it outranks global.
  it("precedence: a workspace skill wins a collision with an extra dir", () => {
    const { ws, extra, cleanup } = setup()
    try {
      put(join(ws, "skills"), "same", "from workspace")
      put(extra, "same", "from plugin")
      const reg = createSkillRegistry({ workspace: ws, extraDirs: [extra] })
      expect(reg.list().find((s) => s.name === "same")?.description).toBe("from workspace")
    } finally {
      cleanup()
    }
  })

  it("precedence: an extra-dir skill wins a collision with the global root", () => {
    const { ws, global, extra, cleanup } = setup()
    try {
      put(global, "same", "from global")
      put(extra, "same", "from plugin")
      const reg = createSkillRegistry({ workspace: ws, globalDir: global, extraDirs: [extra] })
      expect(reg.list().find((s) => s.name === "same")?.description).toBe("from plugin")
    } finally {
      cleanup()
    }
  })

  it("getSkill reaches an extra-dir skill by name", async () => {
    const { ws, extra, cleanup } = setup()
    try {
      put(extra, "plug", "A plugin skill")
      const reg = createSkillRegistry({ workspace: ws, extraDirs: [extra] })
      const skill = await reg.getSkill("plug")
      expect(skill?.name).toBe("plug")
      expect(skill?.source).toBe("plugin")
    } finally {
      cleanup()
    }
  })

  // The probe-roots path, which the test above does NOT exercise — it is reached
  // via `list()`, and the mutation proof caught that: dropping extraDirs from
  // probeRoots left the "reaches by name" test green. What probeRoots is FOR is a
  // skill the SCAN skipped because its file is broken: without the extra root
  // there, getSkill reports a misleading NOT_FOUND instead of the real error.
  it("a BROKEN skill in an extra dir surfaces its real error, not NOT_FOUND", async () => {
    const { ws, extra, cleanup } = setup()
    try {
      // No description → the scan skips it, but the file exists on disk.
      mkdirSync(join(extra, "broken"), { recursive: true })
      writeFileSync(join(extra, "broken", "SKILL.md"), "---\nname: broken\n---\nbody")
      const reg = createSkillRegistry({ workspace: ws, extraDirs: [extra] })
      expect(reg.list().map((s) => s.name)).not.toContain("broken")
      await expect(reg.getSkill("broken")).rejects.toThrow()
    } finally {
      cleanup()
    }
  })

  it("a missing extra dir is silent, and the other roots still work", () => {
    const { ws, extra, cleanup } = setup()
    try {
      put(join(ws, "skills"), "local", "Local skill")
      const reg = createSkillRegistry({ workspace: ws, extraDirs: [join(extra, "nope")] })
      expect(reg.list().map((s) => s.name)).toContain("local")
    } finally {
      cleanup()
    }
  })

  it("no extraDirs is the status quo — nothing changes", () => {
    const { ws, cleanup } = setup()
    try {
      put(join(ws, "skills"), "local", "Local skill")
      const reg = createSkillRegistry({ workspace: ws })
      expect(reg.list().map((s) => s.name)).toEqual(["local"])
    } finally {
      cleanup()
    }
  })
})
