import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import type { SessionAssembly, SessionService } from "@i-harness/session-executor"
import { derivePlanMode, type Session, type SessionEvent } from "@i-harness/core-session"
import type { HistoryRange } from "@i-harness/sdk"
import { transportSessionEvents } from "@i-harness/sdk/server"
import { foldTeam, teamLedger } from "@i-harness/agent-team"
import { taskDocKey } from "@i-harness/subagent"
import { createConversationVisibility, createSubagentVisibility } from "./session-visibility.ts"

export type DesktopSubagentStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unavailable"
export interface DesktopSubagentRow {
  sessionId: string
  parentSessionId: string
  path?: string
  roleName?: string
  label: string
  status: DesktopSubagentStatus
  live: boolean
  modelLabel?: string
  jobId?: string
  finalText?: string
  error?: string
  controlReason?: string
  canFollowup: boolean
  canMessage: boolean
  canInterrupt: boolean
  canClose: boolean
}
export interface DesktopSubagentCatalog {
  parentSessionId: string
  agents: DesktopSubagentRow[]
  errors?: { sessionId?: string; message: string }[]
}
export type DesktopSubagentControl = { action: "followup" | "message" | "interrupt" | "close"; text?: string }
export interface DesktopSubagentControlResult { parentSessionId: string; childSessionId: string; action: DesktopSubagentControl["action"]; result: unknown }
type AgentRecord = { sessionId: string; path: string; status: string; roleName?: string; modelLabel?: string; jobId?: string; finalText?: string; error?: string }
type Authority = { ownerId: string; assembly: SessionAssembly; entry: AgentRecord }
const MAX_LINEAGE = 64
const CONTROL_REASON = "This subagent is not active in the current process. Its saved history remains available."
const PLAN_REASON = "Leave Plan Mode before following up with or messaging a subagent."
const actions = new Set(["followup", "message", "interrupt", "close"])
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function id(value: string): void { if (typeof value !== "string" || !value || value.length > 256 || value.includes("\0")) throw new Error("Invalid session id") }
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000) }
function records(value: unknown): AgentRecord[] {
  if (!Array.isArray(value)) throw new Error("Subagent registry is unavailable")
  return value.flatMap((raw) => {
    const row = object(raw)
    if (typeof row?.sessionId !== "string" || typeof row.path !== "string" || typeof row.status !== "string") return []
    return [{ sessionId: row.sessionId, path: row.path, status: row.status, ...Object.fromEntries(["roleName", "modelLabel", "jobId", "finalText", "error"].flatMap((key) => typeof row[key] === "string" ? [[key, row[key]]] : [])) }]
  })
}
function status(raw?: string): DesktopSubagentStatus {
  return raw === "running" || raw === "waiting" || raw === "completed" ? raw : raw === "accepted" ? "queued" : raw === "error" || raw === "recovery-required" ? "failed" : raw === "killed" || raw === "cancelled" ? "cancelled" : "unavailable"
}

/** A read-only catalog over durable lineage and existing runtime registries.
 * No read or control here constructs an assembly, creates a session, or repairs
 * a cold log. Controls require the exact already-live owning registry. */
export function createDesktopSubagents(coordinator: SessionCoordinator, service: SessionService, options: { onChanged?: (parentSessionId: string) => void } = {}) {
  const visible = createConversationVisibility(coordinator)
  const childVisible = createSubagentVisibility(coordinator)
  const writes = new Map<string, Promise<unknown>>()
  let closed = false
  function open(): void { if (closed) throw new Error("Subagent catalog closed") }
  async function parent(parentId: string): Promise<SessionMeta> {
    open(); id(parentId)
    const { meta } = await coordinator.profile(parentId)
    if (!await visible(parentId, meta)) throw new Error("Parent conversation is unavailable")
    return meta
  }
  async function lineage(parentId: string, childId: string): Promise<SessionMeta[]> {
    id(childId)
    const seen = new Set([childId])
    const chain: SessionMeta[] = []
    let current = childId
    for (let depth = 0; depth < MAX_LINEAGE; depth++) {
      const { meta } = await coordinator.profile(current)
      if (!await childVisible(current, meta)) throw new Error("Session is not an available subagent in this parent scope")
      chain.push(meta)
      if (meta.parentSession === parentId) return chain
      if (!meta.parentSession || seen.has(meta.parentSession)) break
      seen.add(meta.parentSession); current = meta.parentSession
    }
    throw new Error("Subagent is outside this parent scope")
  }
  async function snapshot(sessionId: string): Promise<Session> {
    const live = service.liveSession(sessionId)
    if (!live && !coordinator.snapshot) throw new Error("Read-only session snapshots are unavailable")
    const session = live ?? (await coordinator.snapshot!(sessionId)).session
    for (let index = 0; index < session.events.length; index++) {
      const seq = session.events[index]!.seq
      if (seq !== undefined && seq !== index) throw new Error(`Session sequence invariant failed for ${sessionId}: event ${index} has seq ${seq}`)
    }
    return session
  }
  function live(ownerId: string): { assembly: SessionAssembly; entries: AgentRecord[] } | undefined {
    const assembly = service.liveAssembly(ownerId)
    if (!assembly) return undefined
    return { assembly, entries: records(assembly.subagentState().agentTable) }
  }
  function authority(parentId: string, childId: string, chain: SessionMeta[]): Authority | undefined {
    // Descendants may share the root's registry, or be owned by a separately
    // live intermediate parent. Only the exact SID backlink authorizes a path.
    const owners = [...new Set([parentId, ...chain.map((meta) => meta.parentSession!).filter(Boolean)])]
    for (const ownerId of owners) {
      const runtime = live(ownerId)
      const entry = runtime?.entries.find((row) => row.sessionId === childId)
      if (runtime && entry) return { ownerId, assembly: runtime.assembly, entry }
    }
    return undefined
  }
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
    for (const ownerId of new Set([parentId, ...scoped.flatMap((row) => row.chain)])) {
      try {
        const doc = object(await coordinator.getDocument(ownerId))
        stored.set(ownerId, doc === undefined ? [] : doc.formatVersion === 1 ? records(doc.agentTable) : (() => { throw new Error("Subagent registry metadata is invalid") })())
      } catch (error) { errors.push({ sessionId: ownerId === parentId ? undefined : ownerId, message: errorText(error) }); stored.set(ownerId, []) }
      // Closed entries leave the runtime table. Their submission and team
      // membership records retain durable names/roles for the saved catalog.
      try {
        const doc = object(await coordinator.getDocument(taskDocKey(ownerId)))
        if (doc && (doc.formatVersion !== 1 || !Array.isArray(doc.tasks))) throw new Error("Subagent task metadata is invalid")
        for (const raw of doc?.tasks as unknown[] ?? []) {
          const task = object(raw)
          if (typeof task?.childSessionId !== "string" || typeof task.agentPath !== "string") continue
          hints.set(task.childSessionId, { sessionId: task.childSessionId, path: task.agentPath, status: typeof task.outcome === "string" ? task.outcome : typeof task.status === "string" ? task.status : "unavailable", ...(typeof task.agent === "string" ? { roleName: task.agent } : {}), ...(typeof task.description === "string" ? { label: task.description } : {}), ...(typeof task.resultText === "string" ? { finalText: task.resultText } : {}), ...(typeof task.error === "string" ? { error: task.error } : {}) })
        }
        const ownerSession = await snapshot(ownerId)
        ownerSessions.set(ownerId, ownerSession)
        const team = foldTeam(teamLedger(ownerSession)).state
        for (const member of team.members.values()) if (member.sessionId) hints.set(member.sessionId, { sessionId: member.sessionId, path: `lead/${member.name}`, roleName: "teammate", label: member.name, status: member.phase === "failed" ? "error" : "unavailable", ...(member.error ? { error: member.error } : {}) })
      } catch (error) { errors.push({ sessionId: ownerId === parentId ? undefined : ownerId, message: errorText(error) }) }
      try { runtimes.set(ownerId, live(ownerId)) }
      catch (error) { errors.push({ sessionId: ownerId === parentId ? undefined : ownerId, message: errorText(error) }) }
    }
    const agents: DesktopSubagentRow[] = []
    for (const { sessionId, meta, chain } of scoped) {
      const runtime = chain.map((ownerId) => ({ ownerId, runtime: runtimes.get(ownerId) })).find(({ runtime }) => runtime?.entries.some((row) => row.sessionId === sessionId))
      const liveEntry = runtime?.runtime?.entries.find((row) => row.sessionId === sessionId)
      const saved = chain.flatMap((ownerId) => stored.get(ownerId) ?? []).find((row) => row.sessionId === sessionId)
      const hint = hints.get(sessionId)
      const entry = liveEntry || saved || hint ? { ...hint, ...saved, ...liveEntry } : undefined
      let events: SessionEvent[] = [], unavailable: string | undefined
      try { events = (await snapshot(sessionId)).events.slice(meta.seedLength ?? 0) }
      catch (error) { unavailable = errorText(error); errors.push({ sessionId, message: unavailable }) }
      const final = events.findLast((event) => event.type === "assistant/message")
      const finalText = liveEntry?.finalText ?? saved?.finalText ?? (final?.type === "assistant/message" ? final.text : undefined) ?? hint?.finalText
      const ended = events.findLastIndex((event) => event.type === "turn/end")
      const started = events.findLastIndex((event) => event.type === "turn/start")
      let state = status(entry?.status)
      if (!liveEntry) {
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
      agents.push({
        sessionId, parentSessionId: meta.parentSession!, label: meta.title?.trim() || hint?.label || entry?.path?.split("/").at(-1) || entry?.roleName || "Subagent",
        status: state, live: isLive,
        ...(entry?.path ? { path: entry.path } : {}), ...(entry?.roleName ? { roleName: entry.roleName } : {}), ...(entry?.modelLabel ? { modelLabel: entry.modelLabel } : {}), ...(entry?.jobId ? { jobId: entry.jobId } : {}),
        ...(finalText ? { finalText: finalText.slice(0, 16_384) } : {}),
        ...((unavailable ?? entry?.error) ? { error: unavailable ?? entry?.error } : {}),
        ...(!canControl || plan ? { controlReason: parentMeta.archived ? "The parent conversation is archived." : plan ? PLAN_REASON : CONTROL_REASON } : {}),
        canFollowup: Boolean(canControl && !plan && tools?.get(team ? "team_followup_task" : "followup_task")),
        canMessage: Boolean(canControl && !plan && tools?.get(team ? "team_send_message" : "send_message")),
        canInterrupt: Boolean(canControl && liveEntry?.status === "running" && tools?.get(team ? "team_interrupt_agent" : "interrupt_agent")),
        canClose: Boolean(canControl && tools?.get("close_agent")),
      })
    }
    return { parentSessionId: parentId, agents, ...(errors.length ? { errors } : {}) }
  }
  async function history(parentId: string, childId: string, paging: { afterSeq?: number; limit?: number } = {}): Promise<HistoryRange> {
    await parent(parentId); await lineage(parentId, childId); open()
    const afterSeq = paging.afterSeq ?? 0, limit = paging.limit ?? 200
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid history page")
    const session = await snapshot(childId)
    const start = Math.min(afterSeq, session.events.length), end = Math.min(start + limit, session.events.length)
    return { events: transportSessionEvents(session, session.events.slice(start, end)), nextSeq: end }
  }
  function control(parentId: string, childId: string, command: DesktopSubagentControl): Promise<DesktopSubagentControlResult> {
    id(parentId); id(childId)
    const key = `${parentId}:${childId}`
    const job = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const parentMeta = await parent(parentId)
      if (parentMeta.archived) throw new Error("Parent conversation is archived")
      if (!command || !actions.has(command.action)) throw new Error("Invalid subagent control")
      if (command.action === "followup" || command.action === "message") {
        if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 65_536 || command.text.includes("\0")) throw new Error("Subagent text must contain 1-65536 characters")
      } else if (command.text !== undefined) throw new Error("This subagent control does not accept text")
      const chain = await lineage(parentId, childId)
      let owned = authority(parentId, childId, chain)
      open()
      if (!owned || service.liveAssembly(owned.ownerId) !== owned.assembly) throw new Error("Subagent runtime is unavailable")
      if (owned.entry.status === "killed") throw new Error("Subagent is closed")
      if (command.action === "interrupt" && owned.entry.status !== "running") throw new Error("Subagent is not running")
      const team = owned.entry.path.startsWith("lead/")
      const name = command.action === "close" ? "close_agent" : team ? `team_${command.action === "message" ? "send_message" : command.action === "followup" ? "followup_task" : "interrupt_agent"}` : command.action === "message" ? "send_message" : command.action === "followup" ? "followup_task" : "interrupt_agent"
      const driving = command.action === "followup" || command.action === "message"
      const rootSession = driving ? await snapshot(parentId) : undefined
      // Revalidate durable ownership immediately before invoking the exact live
      // registry. No renderer-supplied path/name is passed to the tool.
      const finalChain = await lineage(parentId, childId); open()
      const current = authority(parentId, childId, finalChain)
      if (!current || service.liveAssembly(owned.ownerId) !== owned.assembly || current.assembly !== owned.assembly || current.entry.path !== owned.entry.path) throw new Error("Subagent runtime is unavailable")
      owned = current
      if (owned.entry.status === "killed" || (command.action === "interrupt" && owned.entry.status !== "running")) throw new Error("Subagent control is unavailable in its current state")
      if (driving && (derivePlanMode(owned.assembly.session).active || derivePlanMode(service.liveAssembly(parentId)?.session ?? rootSession!).active)) throw new Error(PLAN_REASON)
      const tool = owned.assembly.tools.get(name)
      if (!tool) throw new Error("Subagent control is unavailable")
      const target = team && command.action !== "close" ? owned.entry.path.slice("lead/".length) : owned.entry.path
      const result = await tool.execute({ target, ...(command.text !== undefined ? { message: command.text } : {}) }, { sessionId: owned.ownerId })
      await coordinator.flush(childId); await coordinator.flush(owned.ownerId)
      options.onChanged?.(parentId)
      return { parentSessionId: parentId, childSessionId: childId, action: command.action, result }
    })
    writes.set(key, job)
    void job.finally(() => { if (writes.get(key) === job) writes.delete(key) }).catch(() => {})
    return job
  }
  return { list, history, control, async close() { closed = true; await Promise.allSettled([...writes.values()]) } }
}
