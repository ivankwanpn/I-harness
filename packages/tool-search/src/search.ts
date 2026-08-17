// Self-developed BM25 tool search, modeled on the opencode-fork reference
// (packages/core/src/tool/tool-search.ts). Pure functions only — no I/O.

const STOPWORDS = new Set(["the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "with", "is", "are", "my"])
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const K1 = 1.2
const B = 0.75

export interface Searchable {
  name: string
  description: string
  inputSchema: unknown
  searchHint?: string
}

export interface SearchOptions {
  limit?: number
  defaultLimit?: number
}

export function splitName(value: string): string {
  return value
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
}

export function tokenize(value: string): string[] {
  return splitName(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0 && !STOPWORDS.has(term))
}

function schemaText(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) schemaText(item, parts)
    return
  }
  if (typeof value !== "object" || value === null) return
  const record = value as Record<string, unknown>
  if (typeof record.title === "string") parts.push(record.title)
  if (typeof record.description === "string") parts.push(record.description)
  if (record.properties && typeof record.properties === "object") {
    for (const [name, property] of Object.entries(record.properties as Record<string, unknown>)) {
      parts.push(name, splitName(name))
      schemaText(property, parts)
    }
  }
  if (record.items !== undefined) schemaText(record.items, parts)
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(record[key])) schemaText(record[key], parts)
  }
  if (Array.isArray(record.enum)) {
    for (const item of record.enum) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") parts.push(String(item))
    }
  }
}

export function searchText(tool: Searchable): string {
  const parts: string[] = [
    tool.name,
    splitName(tool.name),
    tool.description,
    tool.searchHint,
  ].filter((part): part is string => Boolean(part?.trim()))
  schemaText(tool.inputSchema, parts)
  return parts.join(" ")
}

function normalize(query: string, opts?: SearchOptions): { query: string; limit: number } {
  const q = query.trim()
  if (!q) throw new Error("query must not be empty")
  const limit = opts?.limit ?? opts?.defaultLimit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`)
  }
  return { query: q, limit }
}

function select(query: string, tools: Searchable[], limit: number): Searchable[] {
  const names = query.split(",").map((s) => s.trim()).filter(Boolean)
  if (names.length === 0) throw new Error("select requires one or more exact tool names")
  const matches: Searchable[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`unknown exact tool selector: ${name}`)
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    matches.push(tool)
  }
  if (matches.length > limit) throw new Error(`select returned more than the requested limit: ${limit}`)
  return matches
}

function exact(query: string, tools: Searchable[]): Searchable | undefined {
  return tools.find((t) => t.name.toLowerCase() === query.toLowerCase())
}

function rank(query: string, documents: { tool: Searchable; freq: Map<string, number>; length: number }[], avgLength: number, count: number, limit: number): Searchable[] {
  if (documents.length === 0 || avgLength === 0) return []
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0) return []
  const docFreq = new Map<string, number>()
  for (const doc of documents) {
    for (const term of doc.freq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
  }
  return documents
    .map((doc) => ({
      tool: doc.tool,
      score: terms.reduce((total, term) => {
        const f = doc.freq.get(term) ?? 0
        if (f === 0) return total
        const df = docFreq.get(term) ?? 0
        const inverse = Math.log(1 + (count - df + 0.5) / (df + 0.5))
        const denominator = f + K1 * (1 - B + (B * doc.length) / avgLength)
        return total + inverse * ((f * (K1 + 1)) / denominator)
      }, 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((entry) => entry.tool)
}

export function search(query: string, tools: Searchable[], opts?: SearchOptions): Searchable[] {
  const { query: q, limit } = normalize(query, opts)

  if (q.toLowerCase().startsWith("select:")) {
    return select(q.slice(q.indexOf(":") + 1), tools, limit)
  }

  const exactMatch = exact(q, tools)
  if (exactMatch) return [exactMatch]

  // +term required semantics: a tool must contain every required term in its
  // search text; the remaining terms rank by BM25.
  const terms = q.split(/\s+/).filter(Boolean)
  const required = terms.filter((t) => t.startsWith("+")).map((t) => t.slice(1))
  const optional = terms.filter((t) => !t.startsWith("+"))
  const allTerms = [...required, ...optional]
  const documents = tools.map((tool) => {
    const text = searchText(tool)
    const toks = tokenize(text)
    const freq = new Map<string, number>()
    for (const tok of toks) freq.set(tok, (freq.get(tok) ?? 0) + 1)
    return { tool, freq, length: toks.length }
  })
  let candidates = documents
  if (required.length > 0) {
    candidates = documents.filter((doc) => {
      const toks = new Set(doc.freq.keys())
      return required.every((term) => toks.has(term))
    })
  }
  const avgLength = candidates.length === 0 ? 0 : candidates.reduce((s, d) => s + d.length, 0) / candidates.length
  const searchQuery = allTerms.join(" ")
  return rank(searchQuery, candidates, avgLength, candidates.length, limit)
}
