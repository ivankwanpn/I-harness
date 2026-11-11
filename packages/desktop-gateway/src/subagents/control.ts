import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { derivePlanMode } from "@i-harness/core-session"
import type { SubagentScope } from "./scope.ts"
import { id, actions, PLAN_REASON, type DesktopSubagentControl, type DesktopSubagentControlResult } from "./types.ts"
export function createSubagentControls(coordinator: SessionCoordinator, service: SessionService, scope: SubagentScope, changed: (parentId: string) => void) {
  const { parent, lineage, authority, open, snapshot } = scope
  const writes = new Map<string, Promise<unknown>>()
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
      if (owned.entry.path.startsWith("lead/")) throw new Error("Historical Team sessions are read-only")
      const name = command.action === "close" ? "close_agent" : command.action === "message" ? "send_message" : command.action === "followup" ? "followup_task" : "interrupt_agent"
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
      const target = owned.entry.path
      const result = await tool.execute({ target, ...(command.text !== undefined ? { message: command.text } : {}) }, { sessionId: owned.ownerId })
      await coordinator.flush(childId); await coordinator.flush(owned.ownerId)
      changed(parentId)
      return { parentSessionId: parentId, childSessionId: childId, action: command.action, result }
    })
    writes.set(key, job)
    void job.finally(() => { if (writes.get(key) === job) writes.delete(key) }).catch(() => {})
    return job
  }
  return { control, async close() { await Promise.allSettled([...writes.values()]) } }
}
