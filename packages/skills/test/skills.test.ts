// M24b TDD: @i-harness/skills — scan + front-matter + BM25 searchSkills +
// skill_get/skill_search tool surface + mount/unmount reclaim.
import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSkillRegistry, SkillToolError, isValidSkillName } from "../src/registry.ts"
import {
  createSkillGetTool,
  createSkillSearchTool,
  createSkillsPlugin,
  registerSkills,
  skillGetName,
  skillSearchName,
  skillsServiceName,
} from "../src/tool.ts"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"

const SKILL_MD = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n# Body\nUse this skill to ${desc}.`

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-skills-"))
  mkdirSync(join(ws, "skills/alpha"), { recursive: true })
  writeFileSync(join(ws, "skills/alpha/SKILL.md"), SKILL_MD("alpha", "Alpha skill"))
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) }
}

it("scans <workspace>/skills/<name>/SKILL.md", async () => {
  const { ws, cleanup } = setupWorkspace()
  try {
    const reg = createSkillRegistry({ workspace: ws })
    const list = reg.list()
    expect(list.map((s) => s.name)).toContain("alpha")
    expect(list.find((s) => s.name === "alpha")?.description).toBe("Alpha skill")
  } finally { cleanup() }
})

it("front-matter: name defaults to dir name; description required (missing → skip)", async () => {
  const { ws, cleanup } = setupWorkspace()
  try {
    mkdirSync(join(ws, "skills/beta"), { recursive: true })
    writeFileSync(join(ws, "skills/beta/SKILL.md"), "---\ndescription: no name\n---\nbody") // name 缺省=beta
    mkdirSync(join(ws, "skills/gamma"), { recursive: true })
    writeFileSync(join(ws, "skills/gamma/SKILL.md"), "---\nname: gamma\n---\nno desc") // description 缺 → skip
    const reg = createSkillRegistry({ workspace: ws })
    const names = reg.list().map((s) => s.name)
    expect(names).toContain("beta") // 缺 name → 目錄名
    expect(names).not.toContain("gamma") // 缺 description → skip
  } finally { cleanup() }
})

it("searchSkills uses BM25 (reuses @i-harness/tool-search)", async () => {
  const { ws, cleanup } = setupWorkspace()
  try {
    const reg = createSkillRegistry({ workspace: ws })
    const hits = reg.searchSkills("alpha")
    expect(hits[0]?.name).toBe("alpha")
  } finally { cleanup() }
})

describe("scan", () => {
  it("depth cap ≤4: SKILL.md four dirs deep listed, five deep skipped", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      mkdirSync(join(ws, "skills/a/b/c/d"), { recursive: true })
      writeFileSync(join(ws, "skills/a/b/c/d/SKILL.md"), SKILL_MD("deep-ok", "depth four"))
      mkdirSync(join(ws, "skills/a/b/c/d/e"), { recursive: true })
      writeFileSync(join(ws, "skills/a/b/c/d/e/SKILL.md"), SKILL_MD("too-deep", "depth five"))
      const reg = createSkillRegistry({ workspace: ws })
      const names = reg.list().map((s) => s.name)
      expect(names).toContain("deep-ok")
      expect(names).not.toContain("too-deep")
    } finally { cleanup() }
  })

  it("hidden directories are skipped", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      mkdirSync(join(ws, "skills/.secret"), { recursive: true })
      writeFileSync(join(ws, "skills/.secret/SKILL.md"), SKILL_MD("hidden", "Hidden skill"))
      const names = createSkillRegistry({ workspace: ws }).list().map((s) => s.name)
      expect(names).not.toContain("hidden")
      expect(names).toContain("alpha")
    } finally { cleanup() }
  })

  it("non-kebab or oversized name → skip (warn, never break the registry)", () => {
    const { ws, cleanup } = setupWorkspace()
    const warnings: string[] = []
    try {
      mkdirSync(join(ws, "skills/bad-name"), { recursive: true })
      writeFileSync(join(ws, "skills/bad-name/SKILL.md"), SKILL_MD("Bad_Name", "not kebab"))
      const longName = "a".repeat(65)
      mkdirSync(join(ws, "skills/too-long"), { recursive: true })
      writeFileSync(join(ws, "skills/too-long/SKILL.md"), SKILL_MD(longName, "name too long"))
      const reg = createSkillRegistry({ workspace: ws, onWarn: (m) => warnings.push(m) })
      const names = reg.list().map((s) => s.name)
      expect(names).not.toContain("Bad_Name")
      expect(names).not.toContain(longName)
      expect(warnings.some((m) => m.includes("SKILL_INVALID_NAME"))).toBe(true)
      expect(names).toContain("alpha") // valid skills still scan
    } finally { cleanup() }
  })

  it("workspace overrides global for the same name; other skills merge with source", () => {
    const ws = mkdtempSync(join(tmpdir(), "i-harness-skills-ws-"))
    const globalDir = mkdtempSync(join(tmpdir(), "i-harness-skills-gl-"))
    try {
      mkdirSync(join(ws, "skills/alpha"), { recursive: true })
      writeFileSync(join(ws, "skills/alpha/SKILL.md"), SKILL_MD("alpha", "Workspace alpha"))
      mkdirSync(join(globalDir, "alpha"), { recursive: true })
      writeFileSync(join(globalDir, "alpha/SKILL.md"), SKILL_MD("alpha", "Global alpha"))
      mkdirSync(join(globalDir, "g-only"), { recursive: true })
      writeFileSync(join(globalDir, "g-only/SKILL.md"), SKILL_MD("g-only", "Global only"))
      const reg = createSkillRegistry({ workspace: ws, globalDir })
      const alphas = reg.list().filter((s) => s.name === "alpha")
      expect(alphas).toHaveLength(1)
      expect(alphas[0]?.description).toBe("Workspace alpha")
      expect(alphas[0]?.source).toBe("workspace")
      const gOnly = reg.list().find((s) => s.name === "g-only")
      expect(gOnly?.description).toBe("Global only")
      expect(gOnly?.source).toBe("global")
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(globalDir, { recursive: true, force: true })
    }
  })

  it("globalDir override scans the global root with source 'global'", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "i-harness-skills-gl2-"))
    try {
      mkdirSync(join(globalDir, "solo"), { recursive: true })
      writeFileSync(join(globalDir, "solo/SKILL.md"), SKILL_MD("solo", "Solo global skill"))
      const reg = createSkillRegistry({ globalDir })
      const solo = reg.list().find((s) => s.name === "solo")
      expect(solo?.source).toBe("global")
      expect(solo?.description).toBe("Solo global skill")
    } finally { rmSync(globalDir, { recursive: true, force: true }) }
  })

  it("empty workspace (no skills dir) → empty list, search over empty corpus", () => {
    const ws = mkdtempSync(join(tmpdir(), "i-harness-skills-empty-"))
    try {
      const reg = createSkillRegistry({ workspace: ws })
      expect(reg.list()).toEqual([])
      expect(reg.searchSkills("anything")).toEqual([])
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})

describe("front-matter parsing", () => {
  it("unclosed fence / missing fence / non-scalar value → skip", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      mkdirSync(join(ws, "skills/unclosed"), { recursive: true })
      writeFileSync(join(ws, "skills/unclosed/SKILL.md"), "---\nname: unclosed\ndescription: never closed")
      mkdirSync(join(ws, "skills/nofence"), { recursive: true })
      writeFileSync(join(ws, "skills/nofence/SKILL.md"), "just markdown, no front-matter")
      mkdirSync(join(ws, "skills/nested"), { recursive: true })
      writeFileSync(join(ws, "skills/nested/SKILL.md"), "---\nmetadata:\n  tags:\n    - a\ndescription: has nested value\n---\nbody")
      mkdirSync(join(ws, "skills/arrdesc"), { recursive: true })
      writeFileSync(join(ws, "skills/arrdesc/SKILL.md"), "---\nname: arrdesc\ndescription:\n  - one\n  - two\n---\nbody")
      const reg = createSkillRegistry({ workspace: ws })
      const names = reg.list().map((s) => s.name)
      for (const bad of ["unclosed", "nofence", "nested", "arrdesc"]) expect(names).not.toContain(bad)
      expect(names).toContain("alpha")
    } finally { cleanup() }
  })

  it("CRLF line endings parse; YAML folding is single-lined", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      mkdirSync(join(ws, "skills/crlf"), { recursive: true })
      writeFileSync(join(ws, "skills/crlf/SKILL.md"), SKILL_MD("crlf", "CRLF skill").replaceAll("\n", "\r\n"))
      mkdirSync(join(ws, "skills/folded"), { recursive: true })
      writeFileSync(join(ws, "skills/folded/SKILL.md"), "---\nname: folded\ndescription: >\n  folded description\n  across lines\n---\nbody")
      const reg = createSkillRegistry({ workspace: ws })
      expect(reg.list().find((s) => s.name === "crlf")?.description).toBe("CRLF skill")
      // yaml-package folding → single-line description
      expect(reg.list().find((s) => s.name === "folded")?.description).toBe("folded description across lines")
    } finally { cleanup() }
  })

  it("name grammar helper: kebab ≤64 valid, everything else invalid", () => {
    expect(isValidSkillName("alpha")).toBe(true)
    expect(isValidSkillName("my-skill-2")).toBe(true)
    expect(isValidSkillName("a".repeat(64))).toBe(true)
    expect(isValidSkillName("Bad_Name")).toBe(false)
    expect(isValidSkillName("UPPER")).toBe(false)
    expect(isValidSkillName("-lead")).toBe(false)
    expect(isValidSkillName("trail-")).toBe(false)
    expect(isValidSkillName("double--dash")).toBe(false)
    expect(isValidSkillName("a".repeat(65))).toBe(false)
    expect(isValidSkillName("")).toBe(false)
  })
})

describe("getSkill", () => {
  it("returns deferred body/path/source; unknown or non-kebab → undefined", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const reg = createSkillRegistry({ workspace: ws })
      const skill = await reg.getSkill("alpha")
      expect(skill?.body).toContain("# Body")
      expect(skill?.path).toContain(join("skills", "alpha", "SKILL.md"))
      expect(skill?.source).toBe("workspace")
      expect(skill?.description).toBe("Alpha skill")
      expect(await reg.getSkill("nope-missing")).toBeUndefined()
      expect(await reg.getSkill("Bad_Name")).toBeUndefined()
    } finally { cleanup() }
  })

  it("skill present on disk but broken → explicit SKILL_INVALID_FRONTMATTER (not NOT_FOUND)", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      mkdirSync(join(ws, "skills/broken"), { recursive: true })
      writeFileSync(join(ws, "skills/broken/SKILL.md"), "---\nname: broken\n---\nno description")
      const reg = createSkillRegistry({ workspace: ws })
      expect(reg.list().map((s) => s.name)).not.toContain("broken") // scan warn+skip
      await expect(reg.getSkill("broken")).rejects.toMatchObject({ code: "SKILL_INVALID_FRONTMATTER" })
    } finally { cleanup() }
  })
})

describe("tool surface", () => {
  it("skill_search returns {query, matches, totalSkills, usage}", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const tool = createSkillSearchTool({ registry: createSkillRegistry({ workspace: ws }) })
      const out = await tool.execute({ query: "alpha" }, {})
      expect(out.query).toBe("alpha")
      expect(out.matches[0]).toMatchObject({ name: "alpha", description: "Alpha skill", source: "workspace" })
      expect(out.matches[0]?.path).toContain("SKILL.md")
      expect(typeof out.totalSkills).toBe("number")
      expect(typeof out.usage).toBe("string")
      expect(out.totalSkills).toBe(1)
    } finally { cleanup() }
  })

  it("skill_search BM25 ranking + limit + select:", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      mkdirSync(join(ws, "skills/beta"), { recursive: true })
      writeFileSync(join(ws, "skills/beta/SKILL.md"), SKILL_MD("beta", "deploy the service"))
      mkdirSync(join(ws, "skills/gamma"), { recursive: true })
      writeFileSync(join(ws, "skills/gamma/SKILL.md"), SKILL_MD("gamma", "checklist for reviews"))
      const reg = createSkillRegistry({ workspace: ws })
      expect(reg.searchSkills("deploy").map((s) => s.name)).toEqual(["beta"])
      expect(reg.searchSkills("reviews").map((s) => s.name)).toEqual(["gamma"])
      expect(reg.searchSkills("skill", { limit: 1 })).toHaveLength(1) // alpha + …, capped
      expect(reg.searchSkills("select:gamma").map((s) => s.name)).toEqual(["gamma"])
    } finally { cleanup() }
  })

  it("skill_get: unknown → SKILL_NOT_FOUND; invalid name → SKILL_INVALID_NAME", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const tool = createSkillGetTool({ registry: createSkillRegistry({ workspace: ws }) })
      const unknown = tool.execute({ name: "nope-missing" }, {})
      await expect(unknown).rejects.toBeInstanceOf(SkillToolError)
      await expect(unknown).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" })
      await expect(tool.execute({ name: "Bad_Name" }, {})).rejects.toMatchObject({ code: "SKILL_INVALID_NAME" })
      await expect(tool.execute({ name: "" }, {})).rejects.toMatchObject({ code: "SKILL_INVALID_NAME" })
    } finally { cleanup() }
  })

  it("skill_get: files sampled ≤10 (SKILL.md excluded) + <skill_content> render with XML escaping", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      // body carries XML-hostile characters; the dir carries 12 extra files
      writeFileSync(
        join(ws, "skills/alpha/SKILL.md"),
        "---\nname: alpha\ndescription: Alpha <skill> & friends\n---\n# Body\nUse <tag> & run `x < y`.",
      )
      for (let i = 0; i < 12; i++) writeFileSync(join(ws, "skills/alpha", `asset-${String(i).padStart(2, "0")}.md`), "x")
      const tool = createSkillGetTool({ registry: createSkillRegistry({ workspace: ws }) })
      const out = await tool.execute({ name: "alpha" }, {})
      expect(out.name).toBe("alpha")
      expect(out.description).toBe("Alpha <skill> & friends")
      expect(out.baseDir).toContain(join("skills", "alpha"))
      expect(out.files).toHaveLength(10)
      expect(out.files).not.toContain("SKILL.md")
      expect(out.totalFiles).toBe(12)
      expect(out.body).toContain("# Body")
      // model-side render: <skill_content> + base-directory hint + sampled note + escaping
      expect(out.content).toContain(`<skill_content name="alpha">`)
      expect(out.content).toContain(`</skill_content>`)
      expect(out.content).toContain(out.baseDir)
      expect(out.content).toContain("sampled 10 of 12")
      expect(out.content).toContain("&lt;tag&gt;")
      expect(out.content).toContain("&amp;")
      expect(out.content).not.toContain("<tag>")
    } finally { cleanup() }
  })

  it("skill_get: few files → full list, no sampled note; SKILL.md excluded", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      writeFileSync(join(ws, "skills/alpha/reference.md"), "ref")
      const tool = createSkillGetTool({ registry: createSkillRegistry({ workspace: ws }) })
      const out = await tool.execute({ name: "alpha" }, {})
      expect(out.files).toEqual(["reference.md"])
      expect(out.totalFiles).toBe(1)
      expect(out.content).not.toContain("sampled")
    } finally { cleanup() }
  })
})

describe("mount/unmount (core-plugin reclaim)", () => {
  it("plugin mount registers tools + service; unmount reclaims the tools", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      ctx.mount(createSkillsPlugin(ctx, tools, { workspace: ws }))
      expect(tools.get(skillSearchName)).toBeDefined()
      expect(tools.get(skillGetName)).toBeDefined()
      expect(ctx.services.get(skillsServiceName)).toBeDefined()
      await ctx.unmount("skills")
      expect(tools.get(skillSearchName)).toBeUndefined()
      expect(tools.get(skillGetName)).toBeUndefined()
    } finally { cleanup() }
  })

  it("registerSkills returns a handle: registry service + idempotent tool reclaim", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      const handle = registerSkills(ctx, tools, { workspace: ws })
      expect(handle.registry.list().map((s) => s.name)).toContain("alpha")
      expect(tools.get(skillSearchName)).toBeDefined()
      await handle.unmount()
      await handle.unmount() // idempotent: core-plugin unregister is a no-op for unknown names
      expect(tools.get(skillSearchName)).toBeUndefined()
      expect(tools.get(skillGetName)).toBeUndefined()
    } finally { cleanup() }
  })
})
