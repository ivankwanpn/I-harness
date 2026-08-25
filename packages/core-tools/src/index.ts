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

export interface PreparedCall {
  call: ToolCall
  tool: Tool
  exec: ToolExec
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

function isDecision(value: unknown): value is ToolDecision {
  return typeof value === "object" && value !== null && "kind" in value && DECISION_KINDS.has((value as ToolDecision).kind)
}

type ApprovalAnswerer = (req: { name: string; reason: string }) => Promise<boolean>

export interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  unregister(name: string): void
  schemas(): ToolSchema[]
  prepare(call: ToolCall, signal?: AbortSignal): Promise<PreparedCall>
  dispatch(prepared: PreparedCall): Promise<unknown>
  finalize(prepared: PreparedCall, output: unknown): Promise<ToolResult>
  execute(call: ToolCall, opts?: { signal?: AbortSignal }): Promise<ToolResult>
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
  // Per-dispatch pre-execute decision (M13): the handler RETURNS the validated
  // candidate as the waterfall chain value (read by `prepare` from emit's
  // return) instead of writing a shared closure slot — a shared slot races
  // under concurrent prepares. The handler is still registered ONCE at
  // construction so dispatches reuse it (no transient handler churn).
  //
  // CRITICAL — return `undefined` (not `{ kind: "allow" }`) when no decision
  // was produced: emitFn propagates `resolvedPayload` parent-ward, and a
  // parent scope's guard-approval classifies the ToolCall payload. Returning a
  // decision object here would make the parent see a decision instead of the
  // call and skip classification (fail-open for ancestor approval). Returning
  // undefined falls back to the chain payload (the call) — the pre-M13
  // semantics. `prepare` normalizes the undefined case to allow.
  ctx.waterfall("tools/pre-execute", async (payload, next) => {
    const chainValue = await next(payload)
    // Closed-vocabulary rules (audit F03-1):
    //   - undefined                → no decision (allow)
    //   - object WITHOUT a `kind`  → raw ToolCall passthrough → no decision
    //   - object WITH a `kind`     → must be in DECISION_KINDS else HARD error
    //   - any non-object value     → malformed decision, HARD error (never allow)
    if (chainValue === undefined) return undefined
    if (typeof chainValue !== "object" || chainValue === null) {
      throw new Error(`malformed pre-execute decision: ${JSON.stringify(chainValue)}`)
    }
    const candidate = chainValue as ToolDecision
    if (!("kind" in candidate)) return undefined
    if (!DECISION_KINDS.has(candidate.kind)) {
      throw new Error(`malformed pre-execute decision: ${JSON.stringify(chainValue)}`)
    }
    return candidate
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
    return [...tools.values()]
      .filter((t) => t.exposure !== "hidden" && (t.exposure !== "deferred" || promoted.has(t.name)))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        exposure: t.exposure ?? "direct",
      }))
  }

  async function prepare(call: ToolCall, signal?: AbortSignal): Promise<PreparedCall> {
    const tool = tools.get(call.name)
    if (!tool) throw new Error(`unknown tool: ${call.name}`)

    // 1. pre-execute waterfall — resolves to a closed-vocabulary decision.
    //    Per-dispatch (M13): the decision is the emit's chain return (or the
    //    call payload when no decision was produced — see the handler's
    //    CRITICAL comment); no shared slot, so concurrent prepares are
    //    independent.
    const chainValue = await ctx.emit("tools/pre-execute", call)
    const decision: ToolDecision = isDecision(chainValue) ? chainValue : { kind: "allow" }

    // 1b. Cross-scope fail-open fix (Task 10 mechanism B): `emit` propagates
    //     CHILD → PARENT, so a policy mounted on an ancestor scope (e.g.
    //     guard-approval on the parent) runs and may decide, but its decision
    //     never flows BACK DOWN into this registry's own waterfall chain — the
    //     local `decision` would stay "allow" and a dangerous child-scope
    //     dispatch would execute silently. The scope plumbing records ancestor
    //     decisions (plain-listener seeds, nearest-wins) and exposes them via
    //     `ctx.resolveAncestorDecision`; consult it and merge so a stricter
    //     ancestor decision gates this dispatch from any scope in the chain.
    //
    //     M13: the lookup is ANCESTOR-ONLY (`resolveAncestorDecision` skips
    //     self). The self decision is already the per-dispatch `decision` above
    //     (emit's chain return), and core-plugin's per-scope decisions map is a
    //     SHARED slot across concurrent in-flight emits — reading it here would
    //     let one dispatch's decision leak into a concurrent sibling's merge
    //     (the same race the emit-return refactor removes for the closure
    //     slot). Only ancestor decisions cannot be derived from the local emit,
    //     so only they are looked up.
    const ancestorDecision = ctx.resolveAncestorDecision("tools/pre-execute", call)
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

    // M13: seed the per-dispatch exec with the caller signal so in-flight tool
    // bodies observe a step abort (guard-timeout links its derived controller
    // to this upstream signal; untimed tools honor exec.abortSignal directly).
    const exec: ToolExec = {}
    if (signal) exec.abortSignal = signal

    return { call, tool, exec }
  }

  // M13 dispatch stage — the ONLY overlapping stage: runs the around-seam
  // (`tools/execute` cascade handlers wrap the real tool body). `prepare` and
  // `finalize` run in the ordered lane so the policy layer stays model-ordered.
  async function dispatch(prepared: PreparedCall): Promise<unknown> {
    const output = await ctx.cascade(
      "tools/execute",
      { name: prepared.call.name, args: prepared.call.args, exec: prepared.exec, tool: prepared.tool },
      async () => prepared.tool.execute(prepared.call.args as never, prepared.exec),
    )
    return output
  }

  async function finalize(prepared: PreparedCall, output: unknown): Promise<ToolResult> {
    // 5. post-execute waterfall.
    await ctx.emit("tools/post-execute", { name: prepared.call.name, output })
    return { name: prepared.call.name, output }
  }

  // M13: thin sequential wrapper — behavior byte-identical to the pre-M13
  // `execute` for every existing caller (tests, CLI paths, subagent drivers).
  async function execute(call: ToolCall, opts?: { signal?: AbortSignal }): Promise<ToolResult> {
    const prepared = await prepare(call, opts?.signal)
    const output = await dispatch(prepared)
    return finalize(prepared, output)
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
    unregister,
    schemas,
    prepare,
    dispatch,
    finalize,
    execute,
    genToolCatalog,
    verifyToolCatalog,
    installSearch,
    search,
    deferredSearchIndex,
    deferredToolCount,
  }
}
