import { assertSupportedJsonSchema } from "../json-schema.ts"
import { ToolNotFoundError, type Tool, type ToolSchema, type SearchableTool, type ToolCall } from "../types.ts"

function dataMethod(owner: object, name: string): Function | undefined {
  for (let current: object | null = owner; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor) {
      if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'function')) throw new TypeError(`Invalid ${name} method`)
      return descriptor.value
    }
  }
  return undefined
}

// Sole owner of registration generations, tools, promotions and the search hook.
export function createCatalog() {
  const bindingGenerations = new Map<string, number>()
  const tools = new Map<string, Tool>()
  // Deferred tools whose names were returned by the search engine are promoted
  // into schemas() output (but never hidden tools). Additive metadata: a name
  // stays promoted for the registry's lifetime.
  // A searched name can be registered later. Assign its position only when
  // schemas() first exposes it in a successful catalogue read.
  const promoted = new Map<string, number | undefined>()
  let lastVisibleBatch = 0
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

  function recordPromotion(name: string): void {
    if (!promoted.has(name)) promoted.set(name, undefined)
  }

  function schemas(): ToolSchema[] {
    // Direct tools and each newly exposed batch have stable code-unit order.
    // Later discoveries append after the tool definitions already sent.
    const nextBatch = lastVisibleBatch + 1
    const rank = (tool: Tool): number => tool.exposure === "deferred" ? promoted.get(tool.name) ?? nextBatch : 0
    const visible = [...tools.values()]
      .filter((t) => t.exposure !== "hidden" && (t.exposure !== "deferred" || promoted.has(t.name)))
      .sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        exposure: t.exposure ?? "direct",
      }))
    for (const schema of visible) {
      if (schema.exposure === "deferred" && promoted.has(schema.name) && promoted.get(schema.name) === undefined) {
        promoted.set(schema.name, nextBatch)
        lastVisibleBatch = nextBatch
      }
    }
    return visible
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
    for (const match of matches) recordPromotion(match.name)
    return matches
  }

  function promote(names: readonly string[]): void {
    for (const name of names) if (!tools.has(name)) throw new Error(`unknown tool: ${name}`)
    for (const name of names) if (tools.get(name)!.exposure === "deferred") recordPromotion(name)
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
    const executeBinding = dataMethod(tool, 'execute')
    if (!executeBinding) throw new TypeError('Invalid execute method')
    const planBinding = dataMethod(tool, 'captureNativePlan') as Tool['captureNativePlan']
    const bindingValidation = () => {
      try { return tools.get(call.name) === tool && bindingGenerations.get(call.name) === bindingGeneration
        && dataMethod(tool, 'execute') === executeBinding && dataMethod(tool, 'captureNativePlan') === planBinding }
      catch { return false }
    }

    return { tool, bindingGeneration, bindingValidation, planBinding, executeBinding: executeBinding as Tool['execute'] }
  }

  return { register, get, unregister, schemas, genToolCatalog, verifyToolCatalog, installSearch, search, promote, deferredSearchIndex, deferredToolCount, captureBinding }
}
