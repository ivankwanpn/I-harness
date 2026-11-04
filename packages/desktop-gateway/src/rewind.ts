import {originalManagedRewindFor} from '../../session-executor/src/host-managed-rewind.ts'
import { createHash } from "node:crypto"
import { createRewindIntentLog, withRewindFacts } from '@i-harness/session-executor'
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { RewindStore, RewindService, createGitProbeForStore, type RewindMode } from "@i-harness/rewind"

export function createDesktopRewind(root: string, workspace: string, coordinator: SessionCoordinator, service: SessionService) {
  const engine = async (sessionId: string) => {
    await coordinator.profile(sessionId)
    const managed=originalManagedRewindFor(service,sessionId)
    if(managed?.kind==='unavailable')throw Error('Original managed Rewind unavailable')
    if(managed?.kind==='ready')await managed.drain()
    const store = managed?.kind==='ready'?managed.store:new RewindStore({ root, sessionId, workspace })
    return {rewind:new RewindService({ store, workspace, gitProbe: createGitProbeForStore(store, workspace) }),managed}
  }
  const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  return {
    async points(sessionId: string) { const {rewind,managed}=await engine(sessionId);const value=await rewind.points();if(managed?.kind==='ready')managed.assertCurrent();return value },
    async plan(sessionId: string, target: number, mode: RewindMode) {
      const {rewind,managed}=await engine(sessionId);const plan = await rewind.plan(target, mode)
      if(managed?.kind==='ready')managed.assertCurrent()
      return { ...plan, fingerprint: fingerprint(plan) }
    },
    async execute(sessionId: string, target: number, mode: RewindMode, expected: string) {
      const queue = service.queueState(sessionId)
      if (queue.running || queue.queued || service.tasks(sessionId).some((task) => ["queued", "running", "waiting"].includes(task.status))) throw new Error("Session is busy")
      const {rewind,managed} = await engine(sessionId)
      if(managed?.kind==='ready'){const plan=await rewind.plan(target,mode);if(fingerprint(plan)!==expected)throw new Error('Rewind preview changed; preview again before confirming');return managed.execute(appendEvent=>rewind.execute(target,mode,{appendEvent}))}
      await coordinator.flush(sessionId)
      // Obtain ownership even for a cold session, before any file restoration.
      const live=await service.writableSessionFor?.(sessionId)??service.liveSession(sessionId)
      const document=await coordinator.openManagedDocument(sessionId)
      if(live&&live!==document.view)throw Object.assign(new Error('Rewind requires the owned document view'),{code:'FACT_OWNER_UNSUPPORTED'})
      const plan = await rewind.plan(target, mode)
      if (fingerprint(plan) !== expected) throw new Error("Rewind preview changed; preview again before confirming")
      return withRewindFacts(document,appendEvent=>rewind.execute(target,mode,{appendEvent}), createRewindIntentLog(coordinator.storageRoot, sessionId, target, mode))
    },
  }
}
