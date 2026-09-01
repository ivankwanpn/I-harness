// M27 R-B6: shadow selector — a DETERMINISTIC offline candidate report for
// skill_search. The REAL selector (BM25 via @i-harness/tool-search) decides
// hits; this module answers "which skills WOULD a variant selector pick" and
// reports the answer as a telemetry event (`skill/selector-shadow`). It never
// changes behavior: the tools keep using the real selector, and sinks are free
// to ignore the report.
//
// Also owns the explicit-invocation vocabulary used by the
// `allow_implicit_invocation` gate: "implicit" = the model asks for anything
// that is not a direct skill-name mention (`alpha`, `select:alpha,beta`);
// "explicit" = the skill name appears verbatim in the query (dsh grammar, one
// word) or is selected through the select: list.
import { searchSkillSummaries } from "./search.ts"
import type { SkillSummary } from "./registry.ts"

/** The shadow report per candidate skill. */
export interface ShadowCandidate {
  /** The skill name (id). */
  id: string
  /** 1-based rank inside the merged candidate list. */
  rank: number
  /** Variant that selected the skill: exact name match, the real BM25 selector,
   * or the lexical n-gram variant. */
  mode: "exact" | "bm25" | "ngram"
}

export interface ShadowReport {
  query: string
  candidates: ShadowCandidate[]
}

/** The telemetry event the shadow selector emits (`skill/selector-shadow`). */
export interface SkillSelectorEvent {
  type: "skill/selector-shadow"
  /** Date.now() at emit time (a shadow report is a telemetry row). */
  ts: number
  data: {
    query: string
    candidates: ShadowCandidate[]
    /** Whether implicit (keyword) invocation was allowed at emit time. */
    implicitAllowed: boolean
  }
}

/** Shape of the host's emit callback (deliberately decoupled from
 * @i-harness/telemetry — the skills package does not depend on it). */
export interface SkillTelemetryEmitter {
  emit(event: SkillSelectorEvent): void
}

const SHADOW_LIMIT = 8

/** Deterministic token set of a skill's searchable text (name + description,
 * kebab underscores split — same normalization the BM25 index uses). */
function skillTerms(skill: SkillSummary): Set<string> {
  const terms = new Set<string>()
  for (const word of `${skill.name} ${skill.description}`.split(/[^A-Za-z0-9]+/)) {
    const t = word.toLowerCase()
    if (t.length > 0) terms.add(t)
  }
  return terms
}

/** Lexical n-gram variant: score a skill by how many distinct query tokens
 * appear in its name or description (substring matching — a "database" query
 * catches "rebuild-db" through the description), ties by name. Deterministic. */
function rankByLexicon(query: string, skills: SkillSummary[], limit: number): SkillSummary[] {
  const terms = query.toLowerCase().split(/[^A-Za-z0-9]+/).filter((t) => t.length > 0)
  if (terms.length === 0) return []
  return skills
    .map((skill) => {
      const text = skillTerms(skill)
      const score = terms.reduce((total, term) => total + ([...text].some((t) => t.includes(term) || term.includes(t)) ? 1 : 0), 0)
      return { skill, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map((entry) => entry.skill)
}

/** A query built so BM25 re-ranks toward the lexical variant (exact + `+`)
 * semantics excluded — the plain keyword path. */
function keywordQueryOf(query: string): string | undefined {
  const q = query.trim()
  if (q === "") return undefined
  if (q.toLowerCase().startsWith("select:")) return undefined
  return q
}

/**
 * The shadow candidate report for one `skill_search` query.
 *
 * - `exact`: the query IS a skill name (or a `select:` list) — the verified
 *   selection; reported first.
 * - `bm25`: the REAL selector's ranked hits (what behavior actually applied).
 * - `ngram`: the lexical variant's ranked hits (what a coarser selector would
 *   have picked) — deduped against the two above.
 *
 * Pure, deterministic (same inputs → same report), capped at SHADOW_LIMIT
 * entries; never throws for an empty query (reports an empty list).
 */
export function selectShadowCandidates(query: string, skills: SkillSummary[], opts?: { limit?: number }): ShadowReport {
  const limit = Math.max(1, Math.min(opts?.limit ?? SHADOW_LIMIT, 20))
  const candidates: ShadowCandidate[] = []
  const seen = new Set<string>()
  const add = (id: string, mode: ShadowCandidate["mode"]): void => {
    if (seen.has(id)) return
    seen.add(id)
    candidates.push({ id, rank: candidates.length + 1, mode })
  }

  // exact + select: — name-grammar selections first. An EXPLICIT query has no
  // lexical ambiguity: the selection is the report (ngram tokens like "select"
  // or a split kebab name would only add noise).
  const explicit = explicitMentionMatches(query, skills)
  for (const skill of explicit) add(skill.name, "exact")
  if (explicit.length > 0) return { query, candidates }

  // the real selector (bm25) — guarded: searchSkillSummaries throws on an
  // empty/invalid query, and the shadow must never break the tool call.
  const keyword = keywordQueryOf(query)
  if (keyword !== undefined) {
    try {
      for (const skill of searchSkillSummaries(keyword, skills, { limit })) add(skill.name, "bm25")
    } catch {
      // malformed query: the real tool will surface the failure — shadow stays silent
    }
  }

  // lexical variant (ngram)
  for (const skill of rankByLexicon(keyword ?? query, skills, limit)) add(skill.name, "ngram")

  return { query, candidates: candidates.slice(0, limit) }
}

/**
 * The explicit-invocation matches for `query`: whole-name mentions (one name
 * per word, case-insensitive — dsh name grammar) and `select:a,b` lists. A
 * partial/keyword mention ("deploy" for "deploy-db") is IMPLICIT — the gate
 * hides it when `allow_implicit_invocation` is false.
 */
export function explicitMentionMatches(query: string, skills: SkillSummary[]): SkillSummary[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill] as const))
  const out: SkillSummary[] = []
  const seen = new Set<string>()
  const push = (name: string): void => {
    const skill = byName.get(name)
    if (skill !== undefined && !seen.has(name)) {
      seen.add(name)
      out.push(skill)
    }
  }
  const q = query.trim()
  if (q === "") return []
  const lower = q.toLowerCase()
  if (lower.startsWith("select:")) {
    for (const name of q.slice(q.indexOf(":") + 1).split(",").map((s) => s.trim()).filter(Boolean)) push(name)
    return out
  }
  // whole-name mention: the skill name itself appears as a query word
  const words = new Set(q.split(/[\s,]+/).filter(Boolean))
  for (const skill of skills) {
    if (words.has(skill.name) || words.has(skill.name.toLowerCase())) push(skill.name)
  }
  return out
}
