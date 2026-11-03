import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import type { SessionAssembly, SessionService } from "@i-harness/session-executor"
import type { SessionView as Session } from "@i-harness/core-session"
import { createConversationVisibility, createSubagentVisibility } from "../session-visibility.ts"
import { id, records, MAX_LINEAGE, type AgentRecord, type Authority } from "./types.ts"
export type SubagentScope = ReturnType<typeof createSubagentScope>
export function createSubagentScope(coordinator: SessionCoordinator, service: SessionService, open: () => void) {
  const visible = createConversationVisibility(coordinator), childVisible = createSubagentVisibility(coordinator)
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
  async function snapshot(sessionId: string, child?: Session): Promise<Session> {
    const live = child ?? service.liveSession(sessionId)
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
  function liveChild(childId: string, owned?: Authority): Session | undefined {
    return owned && service.liveAssembly(owned.ownerId) === owned.assembly ? owned.assembly.liveChildSession?.(childId) : undefined
  }
  return { open, parent, lineage, snapshot, live, authority, liveChild, childVisible }
}
