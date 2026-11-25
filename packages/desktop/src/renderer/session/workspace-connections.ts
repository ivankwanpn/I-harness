import type { DesktopEvent, WorkspaceConnection } from "../../shared/bridge.ts"

export interface WorkspaceConnectionRecord {
  readonly phase: WorkspaceConnection
  readonly generation?: number
}

/** IPC lifecycle owns transport state. Navigation only selects a workspace. */
export function createWorkspaceConnections() {
  let states: ReadonlyMap<string, WorkspaceConnectionRecord> = new Map()
  const listeners = new Set<() => void>()
  function set(workspaceId: string, phase: WorkspaceConnection, generation = states.get(workspaceId)?.generation) {
    const prior = states.get(workspaceId)
    if (prior?.phase === phase && prior.generation === generation) return prior
    const next = { phase, generation }
    const updated = new Map(states)
    updated.set(workspaceId, next)
    states = updated
    for (const listener of listeners) listener()
    return next
  }
  return {
    snapshot: () => states,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    get: (workspaceId: string) => states.get(workspaceId),
    set,
    setIfCurrent(workspaceId: string, observed: WorkspaceConnectionRecord | undefined, phase: WorkspaceConnection, generation?: number) {
      if (states.get(workspaceId) === observed) set(workspaceId, phase, generation)
    },
    observe(event: DesktopEvent): boolean {
      if (event.kind !== "sdk/ready" && event.kind !== "sdk/disconnected" && event.kind !== "sdk/idle") return true
      const id = event.workspaceId
      const generation = event.kind === "sdk/disconnected" ? event.close?.generation : event.runtimeGeneration
      const prior = states.get(id)
      const phase = event.kind === "sdk/ready" ? "online" : event.kind === "sdk/idle" ? "idle" : "offline"
      if (generation !== undefined && prior?.generation !== undefined &&
          (generation < prior.generation || (generation === prior.generation && phase === "online" &&
            (prior.phase === "offline" || prior.phase === "idle")))) return false
      return set(id, phase, generation) !== prior
    },
  }
}
