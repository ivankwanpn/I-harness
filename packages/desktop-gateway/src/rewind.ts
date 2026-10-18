import { createHash } from "node:crypto"
import { withRewindFacts } from '@i-harness/session-executor'
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
      const live=await service.writableSessionFor?.(sessionId)??service.liveSession(sessionId)
      const document=await coordinator.openManagedDocument(sessionId)
      if(live&&live!==document.view)throw Object.assign(new Error('Rewind requires the owned document view'),{code:'FACT_OWNER_UNSUPPORTED'})
      const plan = await rewind.plan(target, mode)
      if (fingerprint(plan) !== expected) throw new Error("Rewind preview changed; preview again before confirming")
      return withRewindFacts(document,appendEvent=>rewind.execute(target,mode,{appendEvent}))
    },
  }
}
