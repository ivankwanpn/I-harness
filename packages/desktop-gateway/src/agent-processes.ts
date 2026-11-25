import { savedTerminals } from './saved-terminals.ts'
import { createFixedFactSelection, createFixedTerminalSelections, savedCallEvidence } from './saved-fact-selection.ts'
import { buildSavedProcessIndex, createFixedSavedSelections, type SavedCall, type NativeIdentity, type SavedProcessSelector } from './saved-process-index.ts'
import { hydrateSavedCandidate, hydrateSavedInlineCatalog } from './saved-result-json.ts'
import { readSavedProcessFrame, readSavedProcessPreview } from './saved-process-output.ts'
import type { AgentProcessReadRunner, AgentProcessReadContext } from './agent-process-read.ts'
import { originalManagedExecutionFor } from '../../session-executor/src/host-managed-execution.ts'
import { sameManagedArtifactRef, validManagedArtifactRef, type ExecFrameCursor, type ManagedArtifactRef } from '@i-harness/core-session'
import { randomUUID } from "node:crypto"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import type { TerminalView } from "@i-harness/terminal"
import { foldJobs, projectJobsDoc, type JobView } from "@i-harness/jobs"
import { boundedInteger, resourceId, readDesktopSnapshot } from "./execution.ts"

export type AgentProcessCommand =
  | { action: "read"; id: string; offset?: number }
  | { action: "send"; id: string; data: string }
  | { action: "resize"; id: string; cols: number; rows: number }
  | { action: "signal"; id: string; signal: "INT" | "TERM" | "KILL" }
  | { action: "close"; id: string }
  | { action: "job/cancel"; id: string; backend?: "shell" | "child" | "workflow"; instanceId?: string; sourceId?: string }
export interface AgentProcessesView {
  sessionId: string; live: boolean
  terminals: (Omit<TerminalView, "pid" | "command" | "cols" | "rows" | "beganAt"> & { pid?: number; command?: string; cols?: number; rows?: number; beganAt?: string; live: boolean; canControl: boolean; outputAvailable?: boolean; outputReason?: string })[]
  jobs: (JobView & { ownerSessionId: string; live: boolean; canCancel: boolean; backend?: "shell" | "child" | "workflow"; nativeJob?: NativeIdentity; declaration?: Pick<SavedCall, "surface" | "cellId" | "callId" | "callIndex" | "resultIndex" | "callSeq" | "resultSeq">; outputDisposition?: "saved-preview" | "retained-unverified" | "unavailable" | "conflict" })[]
}
export type AgentProcessesRequest =
  | { kind: "desktop/session/processes/read"; workspaceId: string; sessionId: string }
  | { kind: "desktop/session/processes/control"; workspaceId: string; sessionId: string; command: AgentProcessCommand }
  | ({ kind: "desktop/session/processes/job-output"; workspaceId: string; sessionId: string; id: string } & JobOutputQuery)
  | { kind: "desktop/session/processes/terminal-output"; workspaceId: string; sessionId: string; id: string }

/** Settled jobs use the original terminal fact. Older launch-only rows
 * remain historical and do not attest to a live process. */
function savedShellJobs(index: ReturnType<typeof buildSavedProcessIndex>) {
  return index.candidates.map(candidate => {
    const value = candidate.snapshot as Record<string, any> | undefined, args = candidate.declaration.args as Record<string, unknown>
    return { startedAt: undefined, endedAt: undefined, jobId: candidate.id, kind: 'shell', label: typeof args.command === 'string' ? args.command.slice(0, 256) : candidate.id,
      status: candidate.terminal?.status ?? (['running', 'completed', 'killed', 'error'].includes(value?.status) ? value!.status : 'running'),
      outputAvailable: !candidate.conflict && (typeof value?.text === 'string' && !!value.text || !candidate.nativeJob && (typeof value?.stdout === 'string' && !!value.stdout || typeof value?.stderr === 'string' && !!value.stderr) || !!candidate.descriptor || !!candidate.terminal?.ref),
      nativeJob: candidate.nativeJob, declaration: candidate.declaration, conflict: candidate.conflict,
      outputDisposition: candidate.conflict ? "conflict" as const : candidate.snapshot ? "saved-preview" as const : candidate.descriptor || candidate.terminal?.ref ? "retained-unverified" as const : "unavailable" as const }
  })
}
export interface JobOutputQuery { backend?: 'shell' | 'child' | 'workflow'; instanceId?: string; sourceId?: string; mode?: 'snapshot' | 'frames'; cursor?: ExecFrameCursor; expectedRef?: ManagedArtifactRef }
export function createAgentProcesses(coordinator: SessionCoordinator, service: SessionService, options: { runRead?: AgentProcessReadRunner } = {}) {
  const unavailable = (code = 'unavailable'): never => { throw Object.assign(new Error('Job output unavailable for this owner'), { code }) }
  const runRead: AgentProcessReadRunner = options.runRead ?? (async (id, work) => {
    const { meta } = await coordinator.profile(id)
    if (meta.archived) throw new Error('Conversation unavailable')
    const assembly = service.liveAssembly(id), session = assembly?.session ?? await readDesktopSnapshot(coordinator, id)
    const index = buildSavedProcessIndex(session.events, id, session.formatVersion)
    const checks: { selectors: readonly SavedProcessSelector[]; cursor: number; selected: ReturnType<typeof createFixedSavedSelections>; facts: ReturnType<typeof createFixedFactSelection> }[] = []
    const terminals: ReturnType<typeof createFixedTerminalSelections>[] = []
    const document = await coordinator.getDocument(id)
    const original = () => { if (service.liveAssembly(id) !== assembly) throw new Error('Process owner changed') }
    async function revalidate() {
      original(); const fresh = await readDesktopSnapshot(coordinator, id, original); original()
      const current = checks.length ? buildSavedProcessIndex(fresh.events, id, fresh.formatVersion) : undefined
      for (const check of checks) {
        check.facts.revalidate(fresh)
        if (fresh.events.length > check.cursor) { check.selected.append(check.cursor, fresh.events.slice(check.cursor)); check.cursor = fresh.events.length }
        if (check.selectors.some(selector => current!.select(selector.id, selector.instanceId).kind !== 'selected')) throw new Error('Saved job selection changed')
        check.selected.assertCurrent()
      }
      for (const terminal of terminals) terminal.revalidate(fresh)
    }
    const context: AgentProcessReadContext = { index, session, document,
      selectJobs(selectors) {
        if (!selectors.length) return
        const addresses = selectors.map(selector => ({ ...selector }))
        const selected = createFixedSavedSelections({ session, highWater: session.events.length }, id, addresses, index)
        const fixed = addresses.map((_selector, ordinal) => selected.current(ordinal))
        const evidence = savedCallEvidence(session, fixed.flatMap(job => [job.declaration, job.observation, job.sourceObservation]))
        const terminalSequences = new Set(fixed.flatMap(job => job.terminal ? [job.terminal.sourceSeq, job.terminal.terminalSeq] : []))
        if (terminalSequences.size) {
          for (const [index, event] of session.events.entries()) {
            if (event.seq !== undefined && terminalSequences.delete(event.seq)) evidence.push({ index, event })
          }
          if (terminalSequences.size) throw new Error('Saved process terminal unavailable')
        }
        checks.push({ selectors: addresses, cursor: session.events.length, selected, facts: createFixedFactSelection(session, evidence, id) })
      },
      selectTerminals(selectors) {
        if (selectors.length) terminals.push(createFixedTerminalSelections(session, selectors, id))
      },
      assertCurrent() { original(); for (const check of checks) { check.selected.assertCurrent(); check.facts.assertCurrent() }; for (const terminal of terminals) terminal.assertCurrent() },
      async checkpoint() { await revalidate(); if ((await coordinator.profile(id)).meta.archived) throw new Error('Conversation unavailable'); original(); await revalidate(); context.assertCurrent() },
      async page() { throw new Error('Host process reader unavailable') } }
    const result = await work(context); await context.checkpoint(); return result
  })
  const jobOutputImpl = async (sessionId: string, id: string, input: JobOutputQuery = {}) => {
    const frames = input?.mode === 'frames'
    try {
      resourceId(sessionId); resourceId(id)
      const query = structuredClone(input)
      if (Object.keys(query).some(k => !['backend', 'instanceId', 'sourceId', 'mode', 'cursor', 'expectedRef'].includes(k)) || query.backend !== undefined && !['shell', 'child', 'workflow'].includes(query.backend)
        || query.mode !== undefined && !['snapshot', 'frames'].includes(query.mode)) return unavailable('invalid-selector')
      if (query.instanceId !== undefined) resourceId(query.instanceId)
      if (query.sourceId !== undefined) resourceId(query.sourceId)
      if (query.cursor !== undefined && (!query.cursor || typeof query.cursor !== 'object' || Array.isArray(query.cursor) || Object.keys(query.cursor).length !== 2 || query.cursor.recordOffset === 0 && query.cursor.sliceOffset !== 0 || !Number.isSafeInteger(query.cursor.recordOffset) || query.cursor.recordOffset < 0 || !Number.isSafeInteger(query.cursor.sliceOffset) || query.cursor.sliceOffset < 0 || Object.keys(query.cursor).some(k => !['recordOffset', 'sliceOffset'].includes(k)))
        || frames && (query.backend !== 'shell' || !query.instanceId) || !frames && (query.cursor !== undefined || query.expectedRef !== undefined)
        || query.cursor !== undefined && !query.expectedRef || query.expectedRef !== undefined && (!validManagedArtifactRef(query.expectedRef) || query.expectedRef.codec !== 'exec-frames-v1')) return unavailable('invalid-selector')
      if (query.sourceId !== undefined && !query.instanceId || query.backend !== undefined && query.backend !== 'shell' && (query.instanceId || query.sourceId)) return unavailable('invalid-selector')
      return await runRead(sessionId, async context => {
        const index = context.index, chosen = index.select(id, query.instanceId)
        const doc = context.document as { jobs?: { id: string; output?: string }[] } | undefined
        const child = doc?.jobs?.find(job => job.id === id)
        const assembly = service.liveAssembly(sessionId), managed = context.managedProcesses?.()
        const background = (assembly?.backgroundJobs?.() ?? managed?.background ?? []).filter(job => job.id === id && job.ownerSessionId === sessionId)
        const shellQuery = query.backend === undefined || query.backend === 'shell'
        if (shellQuery && (chosen.kind === 'ambiguous-selector' || chosen.kind === 'conflict')) return unavailable(chosen.kind)
        if (chosen.kind === 'selected' && child && !query.backend && !query.instanceId) return unavailable('ambiguous-selector')
        if (chosen.kind === 'selected' && shellQuery) {
          const candidate = chosen.candidate
          if (query.sourceId !== undefined && candidate.nativeJob?.sourceId !== query.sourceId) return unavailable('stale-source')
          if (!query.instanceId && candidate.nativeJob
            && background.some(row => row.kind === 'shell' && row.nativeJob && row.nativeJob.instanceId !== candidate.nativeJob?.instanceId)) return unavailable('ambiguous-selector')
          context.selectJobs([{ id, instanceId: query.instanceId }])
          const active = background.find(row => row.kind === 'shell' && (!candidate.nativeJob || row.nativeJob?.instanceId === candidate.nativeJob.instanceId))
          if (active && candidate.nativeJob && active.nativeJob?.sourceId !== candidate.nativeJob.sourceId) return unavailable('stale-source')
          if (active && !frames) return { text: active.output.slice(0, 131072), truncated: active.outputTruncated || active.output.length > 131072, ownerSessionId: sessionId, live: true }
          const terminalRef = candidate.terminal?.ref
          if (terminalRef && candidate.nativeJob && (frames || !candidate.snapshot)) {
            if (!options.runRead) return unavailable('retained-reader-unavailable')
            if (query.expectedRef && !sameManagedArtifactRef(query.expectedRef, terminalRef)) return unavailable('stale-ref')
            if (!frames) {
              const preview = await readSavedProcessPreview(context, terminalRef)
              if ('kind' in preview) return unavailable(preview.reason)
              return { ...preview, ownerSessionId: sessionId, live: false }
            }
            const page = await readSavedProcessFrame(context, terminalRef, query.cursor)
            if ('kind' in page) return page
            return { kind: 'frames' as const, ownerSessionId: sessionId, live: Boolean(active), backend: 'shell' as const, nativeJob: candidate.nativeJob, page, sourceCompleteness: terminalRef.completeness, scope: 'captured' as const }
          }
          let value = (candidate.snapshot ?? (frames ? candidate.sourceObservation?.value : undefined)) as Record<string, any> | undefined
          let catalogCompleteness = candidate.descriptor?.catalog?.completeness
          if (candidate.descriptor && (!value || frames)) {
            if (!options.runRead) return unavailable('retained-reader-unavailable')
            const hydrated = await hydrateSavedCandidate(sessionId, candidate, (_id, q) => context.page(q), context.assertCurrent)
            value = hydrated.value; catalogCompleteness = hydrated.catalogCompleteness
          }
          if (!frames) {
            if (!value) return unavailable('snapshot-unavailable')
            const text = typeof value.text === 'string' ? value.text : !candidate.nativeJob ? (typeof value.stdout === 'string' ? value.stdout : '') + (typeof value.stderr === 'string' ? value.stderr : '') : undefined
            if (text === undefined) return unavailable('snapshot-unavailable')
            return { text: text.slice(0, 131072), truncated: value.truncated === true || text.length > 131072, ownerSessionId: sessionId, live: false }
          }
          if (!options.runRead || !candidate.nativeJob) return unavailable('retained-reader-unavailable')
          let catalog = candidate.observation?.descriptor?.catalog ?? candidate.observation?.catalog ?? candidate.sourceObservation?.catalog
          if (!candidate.descriptor) {
            const inline = await hydrateSavedInlineCatalog(sessionId, candidate, (_id, q) => context.page(q), context.assertCurrent)
            value = inline.value; catalog = inline.catalog; catalogCompleteness = inline.catalogCompleteness
          }
          const original = value?.full_result?.args?.ref as ManagedArtifactRef | undefined
          if (!original || !validManagedArtifactRef(original) || !catalog) return unavailable('catalog-unavailable')
          if (query.expectedRef && !sameManagedArtifactRef(query.expectedRef, original)) return unavailable('stale-ref')
          const page = await readSavedProcessFrame(context, original, query.cursor, catalog)
          if ('kind' in page) return page
          return { kind: 'frames' as const, ownerSessionId: sessionId, live: Boolean(active), backend: 'shell' as const, nativeJob: candidate.nativeJob, page, catalogCompleteness: catalogCompleteness ?? catalog.completeness, sourceCompleteness: original.completeness, scope: 'captured' as const }
        }
        if (frames) return unavailable()
        const live = background.find(job => (query.backend === undefined || job.kind === query.backend)
          && (query.instanceId === undefined || job.nativeJob?.instanceId === query.instanceId))
        if (query.sourceId !== undefined && live?.nativeJob?.sourceId !== query.sourceId) return unavailable(live ? 'stale-source' : 'unavailable')
        if (live) return { text: live.output.slice(0, 131072), truncated: live.outputTruncated || live.output.length > 131072, ownerSessionId: sessionId, live: true }
        if (query.instanceId) return unavailable()
        if (!child || query.backend === 'shell' || query.backend === 'workflow') return unavailable()
        const text = child.output ?? ''
        return { text: text.slice(0, 131072), truncated: text.length > 131072, ownerSessionId: sessionId, live: Boolean((assembly?.tasks() ?? managed?.tasks())?.some(task => task.id === id)) }
      }) } catch (cause) {
        if (frames) return { kind: 'unavailable' as const, reason: (cause as { code?: string }).code ?? 'unavailable' }
        return unavailable((cause as { code?: string }).code ?? "unavailable")
      }
  }
  const jobOutput = jobOutputImpl as { (sessionId: string, id: string): Promise<{text: string; truncated: boolean; ownerSessionId: string; live: boolean}>; (sessionId: string, id: string, input: JobOutputQuery): ReturnType<typeof jobOutputImpl> }
  return {
    async read(sessionId: string): Promise<AgentProcessesView> {
      resourceId(sessionId)
      return runRead(sessionId, async context => {
      const assembly = service.liveAssembly(sessionId), session = context.session
      const saved = savedShellJobs(context.index)
      const selectedJobs = saved.slice(-200).filter(row => !row.conflict && context.index.select(row.jobId, row.nativeJob?.instanceId).kind === "selected")
      context.selectJobs(selectedJobs.map(row => ({ id: row.jobId, instanceId: row.nativeJob?.instanceId })))
      const jobs = new Map<string, JobView & { nativeJob?: NativeIdentity; outputDisposition?: AgentProcessesView["jobs"][number]["outputDisposition"] }>([...projectJobsDoc(context.document), ...foldJobs(session.events)].map(job => [job.kind + ":" + job.jobId, job]))
      const managed = context.managedProcesses?.()
      const tasks = assembly?.tasks() ?? managed?.tasks() ?? []
      const background = (assembly?.backgroundJobs?.() ?? managed?.background ?? []).filter(job => job.ownerSessionId === sessionId)
      const savedPtys = savedTerminals(session.events, sessionId)
      context.selectTerminals([...savedPtys.values()])
      const terminals = new Map([...savedPtys.values()].map(({ text: _text, truncated: _truncated, dropped: _dropped, endOffset: _offset, evidence: _evidence, ...row }) => [row.id, row]))
      for (const row of assembly?.liveResources?.().terminals ?? []) if (row.ownerSessionId === sessionId) terminals.set(row.id, { ...row, live: true, canControl: row.status === "running", outputAvailable: true })
      for (const job of background) jobs.set(job.kind + ":" + job.id, { jobId: job.id, kind: job.kind, label: job.id, status: job.status, outputAvailable: Boolean(job.output), ...(job.kind === "shell" ? { nativeJob: job.nativeJob } : {}) })
      return { sessionId, live: Boolean(assembly || managed), terminals: [...terminals.values()].slice(-200),
        jobs: [...jobs.values(), ...saved.filter(row => !row.nativeJob || !background.some(active => active.kind === "shell" && active.nativeJob?.instanceId === row.nativeJob?.instanceId))].slice(-200).map(job => {
          const task = job.kind === "shell" ? undefined : tasks.find(task => task.id === job.jobId); const active = background.find(row => row.id === job.jobId && row.kind === job.kind && (row.kind !== "shell" || "nativeJob" in job && job.nativeJob && row.nativeJob?.instanceId === (job.nativeJob as any).instanceId))
          const declaration = "declaration" in job ? job.declaration as SavedCall : undefined
          return { jobId: job.jobId, kind: job.kind, label: job.label, status: job.status, outputAvailable: job.outputAvailable, startedAt: job.startedAt, endedAt: job.endedAt,
            ownerSessionId: sessionId, live: Boolean(task || active), canCancel: !!assembly && (active ? active.status === "running" && (active.kind !== "shell" || !!active.nativeJob && assembly.ctx.services.get<{ supportsNativeJobKill?: true }>("exec/service")?.supportsNativeJobKill === true) : task?.canCancel === true), backend: job.kind === "shell" ? "shell" : job.kind === "workflow" ? "workflow" : "child", ...("nativeJob" in job ? { nativeJob: job.nativeJob } : {}), ...("outputDisposition" in job ? { outputDisposition: job.outputDisposition } : {}), ...(declaration ? { declaration: { surface: declaration.surface, cellId: declaration.cellId, callId: declaration.callId, callIndex: declaration.callIndex, resultIndex: declaration.resultIndex, callSeq: declaration.callSeq, resultSeq: declaration.resultSeq } } : {}) }
        }) }
      })
    },
    async terminalOutput(sessionId: string, id: string) {
      resourceId(sessionId); resourceId(id)
      return runRead(sessionId, async context => {
      const session = context.session
      const row = savedTerminals(session.events, sessionId).get(id)
      if (row) context.selectTerminals([row])
      if (!row?.outputAvailable) throw new Error("Saved terminal output unavailable for this owner")
      return { text: row.text, truncated: row.truncated, dropped: row.dropped, reason: row.outputReason, ownerSessionId: sessionId, live: false }
      })
    },
    async control(sessionId: string, input: unknown) {
      resourceId(sessionId); await coordinator.profile(sessionId)
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid process command")
      const command = input as Record<string, unknown>; const id = resourceId(command.id)
      const allowed: Record<string, string[]> = { read: ["offset"], send: ["data"], resize: ["cols", "rows"], signal: ["signal"], close: [], "job/cancel": ["backend", "instanceId", "sourceId"] }
      const fields = allowed[String(command.action)]
      if (!fields || Object.keys(command).some(key => !["action", "id", ...fields].includes(key))) throw new Error("Unsupported process command")
      const assembly = service.liveAssembly(sessionId)
      if (!assembly && originalManagedExecutionFor(service, sessionId)) throw new Error("Process control is unavailable for this private runtime")
      if (!assembly) throw new Error("No live process owner; cold history cannot control a process")
      if (command.action === "job/cancel") {
        if (command.backend !== undefined && !['shell', 'child', 'workflow'].includes(String(command.backend))) throw new Error('Unsupported process command')
        const background = assembly.backgroundJobs?.().find(job => job.id === id && job.ownerSessionId === sessionId && job.status === 'running' && (!command.backend || command.backend === job.kind))
        if (!background && !assembly.tasks().some(task => task.id === id && task.group === 'job' && task.canCancel)) throw new Error('Job is not live or cancellable for this owner')
        if (command.instanceId !== undefined) resourceId(command.instanceId)
        if (command.sourceId !== undefined) resourceId(command.sourceId)
        if (command.backend === 'shell' && !command.instanceId || command.backend === undefined && background && assembly.tasks().some(task => task.id === id && task.group === 'job' && task.canCancel)) throw new Error('Ambiguous native job selector')
        const selected = background?.kind === 'shell' ? background.nativeJob : undefined
        if ((command.instanceId !== undefined || command.sourceId !== undefined) && !selected || selected && (command.instanceId !== undefined && command.instanceId !== selected.instanceId || command.sourceId !== undefined && command.sourceId !== selected.sourceId)) throw new Error('Native job instance changed')
        const args = selected ? { job_id: id, backend: 'shell', job_instance_id: selected.instanceId, source_id: selected.sourceId, reason: 'Stopped by user' } : { job_id: id, ...(command.backend ? { backend: command.backend } : {}), reason: 'Stopped by user' }
        const prepared = await assembly.tools.prepare({ name: 'job_kill', args }, undefined, { sessionId, callId: `desktop-job-${randomUUID()}` })
        if (selected && !assembly.backgroundJobs?.().some(job => job.kind === 'shell' && job.id === id && job.nativeJob?.instanceId === selected.instanceId && job.nativeJob.sourceId === selected.sourceId && job.ownerSessionId === sessionId)) throw new Error('Native job instance changed')
        const output = await assembly.tools.dispatch(prepared); await assembly.tools.finalize(prepared, output)
        await coordinator.flush(sessionId); return output
      }
      const row = assembly.liveResources?.().terminals.find(row => row.id === id && row.ownerSessionId === sessionId)
      if (!row || (command.action !== "read" && row.status !== "running")) throw new Error("Terminal has no live process owner in this session")
      let name: string; let args: Record<string, unknown> = { id }
      switch (command.action) {
        case "read": name = "terminal_read"; args = { id, offset: boundedInteger(command.offset, 0, Number.MAX_SAFE_INTEGER, 0), maxBytes: 32768 }; break
        case "send":
          if (typeof command.data !== "string" || command.data.length > 32768) throw new Error("Terminal input exceeds limit")
          name = "terminal_send"; args.data = command.data; break
        case "resize": name = "process_resize_pty"; args.cols = boundedInteger(command.cols, 2, 500); args.rows = boundedInteger(command.rows, 2, 500); break
        case "signal":
          if (!["INT", "TERM", "KILL"].includes(String(command.signal))) throw new Error("Invalid process signal")
          name = "terminal_signal"; args.signal = command.signal; break
        case "close": name = "terminal_close"; break
        default: throw new Error("Unsupported process command")
      }
      // UI carries no arbitrary tool name, executable, owner, or escalation.
      // Prepare/dispatch preserve the registry's role, hooks, Plan, approval,
      // sandbox, and service ownership checks at the actual action boundary.
      const prepared = await assembly.tools.prepare({ name, args }, undefined, { sessionId, callId: `desktop-process-${randomUUID()}` })
      const output = await assembly.tools.dispatch(prepared)
      await assembly.tools.finalize(prepared, output)
      if (output && typeof output === "object" && "error" in output) throw new Error(String(output.error))
      return output
    },
    jobOutput,
  }
}
