export type NextFn = (payload: unknown) => unknown | Promise<unknown>
export type Listener = (payload: unknown) => unknown
export type WaterfallHandler = (payload: unknown, next: NextFn) => unknown | Promise<unknown>
export type GuardFn = (exec: unknown) => string | undefined

export interface Plugin {
  name: string
  mount(ctx: PluginContext): void
  unmount?(ctx: PluginContext): void | Promise<void>
}

export interface PluginContext {
  services: {
    register(name: string, impl: unknown): void
    get<T>(name: string): T
  }
  scope: {
    mount(): PluginContext
    unmount(): void
  }
  on(event: string, handler: Listener): void
  emit(event: string, payload: unknown): Promise<void>
  waterfall(event: string, handler: WaterfallHandler): void
  guard(event: string, fn: GuardFn): void
  checkGuards(event: string, exec: unknown): string | undefined
  resolveDecision(event: string, payload: unknown): unknown
  mount(plugin: Plugin): void
  unmount(name: string): Promise<void>
}

// Internal scope plumbing used to walk the ancestor chain. Only reachable
// through the createScope closure (not part of the public surface): every
// scope exposes its local guard check and its recorded decision so ancestors
// and descendants can compose without leaking their maps.
interface InternalScope {
  parentScope: InternalScope | null
  checkLocalGuards(event: string, exec: unknown): string | undefined
  resolveLocalDecision(event: string): unknown | undefined
}

type ServiceStore = Map<string, unknown>

const UNMOUNT_TIMEOUT_MS = 5_000

interface OwnedListener {
  event: string
  handler: Listener
}

interface OwnedWaterfall {
  event: string
  handler: WaterfallHandler
}

function createScope(
  parentStore: ServiceStore | null,
  parentScope: InternalScope | null,
  parentEmit: (event: string, payload: unknown) => Promise<void>,
): PluginContext {
  const store: ServiceStore = new Map()
  const listeners = new Map<string, Listener[]>()
  const waterfalls = new Map<string, WaterfallHandler[]>()
  const guards = new Map<string, GuardFn[]>()
  // I3: a scope's own resolved decision per event, written by emitFn only when
  // the local pass actually transformed the payload (see emitFn below).
  const decisions = new Map<string, unknown>()
  const scopes = new Set<PluginContext>()
  const plugins = new Map<string, Plugin>()
  const pluginListeners = new Map<string, OwnedListener[]>()
  const pluginWaterfalls = new Map<string, OwnedWaterfall[]>()
  const nestedPlugins = new Map<string, string[]>()
  let mountingPlugin: string | null = null

  function registerListener(event: string, handler: Listener): void {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
    if (mountingPlugin !== null) {
      const owned = pluginListeners.get(mountingPlugin) ?? []
      owned.push({ event, handler })
      pluginListeners.set(mountingPlugin, owned)
    }
  }

  function registerWaterfall(event: string, handler: WaterfallHandler): void {
    const list = waterfalls.get(event) ?? []
    list.push(handler)
    waterfalls.set(event, list)
    if (mountingPlugin !== null) {
      const owned = pluginWaterfalls.get(mountingPlugin) ?? []
      owned.push({ event, handler })
      pluginWaterfalls.set(mountingPlugin, owned)
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

  // Waterfall dispatch: `ctx.waterfall` registration is EXPLICIT — every
  // waterfall handler always receives a real `next` release function and MUST
  // call it, including the last handler, whose `next()` completes the chain.
  // Forgetting `next` throws (audit F02-1, no silent veto) and calling `next()`
  // twice throws as well. No arity heuristics are involved. The handler list is
  // re-snapshotted per dispatch so mid-dispatch registrations don't affect the
  // current run.
  async function runWaterfall(
    event: string,
    handlers: WaterfallHandler[],
    payload: unknown,
  ): Promise<unknown> {
    const run = async (i: number, p: unknown): Promise<unknown> => {
      if (i >= handlers.length) return p
      let nextCalled = false
      const next = (pp: unknown): unknown | Promise<unknown> => {
        if (nextCalled) {
          throw new Error(`waterfall handler ${i} for '${event}' called next() twice`)
        }
        nextCalled = true
        return run(i + 1, pp)
      }
      const res = handlers[i]!(p, next)
      const resolved = isPromiseLike(res) ? await res : res
      if (!nextCalled) {
        throw new Error(`waterfall handler ${i} for '${event}' forgot next()`)
      }
      return resolved ?? p
    }
    return run(0, payload)
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
  // I3 decision nearest-wins: this scope's resolved payload is recorded as its
  // decision for the event ONLY when the local pass actually transformed the
  // payload (a producer seeded the chain or the waterfall resolved to
  // something different). A raw pass-through is not a decision, so a
  // descendant registry can still read a parent producer's decision via
  // `resolveDecision`, which picks the nearest scope with a recorded decision
  // and otherwise falls back to the emitted payload.
  async function emitFn(event: string, payload: unknown): Promise<void> {
    const plainListeners = [...(listeners.get(event) ?? [])]
    const waterfallHandlers = [...(waterfalls.get(event) ?? [])]
    let chainPayload = payload
    for (const handler of plainListeners) {
      const res = handler(payload)
      const resolved = isPromiseLike(res) ? await res : res
      if (waterfallHandlers.length > 0 && resolved !== undefined) chainPayload = resolved
    }
    let resolvedPayload = chainPayload
    if (waterfallHandlers.length > 0) {
      resolvedPayload = (await runWaterfall(event, waterfallHandlers, chainPayload)) ?? chainPayload
    }
    if (resolvedPayload !== payload) decisions.set(event, resolvedPayload)
    await parentEmit(event, resolvedPayload)
  }

  const ctx: PluginContext & InternalScope = {
    parentScope,
    checkLocalGuards,
    resolveLocalDecision,
    services: {
      register(name: string, impl: unknown): void {
        if (store.has(name)) throw new Error(`duplicate service registration: ${name}`)
        store.set(name, impl)
      },
      get<T>(name: string): T {
        if (store.has(name)) return store.get(name) as T
        if (parentStore?.has(name)) return parentStore.get(name) as T
        throw new Error(`service not found: ${name}`)
      },
    },
    scope: {
      mount(): PluginContext {
        const child = createScope(store, ctx, emitFn)
        scopes.add(child)
        return child
      },
      unmount(): void {
        scopes.delete(ctx)
      },
    },
    on(event: string, handler: Listener): void {
      registerListener(event, handler)
    },
    emit: emitFn,
    waterfall(event: string, handler: WaterfallHandler): void {
      registerWaterfall(event, handler)
    },
    guard(event: string, fn: GuardFn): void {
      const list = guards.get(event) ?? []
      list.push(fn)
      guards.set(event, list)
    },
    // I3 guards union-of-ancestors: consult every scope from this one up to
    // the root. First non-undefined reason wins, so a child deny holds and a
    // child allow (undefined) can never override a parent deny — monotonic.
    checkGuards(event: string, exec: unknown): string | undefined {
      let cur: InternalScope | null = ctx
      while (cur) {
        const reason = cur.checkLocalGuards(event, exec)
        if (reason !== undefined) return reason
        cur = cur.parentScope
      }
      return undefined
    },
    // I3 decision nearest-wins: the nearest scope (self first) with a recorded
    // decision for the event wins; if no scope in the chain made a decision,
    // fall back to the emitted payload.
    resolveDecision(event: string, payload: unknown): unknown {
      let cur: InternalScope | null = ctx
      while (cur) {
        const decision = cur.resolveLocalDecision(event)
        if (decision !== undefined) return decision
        cur = cur.parentScope
      }
      return payload
    },
    mount(plugin: Plugin): void {
      plugins.set(plugin.name, plugin)
      if (mountingPlugin !== null) {
        const nested = nestedPlugins.get(mountingPlugin) ?? []
        nested.push(plugin.name)
        nestedPlugins.set(mountingPlugin, nested)
      }
      const prev = mountingPlugin
      mountingPlugin = plugin.name
      try {
        plugin.mount(ctx)
      } finally {
        mountingPlugin = prev
      }
    },
    unmount(name: string): Promise<void> {
      const pending: Promise<void>[] = []
      reclaim(name, pending)
      return Promise.all(pending).then(() => undefined)
    },
  }

  // Unmount reclamation. Registry deletion, disposer invocation, nested reclaim
  // and listener/waterfall cleanup all run synchronously so a caller that fires
  // `ctx.unmount` and immediately proceeds sees the plugin reclaimed. Only
  // promise-returning disposers are awaited afterwards (with a timeout), via the
  // `pending` list collected during the synchronous pass.
  function reclaim(name: string, pending: Promise<void>[]): void {
    const plugin = plugins.get(name)
    if (!plugin) return
    plugins.delete(name) // remove before recursing so same-name/cycle chains terminate
    const disposer = plugin.unmount?.(ctx)
    if (disposer) pending.push(runDisposer(name, disposer))
    for (const child of nestedPlugins.get(name) ?? []) reclaim(child, pending)
    for (const { event, handler } of pluginListeners.get(name) ?? []) {
      const list = listeners.get(event)
      if (list) {
        const index = list.indexOf(handler)
        if (index !== -1) list.splice(index, 1)
      }
    }
    for (const { event, handler } of pluginWaterfalls.get(name) ?? []) {
      const list = waterfalls.get(event)
      if (list) {
        const index = list.indexOf(handler)
        if (index !== -1) list.splice(index, 1)
      }
    }
    pluginListeners.delete(name)
    pluginWaterfalls.delete(name)
    nestedPlugins.delete(name)
  }

  // Audit F02-4: an unmount disposer may return a Promise. Race it against a 5s
  // timeout so a teardown can never hang forever; on timeout log an error and
  // complete anyway (the plugin is already removed from the registry). The
  // timeout timer is unref'd so a pending disposer never keeps the process alive
  // on its own.
  function runDisposer(name: string, disposer: void | Promise<void>): Promise<void> {
    let timedOut = false
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true
        resolve()
      }, UNMOUNT_TIMEOUT_MS)
      timer.unref?.()
    })
    return Promise.race([Promise.resolve(disposer), timeout]).then(() => {
      if (timedOut) {
        console.error(`[core-plugin] unmount disposer for '${name}' timed out after 5s`)
      }
    })
  }

  return ctx
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  )
}

export function createContext(): PluginContext {
  return createScope(null, null, async () => {})
}

export const corePluginVersion = "0.1.0"
