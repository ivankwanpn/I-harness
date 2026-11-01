import type { WaterfallHandler } from "../types.ts"
import { isPromiseLike } from "./promise.ts"

interface OwnedWaterfall {
  event: string
  handler: WaterfallHandler
}

export function createWaterfalls(getMountingPlugin: () => string | null) {
  const waterfalls = new Map<string, {handler:WaterfallHandler;executionAware:boolean}[]>()
  const revisions=new Map<string,number>()
  const pluginWaterfalls = new Map<string, OwnedWaterfall[]>()

  function registerWaterfall(event: string, handler: WaterfallHandler,executionAware=false): void {
    const list = waterfalls.get(event) ?? []
    list.push({handler,executionAware});revisions.set(event,(revisions.get(event)??0)+1)
    waterfalls.set(event, list)
    const mountingPlugin = getMountingPlugin()
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
    current?:()=>void,
  ): Promise<unknown> {
    const run = async (i: number, p: unknown): Promise<unknown> => {
      current?.()
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

  function reclaim(name: string): void {
    for (const { event, handler } of pluginWaterfalls.get(name) ?? []) {
      const list = waterfalls.get(event)
      if (list) {
        const index = list.findIndex(entry=>entry.handler===handler)
        if (index !== -1) {list.splice(index, 1);revisions.set(event,(revisions.get(event)??0)+1)}
      }
    }
    pluginWaterfalls.delete(name)
  }

  return {
    register: registerWaterfall,
    snapshot: (event: string): WaterfallHandler[] => (waterfalls.get(event) ?? []).map(entry=>entry.handler),
    run: runWaterfall,
    reclaim,
    surface:(event:string)=>({version:revisions.get(event)??0,compatible:(waterfalls.get(event)??[]).every(entry=>entry.executionAware)}),
  }
}
