import type { SkillRegistry } from "./registry.ts"

export interface SkillsSectionOptions {
  /** The live registry — the same one the skill tools read, so "what the model
   * can load" and "what the model has been told exists" cannot drift apart. */
  registry: SkillRegistry
  /** Overrides `DEFAULT_SKILLS_MAX_BYTES`. A host knob, not a second policy:
   * the default is the derived budget, and this exists for hosts that have
   * measured a different window. */
  maxBytes?: number
}

/** MEASURED 2026-09-22 (m68 batch C, T7 — the unit test recomputes the
 * literal): the rendered length of a 50-skill catalogue whose lines sit at the
 * upper end of what is actually written (name 30 chars, description 121)
 * is **7_949** chars — under this bound; the 51st such line takes the raw
 * render to **8_108**, which is where truncation starts. So the bound is
 * calibrated as "a full catalogue still fits; the next entry does not".
 *
 * DERIVATION (plan §0.3): 8_000 chars ≈ 2k tokens by `estimateMessage`'s
 * `ceil(len / 4) + 4` (packages/token-meter/src/estimate.ts) ≈ 1% of a 200k
 * window — and one third of the instructions section's 24_000, so the eager
 * catalogue cannot crowd out the documents the host itself wrote. Like that
 * constant, the unit is the rendered string's `length` (UTF-16 code units —
 * the instructions section's precedent, packages/instructions/src/index.ts:48).
 *
 * Command: pnpm --filter @i-harness/skills test */
export const DEFAULT_SKILLS_MAX_BYTES = 8_000

/** M6 batch C, C1 (spec 2026-09-21-m6-breadth-design §3.2): the skills
 * catalogue — one `name` + description line per registered skill — for
 * runtime-context to render as a `## skills` section on the tail of the log.
 *
 * The property that decides whether this is usable, the same one W11's
 * subagents section is built around (packages/subagent/src/section.ts:12-33):
 * runtime-context appends a snapshot ONLY when the rendered text CHANGES
 * (packages/runtime-context/src/index.ts:46-60). So the text is a function of
 * THE SET of skills and nothing else — the names, their descriptions, and the
 * registry's name sort (`list()` documents that order; it is not re-applied
 * here). No timestamp, no mtime, no render counter: any of those would append
 * a log line at every step boundary — noise, not signal. One line per added,
 * renamed or re-described skill; zero in between.
 *
 * `list()` rescans the disk on every access (the registry's documented v0
 * stance, registry.ts:30-33) and this getter calls it per invocation — so a
 * skill written between two steps is visible at the next one, at the cost of
 * one scan per step boundary. Accepted, not cached: a cache here would be a
 * second source of truth for "which skills exist" (the plan's registry-cache
 * decision, §0.3).
 *
 * An empty catalogue renders `""` — no section at all, so it can never hold a
 * stale catalogue in the log; a session whose last remaining section was this
 * one gets runtime-context's own cleared marker instead
 * (packages/runtime-context/src/index.ts:48).
 *
 * Over `DEFAULT_SKILLS_MAX_BYTES` the body is cut at the bound and the note
 * "\n(truncated)" is appended after it — the instructions section's shape
 * (packages/instructions/src/index.ts:45-52), with a newline so the note reads
 * as a line of its own rather than as the tail of a half-sentence. The note is
 * the honest half of the cut: the model is told the list is incomplete instead
 * of being shown a catalogue that silently claims to be all of it. */
export function createSkillsSection(opts: SkillsSectionOptions): () => string {
  const maxBytes = opts.maxBytes ?? DEFAULT_SKILLS_MAX_BYTES
  return () => {
    let text = opts.registry.list()
      .map((skill) => `- \`${skill.name}\` — ${skill.description}`)
      .join("\n")
    if (text.length > maxBytes) text = text.slice(0, maxBytes) + "\n(truncated)"
    return text
  }
}
