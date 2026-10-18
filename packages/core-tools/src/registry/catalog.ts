import { assertSupportedJsonSchema } from "../json-schema.ts"
import { ToolNotFoundError, type Tool, type ToolSchema, type SearchableTool, type ToolCall } from "../types.ts"

// Sole owner of registration generations, tools, promotions and the search hook.
export function createCatalog() {
  const bindingGenerations = new Map<string, number>()
  const tools = new Map<string, Tool>()
  // Deferred tools whose names were returned by the search engine are promoted
  // into schemas() output (but never hidden tools). Additive metadata: a name
  // stays promoted for the registry's lifetime.
  const promoted = new Set<string>()
  // Pluggable search engine hook, installed via installSearch(). Until then,
  // search() fails loud rather than returning an empty corpus.
  let searchFn: ((query: string, opts?: { limit?: number }) => ToolSchema[]) | undefined
  function register(tool: Tool): void {
    // Same-layer duplicate name fails loud (audit F03-5); child scopes create
    // their own registry instance and shadow freely by name.
    if (tools.has(tool.name)) throw new Error(`duplicate tool registration: ${tool.name}`)
    // The assertion is IH's contract with itself — see Tool.inputSchemaForeign.
    if (tool.inputSchemaForeign !== true) assertSupportedJsonSchema(tool.inputSchema)
    tools.set(tool.name, tool)
    bindingGenerations.set(tool.name, (bindingGenerations.get(tool.name) ?? 0) + 1)
  }

  // Metadata lookup for policy consumers (guard-approval reads isReadOnly /
  // getArgv before dispatch). Returns undefined for unknown names so callers
  // can fail closed instead of throwing.
  function get(name: string): Tool | undefined {
    return tools.get(name)
  }

  // Removes the tool and its promotion state — the clean ownership boundary so
  // a mount (e.g. MCP) can take back the tools it registered. Unknown names are
  // a no-op so disposers can run twice safely.
  function unregister(name: string): void {
    tools.delete(name)
    promoted.delete(name)
  }

  function schemas(): ToolSchema[] {
    // Hidden tools never surface in schemas(); deferred tools surface only
    // after promotion via search().
    //
    // M5/D1: the tool array is the FIRST thing in the cached prompt, so a change
    // to it is a cache break at byte 0 — the WHOLE prompt, not just the tool
    // span. Two ways it could churn, both closed here:
    //   1. Map insertion order is mount order (plugin load, MCP connect), so two
    //      assemblies of the same session could disagree. Sorting makes the
    //      array a function of its CONTENTS, not of when things registered.
    //   2. Promotion used to insert a deferred tool at its registration index,
    //      shifting every tool after it. Ranking deferred ones last makes
    //      promotion an APPEND, so what was already sent stays byte-identical.
    // Compared by code unit, not `localeCompare`: the latter follows the host's
    // locale/ICU, which would reintroduce machine-dependent bytes.
    return [...tools.values()]
      .filter((t) => t.exposure !== "hidden" && (t.exposure !== "deferred" || promoted.has(t.name)))
      .sort((a, b) => {
        const rank = (t: Tool): number => (t.exposure === "deferred" ? 1 : 0)
        return rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      })
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        exposure: t.exposure ?? "direct",
      }))
  }

  // Pluggable search hook (opencode-fork mechanism). installSearch replaces the
  // engine; search() delegates to it and promotes every returned name so the
  // corresponding deferred tool surfaces in schemas().
  function installSearch(fn: (query: string, opts?: { limit?: number }) => ToolSchema[]): void {
    searchFn = fn
  }

  function search(query: string, opts?: { limit?: number }): ToolSchema[] {
    if (!searchFn) throw new Error("no search engine installed")
    const matches = searchFn(query, opts)
    for (const m of matches) promoted.add(m.name)
    return matches
  }

  function promote(names: readonly string[]): void {
    for (const name of names) if (!tools.has(name)) throw new Error(`unknown tool: ${name}`)
    for (const name of names) if (tools.get(name)!.exposure === "deferred") promoted.add(name)
  }

  // Raw metadata of all deferred tools, used as the search corpus by the
  // search engine (Task 2). searchHint boosts matching when present.
  function deferredSearchIndex(): SearchableTool[] {
    return [...tools.values()]
      .filter((t) => t.exposure === "deferred")
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.searchHint !== undefined ? { searchHint: t.searchHint } : {}),
      }))
  }

  function deferredToolCount(): number {
    return deferredSearchIndex().length
  }

  function genToolCatalog(): ToolSchema[] {
    return schemas()
  }

  function verifyToolCatalog(expected: Tool[], catalog: ToolSchema[]): void {
    const catalogNames = new Set(catalog.map((s) => s.name))
    const missing = expected.map((t) => t.name).filter((n) => !catalogNames.has(n))
    if (missing.length > 0) {
      throw new Error(`catalog completeness: missing tools: ${missing.join(", ")}`)
    }
  }

  function captureBinding(call: ToolCall) {
    const tool = tools.get(call.name)
    if (!tool) throw new ToolNotFoundError(call.name)
    const bindingGeneration = bindingGenerations.get(call.name)!
    const executeBinding = tool.execute
    const bindingValidation = () => tools.get(call.name) === tool
      && bindingGenerations.get(call.name) === bindingGeneration && tool.execute === executeBinding

    return { tool, bindingGeneration, bindingValidation }
  }

  return { register, get, unregister, schemas, genToolCatalog, verifyToolCatalog, installSearch, search, promote, deferredSearchIndex, deferredToolCount, captureBinding }
}
