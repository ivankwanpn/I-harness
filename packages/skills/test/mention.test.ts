import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSkillRegistry, type SkillRegistry } from "../src/registry.ts"
import { scanMentionedSkillNames, SKILL_MENTION_PLUGIN } from "../src/mention.ts"

// M6 batch C, C2 (spec 2026-09-21-m6-breadth-design §3.2): the `$name` sigil
// scanner. The rule is EXACT membership in the registry — a capture is a hit
// iff the string equals a registered skill name, so the whole decision is
// "what does `list()` say", never a lexical resemblance to a name.
//
// Two subtleties this file pins in particular:
//   - the name grammar is `[a-z0-9-]` (registry.ts:67), so `$Deploy` is a MISS
//     and case-insensitive matching is NOT attempted (a hit the registry would
//     then fail to load is worse than a miss);
//   - the regex consumes the WHOLE `[a-z0-9-]` run after the sigil, so a
//     capture can never be a proper PREFIX of a longer kebab token: `$deploy-dbx`
//     scans as `deploy-dbx`, not as `deploy-db` (no partial matches).
//
// The registry is the REAL one over a seeded temp workspace, with `globalDir`
// pointed at an empty temp dir — the isolation knob `section.test.ts` documents
// (`$IH_CONFIG_DIR` is the machine-wide one; an explicit `globalDir` wins over
// it), so the only I/O here is the `list()` the assembly itself will call.

/** The registry scans `<root>/skills/<dir>/SKILL.md` (skills.test.ts's shape). */
function writeSkill(root: string, name: string, description: string): void {
  mkdirSync(join(root, "skills", name), { recursive: true })
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

function withRegistry(run: (registry: SkillRegistry) => void): void {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-skills-mention-"))
  const global = mkdtempSync(join(tmpdir(), "i-harness-skills-mention-global-"))
  try {
    writeSkill(ws, "hello", "Greet the user")
    writeSkill(ws, "deploy-db", "Deploy the database")
    writeSkill(ws, "nightly", "Run the nightly job")
    // A one-letter name, so the dedupe case below is the SHORTEST legal name
    // (the regex's first character class is `[a-z0-9]`, i.e. one char minimum).
    writeSkill(ws, "a", "One-letter name")
    run(createSkillRegistry({ workspace: ws, globalDir: global }))
  } finally {
    rmSync(ws, { recursive: true, force: true })
    rmSync(global, { recursive: true, force: true })
  }
}

describe("scanMentionedSkillNames (M6 C2)", () => {
  it("returns every registered name mentioned, in first-mention order", () => {
    withRegistry((registry) => {
      const first = scanMentionedSkillNames("please deploy $deploy-db and $nightly", registry)
      expect(first).toEqual(["deploy-db", "nightly"])
      // Same inputs, same answer — the scanner is pure, and this is not
      // vacuity: the pattern is MODULE-level and `/g`, so a scan that leaves
      // `lastIndex` advanced (an `.exec()` loop that stops early) answers a
      // different question on the SECOND call. `matchAll` never advances the
      // shared pattern, which is why the same call repeats.
      expect(scanMentionedSkillNames("please deploy $deploy-db and $nightly", registry)).toEqual(first)
    })
  })

  it("carries the sigil's own plugin name (the log line's source)", () => {
    expect(SKILL_MENTION_PLUGIN).toBe("i-harness/skills")
  })

  it("dedupes and preserves the FIRST mention's position", () => {
    withRegistry((registry) => {
      expect(scanMentionedSkillNames("$nightly then $deploy-db then $nightly again", registry)).toEqual([
        "nightly",
        "deploy-db",
      ])
      // The shortest legal name, twice: one entry, not two.
      expect(scanMentionedSkillNames("$a $a", registry)).toEqual(["a"])
    })
  })

  it("an unknown name is a MISS — `$` is not a wildcard", () => {
    withRegistry((registry) => {
      expect(scanMentionedSkillNames("$unknown", registry)).toEqual([])
      expect(scanMentionedSkillNames("run $unknown then $deploy-db", registry)).toEqual(["deploy-db"])
    })
  })

  it("is case-SENSITIVE: `$Deploy` is a miss (the grammar is lowercase)", () => {
    withRegistry((registry) => {
      expect(scanMentionedSkillNames("$Deploy", registry)).toEqual([])
      expect(scanMentionedSkillNames("$DEPLOY-DB", registry)).toEqual([])
    })
  })

  it("a bare or non-initial sigil yields nothing", () => {
    withRegistry((registry) => {
      expect(scanMentionedSkillNames("$", registry)).toEqual([])
      expect(scanMentionedSkillNames("$ ", registry)).toEqual([])
      // `1abc` is a legal NAME grammar but not a registered skill here — the
      // miss is membership, not the leading digit.
      expect(scanMentionedSkillNames("$1abc", registry)).toEqual([])
      expect(scanMentionedSkillNames("ends with $", registry)).toEqual([])
    })
  })

  it("text without a sigil yields nothing", () => {
    withRegistry((registry) => {
      expect(scanMentionedSkillNames("please deploy deploy-db", registry)).toEqual([])
      expect(scanMentionedSkillNames("", registry)).toEqual([])
    })
  })

  it("consumes the WHOLE kebab run: a partial token is not a hit", () => {
    withRegistry((registry) => {
      // The run continues into `x`, so the capture is `deploy-dbx`, which is
      // not `deploy-db`. A prefix match here would announce a skill the user
      // never named.
      expect(scanMentionedSkillNames("$deploy-dbx", registry)).toEqual([])
      // Punctuation the grammar cannot carry ENDS the run — a trailing comma is
      // not part of the name.
      expect(scanMentionedSkillNames("$hello, thanks", registry)).toEqual(["hello"])
    })
  })
})
