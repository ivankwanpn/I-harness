import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { FactRecoveryRequiredError, isNondurableSession } from "@i-harness/core-session"
import { userSteerForTool, type Tool, type ToolExec, type ToolRegistry } from "@i-harness/core-tools"
import type { CodeModeExecInput, CodeModeMount, CodeModeMountOptions, CodeModeObservation, CodeModeWaitInput } from "./types.ts"
import { createCodeModeRuntime } from "./runtime.ts"
import { createCodeModeBroker } from "./broker.ts"
import { codeModeDescription } from "./catalog.ts"
import { replayCodeModeStore } from "./state.ts"
import { codeModeFactOwner } from './facts.ts'
import { createCodeModeEventFacts } from './event-facts.ts'

function observationOutput(out: CodeModeObservation) {
  if (out.policyRefusal) throw Object.assign(new Error(out.error || "Code Mode policy refusal"), { policyRefusal: true as const })
  const images = out.items.flatMap(item => item.type === "image" ? [item.image] : [])
  return {
    cellId: out.cellId, cell_id: out.cellId, status: out.status, text: out.text, truncated: out.truncated,
    ...(out.yielded ? { yielded: true as const, yield_reason: out.yieldReason } : {}),
    ...(out.textRetention ? { textRetention: out.textRetention } : {}),
    ...(out.error ? { error: out.error } : {}),
    items: out.items.map(item => item.type === "text" ? { type: "text", length: item.text.length }
      : item.type === "image" ? { type: "image", mediaType: item.image.mediaType, name: item.image.name }
        : { type: "audio", bytes: Math.ceil(item.audioUrl.length * .75) }),
    ...(images.length ? { images } : {}),
  }
}
function retainedObservation(exec: ToolExec, refresh: () => Promise<void>): import('./types.ts').CodeModeObserveOptions['retained'] {
  const retained = exec.retainOutcome?.()
  retained?.beforeRead(refresh)
  return retained && { ...retained, ready: output => retained.ready(observationOutput(output)) }
}

/** Assembly-owned orchestration capability. Nested authority is registry-owned. */
export function registerCodeMode(ctx: PluginContext, tools: ToolRegistry, options: CodeModeMountOptions): CodeModeMount {
  const mode = options.config?.mode ?? "off"
  const factOwner = codeModeFactOwner(options)
  const nondurable = isNondurableSession(options.session)
  if (!["off", "mixed", "only"].includes(mode)) throw new Error("Invalid Code Mode mode")
  const broker = createCodeModeBroker(ctx, tools, options)
  const facts = createCodeModeEventFacts(factOwner, async () => { await runtime.drainRetainedObservations?.(); await runtime.cancel('Code Mode source drained'); await broker.dispose() })
  const refreshObservation = async () => { await facts.refresh(); await runtime.drainRetainedObservations?.() }
  const liveCells = new Set<string>()
  const open = new Map<string, string | undefined>()
  for (const event of options.session.events) if (event.type === "code/cell" && event.sessionId === options.sessionId) {
    if (event.state === "started" || event.state === "running") open.set(event.cellId, event.parentCallId)
    else open.delete(event.cellId)
  }
  const ready = Promise.all([...open].map(([cellId, parentCallId]) => facts.required({ type: "code/cell", cellId, sessionId: options.sessionId, parentCallId, state: "interrupted", error: "Code Mode execution was interrupted; restart does not restore its continuation" }))).then(() => {})
  void ready.catch(() => {})
  const runtime = createCodeModeRuntime({
    config: options.config,
    ...(options.spillStore ? { spillStore: options.spillStore } : {}),
    ...(options.retainText ? { retainText: input => options.retainText!({ ...input, captureReference: ref => facts.captureReference(ref), retentionRecovery: () => facts.requireRecovery() }) } : {}),
    ...(!nondurable ? { retentionRecovery: () => facts.requireRecovery() } : {}),
    tools: () => broker.definitions(),
    invoke: call => broker.invoke(call),
    restoreStore: origin => replayCodeModeStore(options.session, options.sessionId ?? origin.sessionId),
    async commitStore({ cellId, origin, writes, signal, committed, cancelled, retainOutcome }) {
      if (signal.aborted) throw new Error("Code Mode store commit aborted")
      if (!nondurable) retainOutcome?.()
      await facts.store({ type: "code/store", version: 1, cellId, sessionId: options.sessionId ?? origin.sessionId, writes }, () => { if (!nondurable) committed?.() }, () => cancelled?.())
      if (nondurable) { await options.flush?.(); if (signal.aborted) throw new Error('Code Mode store commit aborted'); committed?.() }
    },
    async onEvent(event) {
      if (event.type === "started") {
        try {
          await facts.optional({ type: "code/cell", cellId: event.cellId, sessionId: options.sessionId ?? event.origin.sessionId, parentCallId: event.origin.callId, state: "started", source: event.source }, event.origin.abortSignal)
          broker.startCell(event.cellId); liveCells.add(event.cellId)
        } catch (error) {
          await facts.required({ type: 'code/cell', cellId: event.cellId, sessionId: options.sessionId ?? event.origin.sessionId, parentCallId: event.origin.callId, state: 'interrupted', error: 'Code Mode admission did not complete' })
          throw error
        }
      } else if (event.type === "output") {
        if (!nondurable) event.retainOutcome?.()
        await facts.required({ type: "code/output", cellId: event.cellId, content: event.item }, event.committed)
      }
      else {
        const committed = () => { liveCells.delete(event.cellId); broker.retireCell(event.cellId); event.committed?.() }
        if (!nondurable) event.retainOutcome?.()
        await facts.required({ type: "code/cell", cellId: event.cellId, sessionId: options.sessionId ?? event.origin.sessionId, parentCallId: event.origin.callId, state: event.status, ...(event.error ? { error: event.error } : {}) }, () => {
          if (!nondurable) committed()
        })
        if (nondurable) { if (event.status === 'completed') await options.flush?.(); committed() }
      }
    },
  })
  let disposed = false, closed = false, disposing: Promise<void> | undefined
  const execTool: Tool = {
    name: "code_exec", description: "Execute isolated JavaScript to compose the session's tools.", isReadOnly: true,
    inputSchema: { type: "object", properties: { code: { type: "string" }, yield_time_ms: { type: "integer", minimum: 0, maximum: 60_000 }, max_output_tokens: { type: "integer", minimum: 0, maximum: 4096 } }, required: ["code"], additionalProperties: false },
    async execute(args, exec) {
      if (disposed || mode === "off") throw new Error("Code Mode unavailable")
      const retained = retainedObservation(exec, refreshObservation)
      await ready
      const out = await runtime.exec(args as CodeModeExecInput, { ...exec, sessionId: options.sessionId ?? exec.sessionId, callId: exec.callId ?? randomUUID() }, { userSteer: userSteerForTool(exec), retained })
      return observationOutput(out)
    },
  }
  const waitTool: Tool = {
    name: "code_wait", description: "Read new output from a running code_exec cell. Use its cell_id; terminate=true stops it. One observer at a time. Saved cells from a previous process cannot be resumed.", isReadOnly: true,
    inputSchema: { type: "object", properties: { cell_id: { type: "string" }, yield_time_ms: { type: "integer", minimum: 0, maximum: 60_000 }, max_tokens: { type: "integer", minimum: 0, maximum: 4096 }, terminate: { type: "boolean" } }, required: ["cell_id"], additionalProperties: false },
    async execute(args, exec) {
      if (disposed || mode === "off") throw new Error("Code Mode unavailable")
      const retained = retainedObservation(exec, refreshObservation)
      await ready
      return observationOutput(await runtime.wait(args as CodeModeWaitInput, exec.abortSignal, { userSteer: userSteerForTool(exec), retained }))
    },
  }
  const statusTool: Tool = {
    name: "code_status", description: "List live code_exec cells owned by this session with their cell IDs and running status. Use code_wait to read new output or terminate a cell. Previous-process continuations are unavailable.", isReadOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      if (disposed || mode === "off") throw new Error("Code Mode unavailable")
      await ready
      return { cells: [...liveCells].map(id => ({ id, status: "running" as const })) }
    },
  }
  if (mode !== "off") {
    if (tools.get("code_exec") || tools.get("code_wait") || tools.get("code_status")) throw new Error("Code Mode tool names are already registered")
    tools.register(execTool); tools.register(waitTool); tools.register(statusTool)
  }
  return {
    ready: () => ready,
    schemas() {
      if (disposed || mode === "off") return tools.schemas()
      const execDescription = codeModeDescription(tools, mode)
      const all = tools.schemas().map(schema => schema.name === "code_exec" ? { ...schema, description: execDescription } : schema)
      return mode === "only" ? all.filter(s => s.name === "code_exec" || s.name === "code_wait" || s.name === "code_status") : all
    },
    liveCells: () => { facts.assertObserved(); return [...liveCells].map(id => ({ id, status: "running" as const })) },
    async terminateCell(cellId) {
      if (disposed || !liveCells.has(cellId)) throw new Error("Live cell unavailable for this owner")
      await runtime.terminate(cellId, "Cell stopped by user")
      await options.flush?.()
    },
    async cancel(reason) { facts.stopOptional(); await runtime.cancel(reason) },
    async dispose() {
      if (closed) return
      if (disposing) return disposing
      disposed = true
      facts.stopOptional()
      const pending = (async () => {
        const errors: unknown[] = []
        try { await runtime.cancel('Code Mode disposed') } catch (error) { errors.push(error) }
        try { await broker.dispose() } catch (error) { errors.push(error) }
        try { await facts.close() } catch (error) { errors.push(error) }
        if (errors.length) throw Object.assign(new FactRecoveryRequiredError(), { cause: new AggregateError(errors) })
        await runtime.dispose()
        if (tools.get("code_exec") === execTool) tools.unregister("code_exec")
        if (tools.get("code_wait") === waitTool) tools.unregister("code_wait")
        if (tools.get("code_status") === statusTool) tools.unregister("code_status")
        closed = true
      })()
      disposing = pending
      void pending.catch(() => { if (disposing === pending) disposing = undefined })
      return pending
    },
  }
}
