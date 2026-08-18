import type { PluginContext } from "@i-harness/core-plugin"

export type ToolExposure = "direct" | "deferred" | "hidden"

export interface Tool<Args = unknown, Output = unknown> {
  name: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  execute(args: Args, exec: ToolExec): Promise<Output>
  timeoutMs?: number
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  getArgv?(args: Args): string[]
  exposure?: ToolExposure
  searchHint?: string
}

export interface ToolExec {
  abortSignal?: AbortSignal
}

export type ToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string }

export interface ToolCall {
  name: string
  args: unknown
}

export interface ToolResult {
  name: string
  output: unknown
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: unknown
  exposure: ToolExposure
}

export interface SearchableTool {
  name: string
  description: string
  inputSchema: unknown
  searchHint?: string
}

const DECISION_KINDS = new Set(["allow", "deny", "ask"])

// Strictness ranking for decision merging: deny > ask > allow. A stricter
// decision always wins so an ancestor deny can never be downgraded by a nearer
// allow (monotonic, matching the guard layer's union-of-ancestors semantics).
const DECISION_STRICTNESS: Record<ToolDecision["kind"], number> = { allow: 0, ask: 1, deny: 2 }

// Decision merge is single-candidate: resolveDecision returns the NEAREST
// ancestor decision, and the propagation model allows at most one producer
// per emit (once a nearer policy seeds, the payload reaching farther
// ancestors is the decision object, which policies refuse to re-classify).
// A resolveStrictestDecision walk is therefore a no-op today; revisit only if
// multi-producer decisions become possible.

// Validate an arbitrary value against the same closed-vocabulary rules as the
// pre-execute waterfall handler (audit F03-1): a non-object is malformed
// (HARD error, never allow); an object without `kind` contributes no decision;
// an object whose `kind` is outside the vocabulary is malformed. Returns the
// stricter of the local decision and the (validated) candidate.
function mergeDecision(local: ToolDecision, candidate: unknown): ToolDecision {
  if (candidate === undefined) return local
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error(`malformed pre-execute decision: ${JSON.stringify(candidate)}`)
  }
  const d = candidate as ToolDecision
  if (!("kind" in d)) return local
  if (!DECISION_KINDS.has(d.kind)) {
    throw new Error(`malformed pre-execute decision: ${JSON.stringify(candidate)}`)
  }
  return DECISION_STRICTNESS[d.kind] > DECISION_STRICTNESS[local.kind] ? d : local
}

type ApprovalAnswerer = (req: { name: string; reason: string }) => Promise<boolean>

export interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  schemas(): ToolSchema[]
  execute(call: ToolCall): Promise<ToolResult>
  genToolCatalog(): ToolSchema[]
  verifyToolCatalog(expected: Tool[], catalog: ToolSchema[]): void
  installSearch(fn: (query: string, opts?: { limit?: number }) => ToolSchema[]): void
  search(query: string, opts?: { limit?: number }): ToolSchema[]
  deferredSearchIndex(): SearchableTool[]
  deferredToolCount(): number
}

export function createToolRegistry(ctx: PluginContext): ToolRegistry {
  const tools = new Map<string, Tool>()
  // Deferred tools whose names were returned by the search engine are promoted
  // into schemas() output (but never hidden tools). Additive metadata: a name
  // stays promoted for the registry's lifetime.
  const promoted = new Set<string>()
  // Pluggable search engine hook, installed via installSearch(). Until then,
  // search() fails loud rather than returning an empty corpus.
  let searchFn: ((query: string, opts?: { limit?: number }) => ToolSchema[]) | undefined
  // Single pre-execute decision slot. The waterfall handler is registered ONCE
  // at construction (not per-execute) so dispatches reuse it instead of
  // accumulating transient handlers in core-plugin's waterfall map.
  let decision: ToolDecision = { kind: "allow" }

  ctx.waterfall("tools/pre-execute", async (payload, next) => {
    const chainValue = await next(payload)
    // Closed-vocabulary rules (audit F03-1):
    //   - undefined                → no decision (allow)
    //   - object WITHOUT a `kind`  → raw ToolCall passthrough → no decision
    //   - object WITH a `kind`     → must be in DECISION_KINDS else HARD error
    //   - any non-object value     → malformed decision, HARD error (never allow)
    if (chainValue === undefined) return
    if (typeof chainValue !== "object" || chainValue === null) {
      throw new Error(`malformed pre-execute decision: ${JSON.stringify(chainValue)}`)
    }
    const candidate = chainValue as ToolDecision
    if (!("kind" in candidate)) return
    if (!DECISION_KINDS.has(candidate.kind)) {
      throw new Error(`malformed pre-execute decision: ${JSON.stringify(chainValue)}`)
    }
    decision = candidate
  })

  function register(tool: Tool): void {
    // Same-layer duplicate name fails loud (audit F03-5); child scopes create
    // their own registry instance and shadow freely by name.
    if (tools.has(tool.name)) throw new Error(`duplicate tool registration: ${tool.name}`)
    tools.set(tool.name, tool)
  }

  // Metadata lookup for policy consumers (guard-approval reads isReadOnly /
  // getArgv before dispatch). Returns undefined for unknown names so callers
  // can fail closed instead of throwing.
  function get(name: string): Tool | undefined {
    return tools.get(name)
  }

  function schemas(): ToolSchema[] {
    // Hidden tools never surface in schemas(); deferred tools surface only
    // after promotion via search().
    return [...tools.values()]
      .filter((t) => t.exposure !== "hidden" && (t.exposure !== "deferred" || promoted.has(t.name)))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        exposure: t.exposure ?? "direct",
      }))
  }

  async function execute(call: ToolCall): Promise<ToolResult> {
    const tool = tools.get(call.name)
    if (!tool) throw new Error(`unknown tool: ${call.name}`)

    // 1. pre-execute waterfall — resolves to a closed-vocabulary decision.
    decision = { kind: "allow" }
    await ctx.emit("tools/pre-execute", call)

    // 1b. Cross-scope fail-open fix (Task 10 mechanism B): `emit` propagates
    // CHILD → PARENT, so a policy mounted on an ancestor scope (e.g.
    // guard-approval on the parent) runs and may decide, but its decision never
    // flows BACK DOWN into this registry's own waterfall chain — the local
    // `decision` slot would stay "allow" and a dangerous child-scope dispatch
    // would execute silently. The scope plumbing records ancestor decisions
    // (plain-listener seeds, nearest-wins) and exposes them via
    // `ctx.resolveDecision`; consult it and merge so a stricter ancestor
    // decision gates this dispatch from any scope in the chain.
    const ancestorDecision = ctx.resolveDecision("tools/pre-execute", call)
    const resolved = mergeDecision(decision, ancestorDecision)

    // 2. monotonic guards run UNCONDITIONALLY before any dispatch (audit F03-1):
    //    a decision-shaped object can never short-circuit the guard layer.
    const guardReason = ctx.checkGuards("tools/execute", { name: call.name, args: call.args })
    if (guardReason !== undefined) throw new Error(`guard denied: ${guardReason}`)

    // 3. decision enforcement + approval seam — fail closed: no answerer ⇒ deny.
    if (resolved.kind === "deny") throw new Error(`denied: ${resolved.reason}`)
    if (resolved.kind === "ask") {
      let answerer: ApprovalAnswerer | null = null
      try {
        answerer = ctx.services.get<ApprovalAnswerer>("approval/answerer")
      } catch {
        answerer = null
      }
      if (!answerer) {
        throw new Error(`approval required but no answerer registered (fail closed): ${resolved.reason}`)
      }
      const ok = await answerer({ name: call.name, reason: resolved.reason })
      if (!ok) throw new Error(`denied by user: ${resolved.reason}`)
    }

    // 4. dispatch — around-seam: registered `tools/execute` cascade handlers
    // (e.g. guard approval wrappers) may observe / wrap / substitute the real
    // tool dispatch. With no handlers, `ctx.cascade` runs `final` directly —
    // identical behavior to a plain `tool.execute` call. Skipping `next()` in
    // a handler short-circuits the dispatch (the tool never runs).
    const exec: ToolExec = {}
    const output = await ctx.cascade(
      "tools/execute",
      { name: call.name, args: call.args, exec, tool },
      async () => tool.execute(call.args as never, exec),
    )

    // 5. post-execute waterfall.
    await ctx.emit("tools/post-execute", { name: call.name, output })

    return { name: call.name, output }
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

  return {
    register,
    get,
    schemas,
    execute,
    genToolCatalog,
    verifyToolCatalog,
    installSearch,
    search,
    deferredSearchIndex,
    deferredToolCount,
  }
}
