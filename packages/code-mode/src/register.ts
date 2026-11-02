import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { FactRecoveryRequiredError, isNondurableSession } from "@i-harness/core-session"
import { declareToolResultOutcome, declareInstructionReplan, retainInstructionCell, backgroundEventForTool, userSteerForTool, type Tool, type ToolExec, type ToolRegistry } from "@i-harness/core-tools"
import type { CodeModeExecInput, CodeModeMount, CodeModeMountOptions, CodeModeWaitInput } from "./types.ts"
import { createCodeModeRuntime } from "./runtime.ts"
import { createCodeModeBroker } from "./broker.ts"
import { codeModeDescription } from "./catalog.ts"
import { replayCodeModeStore } from "./state.ts"
import { codeModeFactOwner } from './facts.ts'
import { createCodeModeEventFacts } from './event-facts.ts'
import { createCodeOutputPublisher } from './output-facts.ts'
import { observationOutput } from './observation-output.ts'
import { originalObservationReplan } from './runtime/replan-observation.ts'
import { captureOriginalCellFinalization, createCellFinalizations, readOriginalWorkerAcquisition, type OriginalCellFinalization } from './finalization.ts'
import { createFinalCodeOutputs } from './final-output.ts'

type CompletionObservation = {kind:'unqualified'|'qualified';cellId:string;worker:'unknown'|'not-acquired'|'acquired';eligible:boolean;evidence?:object}
type CompletionHandle = Readonly<{settle():Promise<CompletionObservation>}>
const completionMounts=new WeakMap<object,Map<string,CompletionHandle>>()
export function captureOriginalCodeCompletion(mount:object,cellId:string):CompletionHandle {
  const handle=completionMounts.get(mount)?.get(cellId)
  if(!handle)throw new Error('Original Code completion unavailable')
  return handle
}

function declareObservationReplan(exec: ToolExec, out: import('./types.ts').CodeModeObservation) {
  const error = originalObservationReplan(out)
  if (error) { declareInstructionReplan(exec, error); declareToolResultOutcome(exec, 'failed') }
}

function retainedObservation(exec: ToolExec, refresh: () => Promise<void>): import('./types.ts').CodeModeObserveOptions['retained'] {
  const retained = exec.retainOutcome?.()
  retained?.beforeRead(refresh)
  return retained && { ...retained, ready: output => { declareObservationReplan(exec, output); retained.ready(observationOutput(output)) } }
}

/** Assembly-owned orchestration capability. Nested authority is registry-owned. */
export function registerCodeMode(ctx: PluginContext, tools: ToolRegistry, options: CodeModeMountOptions): CodeModeMount {
  const mode = options.config?.mode ?? "off"
  const factOwner = codeModeFactOwner(options)
  const nondurable = isNondurableSession(options.session)
  if (!["off", "mixed", "only"].includes(mode)) throw new Error("Invalid Code Mode mode")
  let disposed = false, closed = false, disposing: Promise<void> | undefined
  let initialized = false, localTransitions = 0, installationFailed = false
  const surfaceListeners = new Set<() => void>()
  const surfaceChanged = () => { for (const listener of [...surfaceListeners]) { try { listener() } catch { /* Isolate consumers from publication. */ } } }
  const broker = createCodeModeBroker(ctx, tools, options, (cellId, detail) => runtime.replan(cellId, detail))
  const finalizations = createCellFinalizations('cell-finalization',factOwner)
  const completionHandles=new Map<string,CompletionHandle>()
  const originalCells = new Map<string, { terminal: ReturnType<typeof Promise.withResolvers<void>>; fence: ReturnType<typeof Promise.withResolvers<void>>; broker?: Pick<OriginalCellFinalization, 'settle'> }>()
  const finalOutputFactory=options.finalOutput
  const finalOutputs = createFinalCodeOutputs(factOwner, finalOutputFactory, () => facts.refresh(), id=>{completionHandles.delete(id)})
  const facts = createCodeModeEventFacts(factOwner, async () => { await runtime.drainRetainedObservations?.(); await runtime.cancel('Code Mode source drained'); await broker.dispose() }, surfaceChanged, finalOutputFactory ? {retains:cellId=>finalOutputs.retains(cellId),commit:record=>finalOutputs.commit(record)} : undefined)
  const publishOutput = createCodeOutputPublisher(facts, options.retainText)
  const pendingFinishes = new Map<string, () => Promise<void>>()
  const admissionDebts = new Map<string, () => Promise<void>>()
  const refreshObservation = async () => { await facts.refresh(); for (const settle of admissionDebts.values()) await settle(); for (const finish of pendingFinishes.values()) await finish(); await runtime.drainRetainedObservations?.() }
  const liveCells = new Set<string>()
  const open = new Map<string, string | undefined>()
  for (const event of options.session.events) if (event.type === "code/cell" && event.sessionId === options.sessionId) {
    if (event.state === "started" || event.state === "running") open.set(event.cellId, event.parentCallId)
    else open.delete(event.cellId)
  }
  const ready = Promise.all([...open].map(([cellId, parentCallId]) => facts.required({ type: "code/cell", cellId, sessionId: options.sessionId, parentCallId, state: "interrupted", error: "Code Mode execution was interrupted; restart does not restore its continuation" }))).then(() => { initialized = true; surfaceChanged() })
  void ready.catch(() => {})
  const runtime = createCodeModeRuntime({
    config: options.config,
    ...(options.retainText ? { retainText: input => options.retainText!({ ...input, assertHeld: facts.assertHeld, retentionRecovery: () => facts.requireRecovery() }) } : {}),
    ...(!nondurable ? { retentionRecovery: () => facts.requireRecovery() } : {}),
    tools: () => broker.definitions(),
    invoke: call => broker.invoke(call),
    drainInstructionCell: cellId => broker.drainCell(cellId),
    restoreStore: origin => replayCodeModeStore(options.session, options.sessionId ?? origin.sessionId),
    async commitStore({ cellId, origin, writes, signal, committed, cancelled, retainOutcome }) {
      localTransitions++; surfaceChanged()
      try {
        if (signal.aborted) throw new Error("Code Mode store commit aborted")
        if (!nondurable) retainOutcome?.()
        await facts.store({ type: "code/store", version: 1, cellId, sessionId: options.sessionId ?? origin.sessionId, writes }, () => { if (!nondurable) committed?.() }, () => cancelled?.())
        if (nondurable) {
          try { await options.flush?.(); if (signal.aborted) throw new Error('Code Mode store commit aborted'); committed?.() }
          catch (error) { installationFailed = true; throw error }
        }
      } finally { localTransitions--; surfaceChanged() }
    },
    async onEvent(event) {
      // Admission remains unavailable through the entire handler, including
      // the gap between the optional receipt and actual broker installation.
      localTransitions++; surfaceChanged()
      try {
        if (event.type === "started") {
          const terminal = Promise.withResolvers<void>()
          const fence = Promise.withResolvers<void>()
          void fence.promise.catch(() => {})
          const cell: { terminal: typeof terminal; fence: typeof fence; broker?: Pick<OriginalCellFinalization, 'settle'> } = { terminal, fence }
          originalCells.set(event.cellId, cell)
          const runtimeOwner = captureOriginalCellFinalization(runtime, event.cellId)
          const finalization = finalizations.reserve(event.cellId, async () => {
            await terminal.promise
            await fence.promise
            await runtimeOwner.settle()
            await cell.broker?.settle()
            if (originalCells.get(event.cellId) === cell) originalCells.delete(event.cellId)
          })
          void terminal.promise.then(() => finalization.settle()).catch(() => {})
          const outputReady=Promise.withResolvers<NonNullable<ReturnType<typeof finalOutputs.captureCompletion>>>()
          void outputReady.promise.catch(()=>{})
          try {
            if(finalOutputFactory && (options.sessionId ?? event.origin.sessionId) && !event.origin.instructionOrigin && !nondurable && options.session.formatVersion===14) {
              let settled:CompletionObservation|undefined
              const handle:CompletionHandle=Object.freeze({async settle(){
                if(this!==handle)throw new Error('Original Code completion handle required')
                if(settled)return settled
                const output=await outputReady.promise
                await output.settle()
                if(settled)return settled
                const evidence=output.evidence(),worker=readOriginalWorkerAcquisition(runtimeOwner)
                const eligible=!!evidence && worker==='acquired' && (evidence.footer.status==='completed'||evidence.footer.status==='failed') && !evidence.footer.truncated && !evidence.footer.omitted && evidence.unavailableTextCount===0 && evidence.ref.completeness==='complete'
                settled=Object.freeze({kind:evidence?'qualified':'unqualified',cellId:event.cellId,worker,eligible,...(evidence?{evidence}:{})})
                if(completionHandles.get(event.cellId)===handle)completionHandles.delete(event.cellId)
                return settled
              }})
              completionHandles.set(event.cellId,handle)
            }
            finalOutputs.reserve(event.cellId, options.sessionId ?? event.origin.sessionId, finalization, runtimeOwner, !!event.origin.instructionOrigin)
            const output=finalOutputs.captureCompletion(event.cellId)
            if(output)outputReady.resolve(output)
            else outputReady.reject(new Error('Original Code output unavailable'))
            await facts.optional({ type: "code/cell", cellId: event.cellId, sessionId: options.sessionId ?? event.origin.sessionId, parentCallId: event.origin.callId, state: "started", source: event.source }, event.origin.abortSignal)
            try { cell.broker = broker.startCell(event.cellId, event.origin.instructionOrigin); liveCells.add(event.cellId); event.instructionInstalled?.() }
            catch (error) { installationFailed = true; throw error }
            surfaceChanged()
          } catch (error) {
            outputReady.reject(error)
            const terminal = { type: 'code/cell' as const, cellId: event.cellId, sessionId: options.sessionId ?? event.origin.sessionId, parentCallId: event.origin.callId, state: 'interrupted' as const, error: 'Code Mode admission did not complete' }
            let terminalDone = false, flight: Promise<void> | undefined
            const settle = () => {
              if (flight) return flight
              const pending = (async () => { if (!terminalDone) { await facts.required(terminal, undefined, () => cell.terminal.resolve()); terminalDone = true }; await event.instructionAdmissionFailed?.(); cell.fence.resolve(); admissionDebts.delete(event.cellId) })()
              flight = pending; void pending.catch(() => { if (flight === pending) flight = undefined }); return pending
            }
            admissionDebts.set(event.cellId, settle)
            await settle()
            throw error
          }
        } else if (event.type === "output") {
          if (!nondurable) event.retainOutcome?.()
          await publishOutput(event)
        }
        else {
          let receiptCommitted = false
          let finishFlight: Promise<void> | undefined
          const needsFinish = !!event.instructionReplan || !!event.origin.instructionOrigin
          const finish = () => {
            if (finishFlight) return finishFlight
            const pending = (async () => {
              if (!receiptCommitted) throw new FactRecoveryRequiredError()
              try { if (event.instructionReplan) await broker.finishReplannedCell(event.cellId); else await broker.finishRetiredCell(event.cellId) }
              catch (cause) { throw Object.assign(new FactRecoveryRequiredError(), { cause }) }
              pendingFinishes.delete(event.cellId); event.committed?.(); surfaceChanged()
            })()
            finishFlight = pending; void pending.catch(() => { if (finishFlight === pending) finishFlight = undefined }); return pending
          }
          if (needsFinish) pendingFinishes.set(event.cellId, finish)
          const committed = () => {
            liveCells.delete(event.cellId)
            receiptCommitted = true
            if (needsFinish) event.retainOutcome?.()
            if (!event.instructionReplan) broker.retireCell(event.cellId)
            if (needsFinish) void finish().catch(() => {})
            else event.committed?.()
            surfaceChanged()
          }
          if (!nondurable) event.retainOutcome?.()
          await facts.required({ type: "code/cell", cellId: event.cellId, sessionId: options.sessionId ?? event.origin.sessionId, parentCallId: event.origin.callId, state: event.status, ...(event.error ? { error: event.error } : {}), ...(event.instructionReplan ? { instructionReplan: event.instructionReplan } : {}) }, () => {
            if (!nondurable) committed()
          }, () => { const cell = originalCells.get(event.cellId); cell?.terminal.resolve(); if (!nondurable) cell?.fence.resolve() })
          if (nondurable) {
            try { if (event.status === 'completed') await options.flush?.(); committed(); originalCells.get(event.cellId)?.fence.resolve() }
            catch (error) { originalCells.get(event.cellId)?.fence.reject(error); installationFailed = true; throw error }
          }
          if (needsFinish) {
            await finish()
          }
        }
      } finally { localTransitions--; surfaceChanged() }
    },
  })
  const execTool: Tool = {
    name: "code_exec", description: "Execute isolated JavaScript to compose the session's tools.", isReadOnly: true,
    inputSchema: { type: "object", properties: { code: { type: "string" }, yield_time_ms: { type: "integer", minimum: 0, maximum: 60_000 }, max_output_tokens: { type: "integer", minimum: 0, maximum: 4096 } }, required: ["code"], additionalProperties: false },
    async execute(args, exec) {
      if (disposed || mode === "off") throw new Error("Code Mode unavailable")
      const retained = retainedObservation(exec, refreshObservation)
      await ready
      const out = await runtime.exec(args as CodeModeExecInput, { sessionId: options.sessionId ?? exec.sessionId, callId: exec.callId ?? randomUUID(), callEventSeq: exec.callEventSeq, abortSignal: exec.abortSignal, generationLineage: exec.modelGeneration?.codeLineage, bindInstructionCell: cellId => retainInstructionCell(exec, cellId) }, { userSteer: userSteerForTool(exec), backgroundEvent: backgroundEventForTool(exec), retained })
      declareObservationReplan(exec, out)
      declareToolResultOutcome(exec, out.status === 'failed' ? 'failed' : out.status === 'terminated' ? 'canceled' : 'succeeded')
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
      const out = await runtime.wait(args as CodeModeWaitInput, exec.abortSignal, { userSteer: userSteerForTool(exec), backgroundEvent: backgroundEventForTool(exec), retained })
      declareObservationReplan(exec, out)
      return observationOutput(out)
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
  const mount: CodeModeMount = {
    ready: () => ready,
    onSurfaceChanged(listener) { surfaceListeners.add(listener); return () => { surfaceListeners.delete(listener) } },
    surfaceState: () => disposed ? 'retired' : !initialized || localTransitions || installationFailed ? 'unavailable' : facts.observationState(),
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
      if (!disposed) { disposed = true; surfaceChanged() }
      facts.stopOptional()
      const pending = (async () => {
        const errors: unknown[] = []
        try { await runtime.cancel('Code Mode disposed') } catch (error) { errors.push(error) }
        let brokerFailure: unknown, brokerFailed = false
        try { await broker.dispose() } catch (error) { brokerFailure = error; brokerFailed = true }
        try { await facts.refresh() } catch (error) { errors.push(error) }
        for (const settle of admissionDebts.values()) try { await settle() } catch (error) { errors.push(error) }
        for (const finish of pendingFinishes.values()) try { await finish() } catch (error) { errors.push(error) }
        if (brokerFailed) try { await broker.dispose() } catch (error) { errors.push(error === brokerFailure ? error : new AggregateError([brokerFailure, error], 'Original broker cleanup failed')) }
        try { await facts.close() } catch (error) { errors.push(error) }
        try { await finalizations.drain() } catch (error) { errors.push(error) }
        try { await finalOutputs.drain() } catch (error) { errors.push(error) }
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
  finalizations.bind(mount)
  finalOutputs.bind(mount)
  completionMounts.set(mount,completionHandles)
  return mount
}
