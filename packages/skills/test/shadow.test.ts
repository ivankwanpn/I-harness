// M27 R-B6: shadow selector (deterministic offline candidate report via the
// skill/selector-shadow telemetry event) + allow_implicit_invocation gate —
// when false, skill_search returns ONLY explicit mention matches.
import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import {
  selectShadowCandidates,
  explicitMentionMatches,
  type SkillSelectorEvent,
} from "../src/shadow.ts"
import { createSkillRegistry } from "../src/registry.ts"
import { registerSkills } from "../src/tool.ts"
import type { SkillSummary } from "../src/registry.ts"

const SKILL_MD = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n# Body`

function setupWorkspace(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-shadow-"))
  mkdirSync(join(ws, "skills/rebuild-db"), { recursive: true })
  writeFileSync(join(ws, "skills/rebuild-db/SKILL.md"), SKILL_MD("rebuild-db", "Rebuild the database cache"))
  mkdirSync(join(ws, "skills/deploy-db"), { recursive: true })
  writeFileSync(join(ws, "skills/deploy-db/SKILL.md"), SKILL_MD("deploy-db", "Deploy the service fleet"))
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) }
}

function summaries(ws: string): SkillSummary[] {
  return createSkillRegistry({ workspace: ws }).list()
}

describe("shadow selector (pure candidate report)", () => {
  it("reports the BM25 hits with deterministic ranks", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const report = selectShadowCandidates("rebuild", summaries(ws))
      expect(report.candidates.map((c) => c.id)).toContain("rebuild-db")
      expect(report.candidates.find((c) => c.id === "rebuild-db")?.mode).toBe("bm25")
      // determinism: two identical calls produce the same report
      expect(report).toEqual(selectShadowCandidates("rebuild", summaries(ws)))
    } finally { cleanup() }
  })

  it("exact-name queries are reported with mode 'exact'", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const report = selectShadowCandidates("deploy-db", summaries(ws))
      expect(report.candidates[0]).toEqual({ id: "deploy-db", rank: 1, mode: "exact" })
    } finally { cleanup() }
  })

  it("select: queries report the selected names", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const report = selectShadowCandidates("select:deploy-db", summaries(ws))
      expect(report.candidates.map((c) => c.id)).toEqual(["deploy-db"])
    } finally { cleanup() }
  })

  it("candidate ids are stable skill names (never paths)", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const report = selectShadowCandidates("database", summaries(ws))
      for (const candidate of report.candidates) expect(candidate.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    } finally { cleanup() }
  })
})

describe("explicitMentionMatches", () => {
  it("whole-name mentions and select: lists count; keyword queries do not", () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const all = summaries(ws)
      expect(explicitMentionMatches("deploy-db", all).map((s) => s.name)).toEqual(["deploy-db"])
      expect(explicitMentionMatches("select:deploy-db,rebuild-db", all).map((s) => s.name)).toEqual(["deploy-db", "rebuild-db"])
      expect(explicitMentionMatches("rebuild the database", all)).toEqual([])
      // partial-name mention is still implicit (a name is one word in dsh grammar)
      expect(explicitMentionMatches("deploy", all)).toEqual([])
    } finally { cleanup() }
  })
})

describe("skill_search shadow + implicit policy through the tool surface", () => {
  it("emits a skill/selector-shadow telemetry report on every search", async () => {
    const { ws, cleanup } = setupWorkspace()
    const emitted: SkillSelectorEvent[] = []
    try {
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      registerSkills(ctx, tools, { workspace: ws, telemetry: { emit: (e) => emitted.push(e) } })
      const result = await tools.execute({ name: "skill_search", args: { query: "rebuild" } }, {})
      expect(result.name).toBe("skill_search")
      expect(emitted.some((e) => e.type === "skill/selector-shadow")).toBe(true)
      const report = emitted.find((e) => e.type === "skill/selector-shadow")!
      expect(report.data.query).toBe("rebuild")
      expect(report.data.candidates.length).toBeGreaterThan(0)
      expect(report.data.candidates[0]?.mode).toBe("bm25")
    } finally { cleanup() }
  })

  it("the gate is OPEN by default (BM25 keyword search keeps working)", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      registerSkills(ctx, tools, { workspace: ws })
      const result = await tools.execute({ name: "skill_search", args: { query: "rebuild" } }, {})
      const names = (result.output as { matches: { name: string }[] }).matches.map((m) => m.name)
      expect(names).toContain("rebuild-db")
    } finally { cleanup() }
  })

  it("allowImplicitInvocation false returns ONLY explicit mention matches", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      registerSkills(ctx, tools, { workspace: ws, allowImplicitInvocation: false })
      // keyword query: BM25 would hit rebuild-db, but the gate hides it
      const keyword = await tools.execute({ name: "skill_search", args: { query: "rebuild" } }, {})
      expect((keyword.output as { matches: unknown[] }).matches).toEqual([])
      // exact mention still resolves
      const mention = await tools.execute({ name: "skill_search", args: { query: "rebuild-db" } }, {})
      expect((mention.output as { matches: { name: string }[] }).matches.map((m) => m.name)).toEqual(["rebuild-db"])
      // select: is an explicit invocation form
      const select = await tools.execute({ name: "skill_search", args: { query: "select:deploy-db" } }, {})
      expect((select.output as { matches: { name: string }[] }).matches.map((m) => m.name)).toEqual(["deploy-db"])
    } finally { cleanup() }
  })

  it("the shadow report is emitted even when the gate is closed (behavior unchanged)", async () => {
    const { ws, cleanup } = setupWorkspace()
    const emitted: SkillSelectorEvent[] = []
    try {
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      registerSkills(ctx, tools, { workspace: ws, allowImplicitInvocation: false, telemetry: { emit: (e) => emitted.push(e) } })
      await tools.execute({ name: "skill_search", args: { query: "rebuild" } }, {})
      const report = emitted.find((e) => e.type === "skill/selector-shadow")
      expect(report).toBeDefined()
      expect(report!.data.implicitAllowed).toBe(false)
      expect(report!.data.candidates.length).toBeGreaterThan(0)
    } finally { cleanup() }
  })

  it("no telemetry callback → no shadow report, no crash", async () => {
    const { ws, cleanup } = setupWorkspace()
    try {
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      registerSkills(ctx, tools, { workspace: ws })
      const result = await tools.execute({ name: "skill_search", args: { query: "rebuild" } }, {})
      expect((result.output as { matches: unknown[] }).matches.length).toBeGreaterThan(0)
    } finally { cleanup() }
  })
})
