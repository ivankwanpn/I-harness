import type { CascadeHandler } from "../types.ts"
import type { InternalScope } from "./types.ts"

interface OwnedCascade {
  event: string
  handler: CascadeHandler<unknown, unknown>
}

export function createCascades(
  getMountingPlugin: () => string | null,
  getScope: () => InternalScope,
) {
  const cascades = new Map<string, CascadeHandler<unknown, unknown>[]>()
  const pluginCascades = new Map<string, OwnedCascade[]>()

  function registerCascade(event: string, handler: CascadeHandler<unknown, unknown>): void {
    const list = cascades.get(event) ?? []
    list.push(handler)
    cascades.set(event, list)
    const mountingPlugin = getMountingPlugin()
    if (mountingPlugin !== null) {
      const owned = pluginCascades.get(mountingPlugin) ?? []
      owned.push({ event, handler })
      pluginCascades.set(mountingPlugin, owned)
    }
  }

  // Local cascade snapshot for the ancestor walk in dispatchCascade: only
  // THIS scope's handlers, re-snapshotted per call so mid-dispatch
  // registrations don't affect the current run.
  function localCascades(event: string): CascadeHandler<unknown, unknown>[] {
    return [...(cascades.get(event) ?? [])]
  }

  // Cascade dispatch: `ctx.cascade` handlers are AROUND hooks over a single
  // `final` function — unlike waterfall, `next()` returns the inner result and
  // a handler that skips `next()` short-circuits (legal, no "forgot next"
  // error). Double-`next` throws. Only registered cascade handlers run (plain
  // listeners never do); the handler list is re-snapshotted per dispatch so
  // mid-dispatch registrations don't affect the current run.
  //
  // Ancestor visibility (M10a final-review): like `checkGuards` and
  // `resolveDecision`, the dispatch walks the parent chain — handlers are
  // collected ROOT-FIRST then self-last, so a cascade handler mounted on an
  // ancestor scope wraps dispatches made on a child scope (root handlers run
  // OUTERMOST; a child's own handlers wrap closer to the tool). This matters
  // because a child scope (M8 subagents) creates its own cascade registry, and
  // a root-mounted handler (e.g. guard-timeout) must stay visible to it.
  async function dispatchCascade<TInput, TOutput>(
    event: string,
    input: TInput,
    final: () => Promise<TOutput>,
  ): Promise<TOutput> {
    // Walk self → root, then reverse for root-first composition, flattening
    // each scope's local snapshot in registration order.
    const chain: InternalScope[] = []
    for (let cur: InternalScope | null = getScope(); cur; cur = cur.parentScope) chain.push(cur)
    chain.reverse()
    const handlers: CascadeHandler<unknown, unknown>[] = []
    for (const scope of chain) handlers.push(...scope.localCascades(event))
    if (handlers.length === 0) return final() // unchanged no-op path
    const run = (i: number): Promise<TOutput> => {
      if (i >= handlers.length) return final()
      let nextCalled = false
      const next = (): Promise<TOutput> => {
        if (nextCalled) {
          throw new Error(`cascade handler ${i} for '${event}' called next() twice`)
        }
        nextCalled = true
        return run(i + 1)
      }
      return handlers[i]!(input, next) as Promise<TOutput>
    }
    return run(0)
  }

  function reclaim(name: string): void {
    for (const { event, handler } of pluginCascades.get(name) ?? []) {
      const list = cascades.get(event)
      if (list) {
        const index = list.indexOf(handler)
        if (index !== -1) list.splice(index, 1)
      }
    }
    pluginCascades.delete(name)
  }

  return { register: registerCascade, localCascades, dispatch: dispatchCascade, reclaim }
}
