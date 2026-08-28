// BM25 over skills, reusing @i-harness/tool-search's engine. A skill maps onto
// the engine's Searchable shape with NO inputSchema and NO searchHint — the
// searchable text is exactly the skill name + description (bodies stay
// deferred on disk; that is the whole point of the deferred-retrieval model).
import { search, type SearchOptions, type Searchable } from "@i-harness/tool-search"
import type { SkillSummary } from "./registry.ts"

export type { SearchOptions, Searchable }

export function toSearchable(skill: SkillSummary): Searchable {
  return { name: skill.name, description: skill.description, inputSchema: undefined, searchHint: undefined }
}

// Rank skills for `query` with the tool-search BM25 engine (exact-name match,
// `select:name1,name2` and `+term` semantics included) and map the hits back
// to the original summaries. Query/limit validation is the engine's — empty
// queries and out-of-range limits fail loud, consistent with tool_search.
export function searchSkillSummaries(query: string, skills: SkillSummary[], opts?: { limit?: number }): SkillSummary[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill] as const))
  const options: SearchOptions | undefined = opts?.limit !== undefined ? { limit: opts.limit } : undefined
  return search(query, skills.map(toSearchable), options).flatMap((hit) => {
    const skill = byName.get(hit.name)
    return skill ? [skill] : []
  })
}
