import { createHash } from "node:crypto"
import { append, type SessionEvent } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { RewindStore, RewindService, createGitProbeForStore, type RewindMode } from "@i-harness/rewind"

export function createDesktopRewind(root: string, workspace: string, coordinator: SessionCoordinator, service: SessionService) {
  const engine = async (sessionId: string) => {
    await coordinator.profile(sessionId)
    const store = new RewindStore({ root, sessionId, workspace })
    return new RewindService({ store, workspace, gitProbe: createGitProbeForStore(store, workspace) })
  }
  const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  return {
    async points(sessionId: string) { return (await engine(sessionId)).points() },
    async plan(sessionId: string, target: number, mode: RewindMode) {
      const plan = await (await engine(sessionId)).plan(target, mode)
      return { ...plan, fingerprint: fingerprint(plan) }
    },
    async execute(sessionId: string, target: number, mode: RewindMode, expected: string) {
      const queue = service.queueState(sessionId)
      if (queue.running || queue.queued || service.tasks(sessionId).some((task) => ["queued", "running", "waiting"].includes(task.status))) throw new Error("Session is busy")
      const rewind = await engine(sessionId)
      await coordinator.flush(sessionId)
      // Obtain ownership even for a cold session, before any file restoration.
      const live = service.liveSession(sessionId)
      const owned = live ? undefined : await coordinator.loadOwned(sessionId)
      const plan = await rewind.plan(target, mode)
      if (fingerprint(plan) !== expected) throw new Error("Rewind preview changed; preview again before confirming")
      return rewind.execute(target, mode, { appendEvent: async (event) => {
        if (live) { append(live, event as SessionEvent); await coordinator.flush(sessionId) }
        else await coordinator.append(sessionId, [{ ...event, seq: owned!.session.events.length } as SessionEvent])
      } })
    },
  }
}
