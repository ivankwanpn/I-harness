import type { GuardFn, Listener, WaterfallHandler } from "../types.ts"
import type { InternalScope } from "./types.ts"
import { isPromiseLike } from "./promise.ts"

interface OwnedListener {
  event: string
  handler: Listener
}

/** Only the waterfall operations needed by emit; its registries stay private. */
interface WaterfallDispatch {
  snapshot(event: string): WaterfallHandler[]
  run(event: string, handlers: WaterfallHandler[], payload: unknown): Promise<unknown>
}

export function createListeners(
  getMountingPlugin: () => string | null,
  getScope: () => InternalScope,
  parentEmit: (event: string, payload: unknown) => Promise<unknown>,
  waterfall: WaterfallDispatch,
) {
  const listeners = new Map<string, Listener[]>()
  const pluginListeners = new Map<string, OwnedListener[]>()
  const guards = new Map<string, GuardFn[]>()
  // I3: a scope's own decision per event for the CURRENT emit, written by
  // emitFn only when a plain-listener producer actually seeded one (see
  // emitFn below). Cleared at the start of every emit so decisions never leak
  // across repeated emits for the same event.
  const decisions = new Map<string, unknown>()

  function registerListener(event: string, handler: Listener): void {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
    const mountingPlugin = getMountingPlugin()
    if (mountingPlugin !== null) {
      const owned = pluginListeners.get(mountingPlugin) ?? []
      owned.push({ event, handler })
      pluginListeners.set(mountingPlugin, owned)
    }
  }

  // Local guard pass: runs only THIS scope's guards. `checkGuards` walks the
  // ancestor chain and calls this per scope; union-of-ancestors semantics are
  // expressed in the walk (first non-undefined reason wins), keeping guards
  // deny-only and monotonic — a child allow (undefined) can never re-allow a
  // parent deny because the walk keeps ascending.
  function checkLocalGuards(event: string, exec: unknown): string | undefined {
    for (const fn of guards.get(event) ?? []) {
      const reason = fn(exec)
      if (reason !== undefined) return reason // first deny wins; later guards cannot re-allow
    }
    return undefined
  }

  function resolveLocalDecision(event: string): unknown | undefined {
    return decisions.get(event)
  }

  // Dispatch runs plain listeners FIRST, then the waterfall chain. Only events
  // that have a registered waterfall let listener returns seed the chain
  // payload: the last non-undefined listener return value becomes the chain
  // seed (falling back to the emitted payload), so a `ctx.on` pre-execute
  // producer can feed a decision object into the waterfall that a registry's
  // pre-execute handler reads. For plain events with no waterfall, listener
  // returns are ignored and the payload passes through unchanged, so an
  // incidental return value (e.g. `calls.push(x)` → a number) can never
  // rewrite what other listeners or the parent scope receive.
  //
  // I3 decision nearest-wins: a decision exists for this event only when a
  // plain-listener producer returned a non-undefined value that seeded the
  // chain. Detection is "a value was produced", NOT object identity — so a
  // producer that mutates and returns the same payload reference still counts,
  // and a waterfall that merely normalizes the payload does not create a
  // decision (it cannot shadow a parent decision as nearest). The entry is
  // cleared at the start of every emit so a scope's decision never leaks
  // across repeated emits: a pass-through emit reads the parent's FRESH
  // decision recorded during the same emit's propagation, not a stale one.
  async function emitFn(event: string, payload: unknown): Promise<unknown> {
    decisions.delete(event)
    const plainListeners = [...(listeners.get(event) ?? [])]
    const waterfallHandlers = waterfall.snapshot(event)
    let chainPayload = payload
    let seeded = false
    for (const handler of plainListeners) {
      const res = handler(payload)
      const resolved = isPromiseLike(res) ? await res : res
      if (waterfallHandlers.length > 0 && resolved !== undefined) {
        chainPayload = resolved
        seeded = true
      }
    }
    let resolvedPayload = chainPayload
    if (waterfallHandlers.length > 0) {
      resolvedPayload = (await waterfall.run(event, waterfallHandlers, chainPayload)) ?? chainPayload
    }
    if (seeded) decisions.set(event, chainPayload)
    await parentEmit(event, resolvedPayload)
    return resolvedPayload
  }

  // I3 guards union-of-ancestors: consult every scope from this one up to
  // the root. First non-undefined reason wins, so a child deny holds and a
  // child allow (undefined) can never override a parent deny — monotonic.
  function checkGuards(event: string, exec: unknown): string | undefined {
    let cur: InternalScope | null = getScope()
    while (cur) {
      const reason = cur.checkLocalGuards(event, exec)
      if (reason !== undefined) return reason
      cur = cur.parentScope
    }
    return undefined
  }

  // I3 decision nearest-wins: the nearest scope (self first) with a decision
  // recorded by its most recent emit of this event wins; if no scope in the
  // chain made one, fall back to the emitted payload.
  function resolveDecision(event: string, payload: unknown): unknown {
    let cur: InternalScope | null = getScope()
    while (cur) {
      const decision = cur.resolveLocalDecision(event)
      if (decision !== undefined) return decision
      cur = cur.parentScope
    }
    return payload
  }

  // I3 decision nearest-wins, ANCESTOR-ONLY: like `resolveDecision` but
  // starts at the parent scope, skipping `self`. M13 core-tools `prepare`
  // uses this: the local scope's decision already arrives per-dispatch via
  // `emit`'s return value, so reading THIS scope's recorded decision here
  // would surface a CONCURRENT dispatch's entry — the per-scope decisions
  // map is a shared slot across in-flight emits (the M13 decision-slot race).
  // Only ancestor decisions cannot be derived from the local emit, so only
  // they are looked up. Fall back to the emitted payload when no ancestor
  // made one.
  function resolveAncestorDecision(event: string, payload: unknown): unknown {
    let cur: InternalScope | null = getScope().parentScope
    while (cur) {
      const decision = cur.resolveLocalDecision(event)
      if (decision !== undefined) return decision
      cur = cur.parentScope
    }
    return payload
  }

  function reclaim(name: string): void {
    for (const { event, handler } of pluginListeners.get(name) ?? []) {
      const list = listeners.get(event)
      if (list) {
        const index = list.indexOf(handler)
        if (index !== -1) list.splice(index, 1)
      }
    }
    pluginListeners.delete(name)
  }

  function guard(event: string, fn: GuardFn): void {
    const list = guards.get(event) ?? []
    list.push(fn)
    guards.set(event, list)
  }

  return {
    register: registerListener,
    emit: emitFn,
    guard,
    checkLocalGuards,
    checkGuards,
    resolveLocalDecision,
    resolveDecision,
    resolveAncestorDecision,
    reclaim,
  }
}
