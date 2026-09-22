import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSkillRegistry, type SkillRegistry } from "../src/registry.ts"
import { createSkillsSection, DEFAULT_SKILLS_MAX_BYTES } from "../src/section.ts"

// M6 batch C, C1 (spec 2026-09-21-m6-breadth-design §3.2): the skills catalogue
// section. What is under test is the property runtime-context's change-only
// append makes load-bearing — the getter's text is a function of the SET of
// skills and nothing else. An unchanged set therefore renders byte-identical
// text (runtime-context appends NOTHING), and a changed set renders different
// text (exactly one appended line). The same discipline as W11's section
// (packages/subagent/test/section.test.ts): the samples below run on the REAL
// clock over several times any time-varying value would need to differ, and no
// clock is mocked or stubbed.

/** The registry scan reads `<root>/skills/<dir>/SKILL.md` (skills.test.ts's
 * SKILL_MD shape, same dir-per-name layout). */
function writeSkill(root: string, name: string, description: string): void {
  mkdirSync(join(root, "skills", name), { recursive: true })
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

/** Workspace + EMPTY global root, both removed afterwards. Passing `globalDir`
 * is what keeps these cases off the machine's real `~/.i-harness/skills` — the
 * contract skills/global-home.test.ts documents (`$IH_CONFIG_DIR` is the
 * isolation knob; an explicit `globalDir` wins over it). */
async function withTmpDirs(run: (ws: string, global: string) => void | Promise<void>): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-skills-section-"))
  const global = mkdtempSync(join(tmpdir(), "i-harness-skills-section-global-"))
  try {
    await run(ws, global)
  } finally {
    rmSync(ws, { recursive: true, force: true })
    rmSync(global, { recursive: true, force: true })
  }
}

function hermeticRegistry(workspace: string, global: string): SkillRegistry {
  return createSkillRegistry({ workspace, globalDir: global })
}

// ── the corpus the cap is calibrated against ────────────────────────────────
// Both lengths are the fixture's CONTRACT and are asserted in the corpus case:
// the MEASURED number below is only meaningful for this profile, so a drifting
// fixture must fail loudly rather than leave the recorded number quietly wrong.
const NAME_LENGTH = 30
const DESCRIPTION_LENGTH = 121

/** `release-readiness-checklist-00` … — 30 chars. This is a name on the long
 * side of what catalogues actually carry; the registry's own cap is 64
 * (`SKILL_NAME_MAX_LENGTH`, registry.ts), but a 64-char catalogue is not a
 * corpus anyone has. */
function corpusName(i: number): string {
  return `release-readiness-checklist-${String(i).padStart(2, "0")}`
}

/** 121 chars — the long end of a one-line description, carrying the skill's own
 * index so the corpus is not 50 copies of one string (a real catalogue differs
 * per entry; only the length policy is uniform here).
 *
 * Plain YAML scalar on purpose: no `": "` inside it, because a colon-space
 * makes the whole front-matter unparsable and the scan warn+skips the skill —
 * which is a real defect of SKILL.md authoring, but a fixture that tripped it
 * would measure an EMPTY catalogue and call it a corpus. */
function corpusDescription(i: number): string {
  const index = String(i).padStart(2, "0")
  return `Use when release ${index} needs an end-to-end check. Run the readiness checklist, compare the build artefact, and file a report`
}

function seedCorpus(ws: string, count: number): void {
  for (let i = 0; i < count; i += 1) writeSkill(ws, corpusName(i), corpusDescription(i))
}

/** The body the getter must return — one `- \`name\` — description` line per
 * skill in registry order, joined by "\n". Built from the registry's own rows
 * so the LINE FORMAT is what is pinned here, independently of the section. */
function expectedBody(registry: SkillRegistry): string {
  return registry.list().map((s) => `- \`${s.name}\` — ${s.description}`).join("\n")
}

/** MEASURED 2026-09-22 (m68 batch C, T7): the rendered length of the 50-skill
 * corpus seeded below — 50 lines of `- \`<name>\` — <description>` with name 30
 * and description 121 chars, joined by "\n" (50 × 158 + 49 = 7_949 by hand,
 * and the number a real scan produces). The 51st such line takes the raw render
 * to 51 × 158 + 50 = 8_108, i.e. past `DEFAULT_SKILLS_MAX_BYTES` — so the bound
 * is calibrated to "a full catalogue of upper-size lines still fits; the next
 * one does not".
 *
 * Command: a throwaway vitest file (deleted after the run) that seeded this
 * corpus in a temp workspace, read `registry.list()` through the REAL
 * `createSkillsSection`, and printed the lengths:
 *   pnpm --filter @i-harness/skills exec vitest run test/measure-throwaway.test.ts
 * Numbers: 50 skills → 7_949 chars (uncapped);
 *          51 skills → 8_108 raw, 8_012 rendered (8_000 + the 12-char note).
 * The literal is asserted below against the real scan, so it cannot rot into a
 * mere claim; the test is the pin, the command is the provenance. */
const MEASURED_50_SKILL_CATALOGUE_CHARS = 7_949

describe("skills catalogue section (M6 C1)", () => {
  it("renders one line per scanned skill, in the registry's name order", async () => {
    await withTmpDirs((ws, global) => {
      writeSkill(ws, "beta", "Runs the beta path")
      writeSkill(ws, "alpha", "Runs the alpha path")
      const section = createSkillsSection({ registry: hermeticRegistry(ws, global) })
      expect(section()).toBe("- `alpha` — Runs the alpha path\n- `beta` — Runs the beta path")
    })
  })

  it('an empty catalogue is "" — runtime-context appends its own cleared marker for that', async () => {
    await withTmpDirs((ws, global) => {
      const section = createSkillsSection({ registry: hermeticRegistry(ws, global) })
      expect(section()).toBe("")
    })
  })

  it("a 50-skill catalogue of upper-size lines fits the bound (the measurement)", async () => {
    await withTmpDirs((ws, global) => {
      seedCorpus(ws, 50)
      const registry = hermeticRegistry(ws, global)
      const section = createSkillsSection({ registry })
      // The fixture's contract — the recorded measurement holds for these sizes.
      expect(corpusName(0)).toHaveLength(NAME_LENGTH)
      expect(corpusDescription(0)).toHaveLength(DESCRIPTION_LENGTH)
      const rows = registry.list()
      expect(rows).toHaveLength(50) // the fixture reached the REAL scan, not a hand-built list
      const text = section()
      expect(text).toBe(expectedBody(registry))
      expect(text.length).toBe(MEASURED_50_SKILL_CATALOGUE_CHARS)
      expect(text.length).toBeLessThan(DEFAULT_SKILLS_MAX_BYTES)
      expect(text).not.toContain("(truncated)")
    })
  })

  it("the 51st skill is where the cut appears: the body stops at the bound, the note follows", async () => {
    await withTmpDirs((ws, global) => {
      seedCorpus(ws, 51)
      const registry = hermeticRegistry(ws, global)
      const section = createSkillsSection({ registry })
      const raw = expectedBody(registry)
      expect(raw.length).toBeGreaterThan(DEFAULT_SKILLS_MAX_BYTES) // the 51st line crosses it
      const text = section()
      expect(text.slice(0, DEFAULT_SKILLS_MAX_BYTES)).toBe(raw.slice(0, DEFAULT_SKILLS_MAX_BYTES))
      expect(text.endsWith("\n(truncated)")).toBe(true)
      expect(text.length).toBe(DEFAULT_SKILLS_MAX_BYTES + "\n(truncated)".length)
      // The cut falls 50 chars into the 51st line (line length 158 + separator):
      // the 50th skill is named in full, the 51st only as a prefix — which is
      // exactly why the note has to be there.
      expect(text).toContain(`- \`${corpusName(49)}\` — ${corpusDescription(49)}`)
      expect(text).not.toContain(corpusDescription(50))
    })
  })

  it("the bound is a knob: a smaller one cuts an otherwise-fitting catalogue", async () => {
    await withTmpDirs((ws, global) => {
      writeSkill(ws, "alpha", "Runs the alpha path")
      const registry = hermeticRegistry(ws, global)
      const line = "- `alpha` — Runs the alpha path"
      const section = createSkillsSection({ registry, maxBytes: 12 })
      expect(section()).toBe(`${line.slice(0, 12)}\n(truncated)`)
    })
  })

  it("is byte-identical across calls while the set is fixed (runtime-context appends NOTHING)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "i-harness-skills-section-"))
    const global = mkdtempSync(join(tmpdir(), "i-harness-skills-section-global-"))
    try {
      writeSkill(ws, "alpha", "Runs the alpha path")
      writeSkill(ws, "beta", "Runs the beta path")
      const section = createSkillsSection({ registry: hermeticRegistry(ws, global) })
      // Five samples over ~400ms of real time. `list()` rescans the disk on
      // EVERY access (the registry's documented v0 stance), so byte-identical
      // samples are the proof that nothing time-varying — a timestamp, an
      // mtime, a render counter — enters the text.
      const samples: string[] = []
      for (let i = 0; i < 5; i += 1) {
        samples.push(section())
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      expect(samples[0]).not.toBe("") // not vacuous: a catalogue IS rendered
      expect(new Set(samples).size).toBe(1)
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(global, { recursive: true, force: true })
    }
  }, 15_000)

  it("a changed description or name is a different string — the next step sees it", async () => {
    await withTmpDirs((ws, global) => {
      writeSkill(ws, "alpha", "First description")
      const section = createSkillsSection({ registry: hermeticRegistry(ws, global) })
      expect(section()).toBe("- `alpha` — First description")
      writeSkill(ws, "alpha", "Second description")
      expect(section()).toBe("- `alpha` — Second description")
      // A rename is a remove + add: the old name leaves, the new one arrives.
      rmSync(join(ws, "skills", "alpha"), { recursive: true, force: true })
      writeSkill(ws, "gamma", "Third description")
      expect(section()).toBe("- `gamma` — Third description")
    })
  })
})
