import type { PluginContext } from "@i-harness/core-plugin"
import { append } from "@i-harness/core-session"
import { isPolicyRefusal, ToolArgsError, type Tool, type ToolRegistry } from "@i-harness/core-tools"
import type { CodeModeInvocation, CodeModeMountOptions } from "./types.ts"
import { captureCodeModeTools, codeModeDefinitions } from "./catalog.ts"

interface Cell { tools: Map<string, Tool>; stop: AbortController; seen: Set<string> }
interface Queued {
  call: CodeModeInvocation; tool: Tool; signal: AbortSignal; eventSeq?: number
  resolve(value: unknown): void; reject(error: unknown): void; unsubscribe(): void
  admitted(): void; finished: boolean; recorded: boolean
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const fatal = (e: unknown) => Object.assign(new Error(message(e)), { policyRefusal: true as const })

/** Only dispatch bodies overlap. Captured cell authority survives yields. */
export function createCodeModeBroker(ctx: PluginContext, tools: ToolRegistry, options: CodeModeMountOptions) {
  const cells = new Map<string, Cell>(), queue: Queued[] = [], active = new Set<Queued>(), jobs = new Set<Promise<void>>()
  const stop = new AbortController(), parallel = Math.min(16, Math.max(1, options.maxParallel ?? 4))
  let pumping = false, disposed = false, exclusive = false
  let finalizers: Promise<void> = Promise.resolve()
  function record(item: Queued, output: unknown, error = false) {
    if (item.recorded) return
    item.recorded = true
    append(options.session, { type: "code/result", cellId: item.call.cellId, callId: item.call.invocationId, name: item.call.name, output, ...(error ? { isError: true } : {}) })
  }
  function settle(item: Queued, outcome: { value: unknown } | { error: unknown }) {
    if (item.finished) return
    item.finished = true; item.unsubscribe()
    if ("error" in outcome) item.reject(outcome.error)
    else item.resolve(outcome.value)
  }
  function retireCell(id: string) {
    const cell = cells.get(id)
    cells.delete(id); cell?.stop.abort()
    void pump()
  }
  async function run(item: Queued) {
    try {
      if (item.signal.aborted || !cells.has(item.call.cellId)) throw new Error("Code Mode tool call aborted before dispatch")
      if (tools.get(item.call.name) !== item.tool) throw new Error("Code Mode tool binding changed")
      let prepared
      try {
        prepared = await tools.prepare({ name: item.call.name, args: item.call.args }, item.signal, { sessionId: options.sessionId ?? item.call.origin.sessionId, callId: item.call.invocationId, callEventSeq: item.eventSeq })
      } catch (e) { throw e instanceof ToolArgsError ? e : fatal(e) }
      if (item.signal.aborted || !cells.has(item.call.cellId)) throw new Error("Code Mode tool call aborted before dispatch")
      if (prepared.tool !== item.tool || tools.get(item.call.name) !== item.tool) throw new Error("Code Mode tool binding changed during admission")
      append(options.session, { type: "code/dispatch", cellId: item.call.cellId, callId: item.call.invocationId, ...(item.eventSeq === undefined ? {} : { eventSeq: item.eventSeq }) })
      try { await options.flush?.() } catch (e) { throw fatal(`Code Mode checkpoint failed: ${message(e)}`) }
      if (item.signal.aborted || !cells.has(item.call.cellId)) throw new Error("Code Mode tool call aborted before dispatch")
      if (prepared.tool !== item.tool || tools.get(item.call.name) !== item.tool) throw new Error("Code Mode tool binding changed during checkpoint")
      item.admitted()
      const output = await tools.dispatch(prepared)
      const completion = finalizers.then(async () => {
        let result
        try { result = await tools.finalize(prepared, output) }
        catch (e) { throw fatal(`Code Mode finalization failed: ${message(e)}`) }
        record(item, result.output)
        if (!item.signal.aborted) {
          try { await ctx.emit("agent/post-tool", { name: item.call.name, args: item.call.args, output: result.output, session: options.session }) }
          catch (e) { throw fatal(`Code Mode post-tool hook failed: ${message(e)}`) }
        }
        return result.output
      })
      finalizers = completion.then(() => {}, () => {})
      settle(item, { value: await completion })
    } catch (e) {
      if (isPolicyRefusal(e)) retireCell(item.call.cellId)
      try { record(item, { error: message(e), code: isPolicyRefusal(e) ? "POLICY_REFUSAL" : item.signal.aborted ? "TOOL_ABORTED" : "TOOL_FAILED" }, true) }
      catch (recordError) { settle(item, { error: fatal(`Code Mode result persistence failed: ${message(recordError)}`) }); return }
      settle(item, { error: e })
    } finally {
      item.admitted(); active.delete(item)
      if (!item.tool.isConcurrencySafe) exclusive = false
      void pump()
    }
  }
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length && active.size < parallel && !exclusive) {
        const item = queue[0]!
        if (!item.tool.isConcurrencySafe && active.size) break
        queue.shift(); if (item.finished) continue
        active.add(item); if (!item.tool.isConcurrencySafe) exclusive = true
        const admission = new Promise<void>(resolve => { item.admitted = resolve })
        const job = run(item); jobs.add(job)
        void job.finally(() => { jobs.delete(job); void pump() })
        await admission
      }
    } finally { pumping = false }
  }
  return {
    definitions() { return codeModeDefinitions(captureCodeModeTools(tools)) },
    startCell(id: string) {
      if (disposed || cells.has(id)) throw new Error("Code Mode cell unavailable")
      cells.set(id, { tools: captureCodeModeTools(tools), stop: new AbortController(), seen: new Set() })
    },
    retireCell,
    invoke(call: CodeModeInvocation): Promise<unknown> {
      const cell = cells.get(call.cellId)
      if (disposed || !cell) return Promise.reject(new Error("Code Mode cell unavailable"))
      if (options.sessionId && call.origin.sessionId && options.sessionId !== call.origin.sessionId) return Promise.reject(fatal("Code Mode session owner mismatch"))
      if (cell.seen.has(call.invocationId)) return Promise.reject(new Error("Duplicate Code Mode invocation"))
      cell.seen.add(call.invocationId)
      const tool = cell.tools.get(call.name)
      if (!tool || tool !== tools.get(call.name)) return Promise.reject(new Error("Code Mode tool unavailable or binding changed"))
      if (Buffer.byteLength(JSON.stringify(call.args) ?? "null") > (options.config?.maxResultBytes ?? 4 * 1024 * 1024)) return Promise.reject(new Error("Code Mode tool arguments exceed transfer limit"))
      append(options.session, { type: "code/call", cellId: call.cellId, ...(call.origin.callId ? { parentCallId: call.origin.callId } : {}), callId: call.invocationId, name: call.name, args: call.args })
      const eventSeq = options.session.events.at(-1)?.seq, signal = AbortSignal.any([call.signal, stop.signal, cell.stop.signal])
      return new Promise((resolve, reject) => {
        const item: Queued = { call, tool, signal, eventSeq, resolve, reject, unsubscribe: () => {}, admitted: () => {}, finished: false, recorded: false }
        const abort = () => {
          if (active.has(item) || item.finished) return
          try { record(item, { error: "Code Mode tool call aborted before dispatch", code: "TOOL_ABORTED_BEFORE_DISPATCH" }, true); settle(item, { error: new Error("Code Mode tool call aborted") }) }
          catch (e) { settle(item, { error: fatal(e) }) }
          void pump()
        }
        signal.addEventListener("abort", abort, { once: true }); item.unsubscribe = () => signal.removeEventListener("abort", abort)
        queue.push(item); if (signal.aborted) abort(); void pump()
      })
    },
    async dispose() {
      if (disposed) return
      disposed = true; stop.abort()
      for (const id of cells.keys()) retireCell(id)
      await Promise.allSettled([...jobs]); await options.flush?.()
    },
  }
}
