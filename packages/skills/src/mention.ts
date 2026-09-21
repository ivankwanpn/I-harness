// M6 batch C, C2 (spec 2026-09-21-m6-breadth-design §3.2): the `$name` sigil —
// the input-side half of "skills can be discovered". The catalogue section
// (section.ts) tells the model what EXISTS at every step; this reads the user's
// own text for the names they pointed at explicitly.
//
// Membership is EXACT: a capture is a hit iff it equals a registered skill name
// (`registry.list()`), so nothing here is lexical. Three properties follow from
// that plus the name grammar `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` (registry.ts:67):
//
//   - case-SENSITIVE, deliberately. `$Deploy` is a miss. Matching
//     case-insensitively would hand the caller a name that `skill_get` then
//     refuses — a hit the rest of the stack cannot honour is worse than the
//     miss it replaces.
//   - no PARTIAL matches, structurally: the capture consumes the whole
//     `[a-z0-9-]` run after the sigil, and a registered name is exactly such a
//     run, so the capture is either a name the registry has or a token it does
//     not (`$deploy-dbx` captures `deploy-dbx`, never `deploy-db`).
//   - `isValidSkillName` (registry.ts:76-78) is NOT called: `list()` only ever
//     yields names that already passed it, so a second grammar check could only
//     disagree with the registry it just read.
//
// One `list()` per call — the registry's documented rescan-per-access stance
// (registry.ts:30-33) — and the caller (the assembly's pre-step listener) is
// deduped per task string, so one turn costs this at most once.

import type { SkillRegistry } from "./registry.ts"

/** The log line's `source.plugin` — the assembly's mention listener is this
 * module's one production consumer, in the same commit (spec §3.2 C2). */
export const SKILL_MENTION_PLUGIN = "i-harness/skills"

/** `$name` — dsh/codex's TOOL_MENTION_SIGIL precedent: a leading `[a-z0-9]`
 * (so `$`, `$ ` and `$Deploy` yield no capture at all) followed by the kebab
 * body. Not anchored on a word boundary: the sigil itself is the marker. */
const MENTION_SIGIL = /\$([a-z0-9][a-z0-9-]*)/g

/**
 * Every registered skill name mentioned in `text`, deduped, in first-mention
 * order. A name the registry does not know is NOT a hit — the scan never
 * guesses, so its answer is exactly "the user named things that exist".
 *
 * Pure: reads the registry (its one I/O), writes nothing, and the same inputs
 * yield the same list.
 */
export function scanMentionedSkillNames(text: string, registry: SkillRegistry): string[] {
  const known = new Set(registry.list().map((skill) => skill.name))
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_SIGIL)) {
    const name = match[1]!
    if (!known.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}
