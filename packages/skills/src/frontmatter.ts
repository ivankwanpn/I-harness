// SKILL.md front-matter parsing. The --- fence itself is line-oriented (a
// trimmed exact `---` match opens and closes the block), but the meta block is
// parsed with the `yaml` package — complete YAML 1.2, NOT hand-rolled
// line-oriented parsing (edge cases silently mis-parsing a description would
// mean wrong guidance for the model). Only scalar `name`/`description` keys
// are recognized: any nested or non-scalar value anywhere in the meta block
// makes the whole document invalid (undefined — the caller warns and skips).
import { parse } from "yaml"

export interface SkillFrontmatter {
  name?: string
  description?: string
}

export interface ParsedSkill {
  meta: SkillFrontmatter
  body: string
}

const FENCE = "---"

// Parse `---` front-matter + body from a SKILL.md document.
// Returns undefined (bad skill — caller warns and skips) when:
//  - the document does not start with a `---` fence line, or the fence is never
//    closed;
//  - the meta block is not a YAML mapping;
//  - any meta value is non-scalar (nested object/array) or `name`/`description`
//    are present but not strings;
//  - YAML itself fails to parse the meta block.
export function parseFrontmatter(input: string): ParsedSkill | undefined {
  const lines = input.split(/\r?\n/)
  if (lines[0]?.trim() !== FENCE) return undefined
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      close = i
      break
    }
  }
  if (close === -1) return undefined // unclosed fence
  const metaText = lines.slice(1, close).join("\n")
  const body = lines.slice(close + 1).join("\n")
  let doc: unknown
  try {
    doc = parse(metaText)
  } catch {
    return undefined
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined
  const record = doc as Record<string, unknown>
  const meta: SkillFrontmatter = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "object" && value !== null) return undefined // nested / non-scalar → bad file
    if (key === "name") {
      if (typeof value !== "string") return undefined
      const name = value.trim()
      if (name.length > 0) meta.name = name
    } else if (key === "description") {
      if (typeof value !== "string") return undefined
      // Required single line: YAML folding (`>`) may introduce newlines —
      // collapse whitespace runs into one space (codex single-line discipline).
      const description = value.replace(/\s+/g, " ").trim()
      if (description.length > 0) meta.description = description
    }
    // Unknown scalar keys are tolerated and ignored (forward compatibility).
  }
  return { meta, body }
}
