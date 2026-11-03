import { committedChildResultStatus } from "./result-proof.ts"
import { currentTaskFormat } from './catalog-provenance.ts'
import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { derivePlanMode, type SessionView as Session, type SessionEventView as SessionEvent } from "@i-harness/core-session"
import { foldTeam, teamLedger } from "@i-harness/agent-team"
import { taskDocKey, childResultPreview } from "@i-harness/subagent"
import type { SubagentScope } from "./scope.ts"
import { object, records, jobRecords, status, errorText, MAX_LINEAGE, CONTROL_REASON, PLAN_REASON, type AgentRecord, type DesktopSubagentCatalog, type DesktopSubagentRow } from "./types.ts"
export function createSubagentCatalog(coordinator: SessionCoordinator, service: SessionService, scope: SubagentScope) {
  const { parent, childVisible, snapshot, live, authority, liveChild } = scope
  async function list(parentId: string): Promise<DesktopSubagentCatalog> {
    const parentMeta = await parent(parentId)
    const errors: NonNullable<DesktopSubagentCatalog["errors"]> = []
    const metas = new Map<string, SessionMeta>()
    for (const sessionId of await coordinator.list()) {
      try { metas.set(sessionId, (await coordinator.profile(sessionId)).meta) }
      catch { if (!errors.some((row) => row.sessionId === undefined)) errors.push({ message: "Some stored session headers are unavailable" }) }
    }
    const scoped: { sessionId: string; meta: SessionMeta; chain: string[] }[] = []
    for (const [sessionId, meta] of metas) {
      if (meta.origin !== "subagent" || sessionId === parentId) continue
      const seen = new Set([sessionId]), chain = [parentId]
      let next = meta.parentSession, related = false
      for (let depth = 0; next && depth < MAX_LINEAGE; depth++) {
        if (next === parentId) { related = true; break }
        if (seen.has(next)) break
        seen.add(next)
        const ancestor = metas.get(next)
        if (!ancestor || ancestor.origin !== "subagent") break
        chain.push(next); next = ancestor.parentSession
      }
      if (!related) continue
      try {
        let publicChild = await childVisible(sessionId, meta)
        for (const ancestorId of chain.slice(1)) if (!await childVisible(ancestorId, metas.get(ancestorId)!)) publicChild = false
        if (!publicChild) continue
      }
      catch (error) { errors.push({ sessionId, message: errorText(error) }) }
      scoped.push({ sessionId, meta, chain })
    }
    const stored = new Map<string, AgentRecord[]>(), runtimes = new Map<string, ReturnType<typeof live>>()
    const hints = new Map<string, AgentRecord & { label?: string }>()
    const ownerSessions = new Map<string, Session>()
    const invalidOwners = new Set<string>()
    for (const ownerId of new Set([parentId, ...scoped.flatMap((row) => row.chain)])) {
      try {
        const raw = await coordinator.getDocument(ownerId), doc = object(raw)
        if (raw !== undefined && !doc) throw new Error('Subagent registry metadata is invalid')
        stored.set(ownerId, doc === undefined ? [] : (doc.formatVersion === 1 || doc.formatVersion === 2) ? [...records(doc.agentTable), ...jobRecords(doc.jobs).filter(job => !records(doc.agentTable).some(entry => entry.sessionId === job.sessionId))].map(row => ({ ...row, currentFormat: doc.formatVersion === 2 })) : (() => { throw new Error("Subagent registry metadata is invalid") })())
      } catch (error) { invalidOwners.add(ownerId); errors.push({ sessionId: ownerId === parentId ? undefined : ownerId, message: errorText(error) }); stored.set(ownerId, []) }
      // Closed entries leave the runtime table. Their submission and team
      // membership records retain durable names/roles for the saved catalog.
      try {
        const raw = await coordinator.getDocument(taskDocKey(ownerId)), doc = object(raw)
        if (raw !== undefined && !doc) throw new Error('Subagent task metadata is invalid')
        if (doc && ((doc.formatVersion !== 1 && doc.formatVersion !== 2) || !Array.isArray(doc.tasks))) throw new Error("Subagent task metadata is invalid")
        for (const raw of doc?.tasks as unknown[] ?? []) {
          const task = object(raw)
          if (typeof task?.childSessionId !== "string" || typeof task.agentPath !== "string") continue
          hints.set(task.childSessionId, { currentFormat: currentTaskFormat(task, doc!.formatVersion), ...(typeof task.id === 'string' ? { taskId: task.id } : {}), sessionId: task.childSessionId, path: task.agentPath, status: typeof task.outcome === "string" ? task.outcome : typeof task.status === "string" ? task.status : "unavailable", ...(typeof task.agent === "string" ? { roleName: task.agent } : {}), ...(typeof task.jobId === "string" ? { jobId: task.jobId } : {}), ...(typeof task.modelLabel === "string" ? { modelLabel: task.modelLabel } : {}), ...(typeof task.description === "string" ? { label: task.description } : {}), ...(typeof task.resultText === "string" ? { finalText: task.resultText } : {}), ...(typeof task.error === "string" ? { error: task.error } : {}), ...(task.result ? { result: task.result as AgentRecord["result"] } : {}) })
        }
        const scopedOwner = scoped.find(row => row.sessionId === ownerId)
        const ownerAuthority = scopedOwner ? authority(parentId, ownerId, [scopedOwner.meta, ...scopedOwner.chain.slice(1).map(id => metas.get(id)!)]) : undefined
        const ownerSession = await snapshot(ownerId, liveChild(ownerId, ownerAuthority))
        ownerSessions.set(ownerId, ownerSession)
        const team = foldTeam(teamLedger(ownerSession)).state
        for (const member of team.members.values()) if (member.sessionId) hints.set(member.sessionId, { currentFormat: hints.get(member.sessionId)?.currentFormat, sessionId: member.sessionId, path: `lead/${member.name}`, roleName: "teammate", label: member.name, status: member.phase === "failed" ? "error" : "unavailable", ...(member.error ? { error: member.error } : {}) })
      } catch (error) { invalidOwners.add(ownerId); errors.push({ sessionId: ownerId === parentId ? undefined : ownerId, message: errorText(error) }) }
      try { runtimes.set(ownerId, live(ownerId)) }
      catch (error) { errors.push({ sessionId: ownerId === parentId ? undefined : ownerId, message: errorText(error) }) }
    }
    const agents: DesktopSubagentRow[] = []
    for (const { sessionId, meta, chain } of scoped) {
      const runtime = chain.map((ownerId) => ({ ownerId, runtime: runtimes.get(ownerId) })).find(({ runtime }) => runtime?.entries.some((row) => row.sessionId === sessionId))
      const liveEntry = runtime?.runtime?.entries.find((row) => row.sessionId === sessionId)
      const saved = chain.flatMap((ownerId) => stored.get(ownerId) ?? []).find((row) => row.sessionId === sessionId)
      const hint = hints.get(sessionId)
      const currentFormat = meta.subagentProtocolVersion === 1 || saved?.currentFormat === true || hint?.currentFormat === true || chain.some(id => invalidOwners.has(id))
      const entry = liveEntry || saved || hint ? { ...hint, ...saved, ...liveEntry } : undefined
      // Snapshots omit cleared optional fields. Unlike identity metadata, an
      // absent error on the current registry must not fall back to an older
      // saved entry or the initial task's outcome after a successful retry.
      const currentError = (liveEntry ?? saved ?? hint)?.error
      let retained = (liveEntry ?? saved ?? hint)?.result
      let events: readonly SessionEvent[] = [], unavailable: string | undefined
      const childAuthority = runtime?.runtime && liveEntry ? { ownerId: runtime.ownerId, assembly: runtime.runtime.assembly, entry: liveEntry } : undefined
      try { if (!retained && (liveEntry || !currentFormat)) events = (await snapshot(sessionId, liveChild(sessionId, childAuthority))).events.slice(meta.seedLength ?? 0) }
      catch (error) { unavailable = errorText(error); errors.push({ sessionId, message: unavailable }) }
      const final = events.findLast((event) => event.type === "assistant/message")
      const finalText = liveEntry?.finalText ?? (liveEntry ? undefined : saved?.finalText) ?? (final?.type === "assistant/message" ? final.text : undefined) ?? hint?.finalText
      const ended = events.findLastIndex((event) => event.type === "turn/end")
      const started = events.findLastIndex((event) => event.type === "turn/start")
      let state = status(entry?.status)
      if (!liveEntry && retained) {
        const proof = committedChildResultStatus(meta.parentSession ? ownerSessions.get(meta.parentSession) : undefined, retained, entry?.jobId, entry?.taskId)
        state = entry?.status === "running" || entry?.status === "accepted" ? "unavailable" : proof?.status ?? "unavailable"
        if (state === 'unavailable' && retained.kind === 'retained') retained = { ...retained, envelope: { ...retained.envelope, execution: { outcome: 'unknown', dispatch: 'unknown' } } }
        else if (proof?.result) retained = proof.result
        if (state === "unavailable") unavailable ??= "The original child result fact is unavailable; retained bytes do not certify its execution outcome."
      } else if (!liveEntry && currentFormat) {
        state = 'unavailable'
        unavailable ??= 'The original child result fact is unavailable; saved history does not certify its execution outcome.'
      } else if (!liveEntry) {
        // A task submission records its initial result. A later resident
        // followup can outlive that result; the old task outcome is not proof
        // that the newest child turn finished.
        if (state === "completed" && started > ended) state = "unavailable"
        if (state === "waiting" || state === "running" || state === "unavailable") state = ended >= 0 && ended > started ? "completed" : "unavailable"
        if (state === "unavailable") unavailable ??= "No active runtime owns this subagent; its previous turn may have been interrupted."
      }
      if (unavailable) state = "unavailable"
      const isLive = Boolean(liveEntry && !unavailable && runtime && service.liveAssembly(runtime.ownerId) === runtime.runtime?.assembly)
      const team = entry?.path?.startsWith("lead/") === true
      const tools = runtime?.runtime?.assembly.tools
      const canControl = isLive && entry?.status !== "killed" && !parentMeta.archived
      const rootSession = runtimes.get(parentId)?.assembly.session ?? ownerSessions.get(parentId)
      const plan = Boolean((rootSession && derivePlanMode(rootSession).active) || (runtime?.runtime && derivePlanMode(runtime.runtime.assembly.session).active))
      const preview = retained ? childResultPreview({ ...(finalText !== undefined ? { resultText: finalText } : {}), ...((unavailable ?? currentError) !== undefined ? { error: unavailable ?? currentError } : {}) }) : undefined
      agents.push({
        sessionId, parentSessionId: meta.parentSession!, label: meta.title?.trim() || hint?.label || entry?.path?.split("/").at(-1) || entry?.roleName || "Subagent",
        status: state, live: isLive,
        ...(entry?.path ? { path: entry.path } : {}), ...(entry?.roleName ? { roleName: entry.roleName } : {}), ...(entry?.modelLabel ? { modelLabel: entry.modelLabel } : {}), ...(entry?.jobId ? { jobId: entry.jobId } : {}),
        ...(retained ? { result: retained, fullResult: { method: "desktop/session/subagents/result", sessionId: parentId, childSessionId: sessionId, resultRevision: retained.revision, ...(retained.kind === "retained" && retained.envelope.retention.kind === "artifact" ? { refId: retained.envelope.retention.ref.id, refRevision: retained.envelope.retention.ref.revision } : {}) } } : {}),
        ...(finalText !== undefined ? { finalText: retained ? preview?.resultText : finalText.slice(0, 16_384) } : {}),
        ...((unavailable ?? currentError) ? { error: retained ? preview?.error : unavailable ?? currentError } : {}),
        ...(!canControl || plan ? { controlReason: parentMeta.archived ? "The parent conversation is archived." : plan ? PLAN_REASON : CONTROL_REASON } : {}),
        canFollowup: Boolean(canControl && !plan && tools?.get(team ? "team_followup_task" : "followup_task")),
        canMessage: Boolean(canControl && !plan && tools?.get(team ? "team_send_message" : "send_message")),
        canInterrupt: Boolean(canControl && liveEntry?.status === "running" && tools?.get(team ? "team_interrupt_agent" : "interrupt_agent")),
        canClose: Boolean(canControl && tools?.get("close_agent")),
      })
    }
    return { parentSessionId: parentId, agents, ...(errors.length ? { errors } : {}) }
  }
  return { list }
}
