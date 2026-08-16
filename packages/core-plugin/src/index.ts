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
  mount(plugin: Plugin): void
  unmount(name: string): Promise<void>
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
  parentEmit: (event: string, payload: unknown) => Promise<void>,
): PluginContext {
  const store: ServiceStore = new Map()
  const listeners = new Map<string, Listener[]>()
  const waterfalls = new Map<string, WaterfallHandler[]>()
  const guards = new Map<string, GuardFn[]>()
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

  async function emitFn(event: string, payload: unknown): Promise<void> {
    const waterfallHandlers = [...(waterfalls.get(event) ?? [])]
    if (waterfallHandlers.length > 0) {
      await runWaterfall(event, waterfallHandlers, payload)
    }
    const plainListeners = [...(listeners.get(event) ?? [])]
    for (const handler of plainListeners) {
      const res = handler(payload)
      if (isPromiseLike(res)) await res
    }
    await parentEmit(event, payload)
  }

  const ctx: PluginContext = {
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
        const child = createScope(store, emitFn)
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
    checkGuards(event: string, exec: unknown): string | undefined {
      for (const fn of guards.get(event) ?? []) {
        const reason = fn(exec)
        if (reason !== undefined) return reason // first deny wins; later guards cannot re-allow
      }
      return undefined
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
  return createScope(null, async () => {})
}

export const corePluginVersion = "0.1.0"
