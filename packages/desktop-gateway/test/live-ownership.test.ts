import { expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import type { SessionService } from '@i-harness/session-executor'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createSessionManagement } from '../src/session-management.ts'
import { createConversationVisibility } from '../src/session-visibility.ts'

for (const action of ['move', 'archive'] as const) {
  for (const alreadyLive of [false, true]) {
    it(`${action} releases only its own live adoption while an original observation pin exists (alreadyLive=${alreadyLive})`, async () => {
      const base = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
      if (!base) throw new Error('Fresh native evidence root required')
      const root = await mkdtemp(join(base, 'gateway-adopt-')), store = join(root, 'sessions'), workspace = join(root, 'workspace')
      await mkdir(workspace)
      const backend = createJsonlBackend(store)
      const coordinator = createSessionCoordinator(backend, { lock: { enabled: true }, acquireDeadlineMs: 100, acquireRetryMs: 1 })
      const foreign = createSessionCoordinator(backend, { lock: { enabled: true }, acquireDeadlineMs: 100, acquireRetryMs: 1 })
      const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
      const adopted = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>()
      const originalAdopt = coordinator.adoptOwnership
      let pause = false
      const traced = { ...coordinator, async adoptOwnership(id: string) {
        await Reflect.apply(originalAdopt, coordinator, [id])
        if (pause) { adopted.resolve(); await proceed.promise }
      } }
      const broker = createProjectScopeBroker(traced, workspace, createConversationVisibility(coordinator), { async assertIdle() {} })
      const service = { queueState: () => ({ running: false, queued: 0 }), tasks: () => [] } as unknown as SessionService
      const manager = createSessionManagement(traced, service, createConversationVisibility(coordinator))
      let observing: Promise<unknown> | undefined, operation: Promise<unknown> | undefined
      try {
        await coordinator.create({ sessionId: 'session' })
        if (!alreadyLive) await coordinator.releaseOwnership('session')
        observing = coordinator.withExistingSessionBindingObservation!({ sessionIds: ['session'] }, async () => { entered.resolve(); await leave.promise })
        await entered.promise
        expect(coordinator.ownerOf('session')).toBe(true)
        pause = true
        operation = action === 'move' ? broker.move('session', undefined, undefined) : manager.mutate('session', 'archive')
        void operation.catch(error => adopted.reject(error))
        await adopted.promise
        leave.resolve(); await observing
        proceed.resolve(); await operation
        expect(coordinator.ownerOf('session')).toBe(alreadyLive)
        if (alreadyLive) await expect(foreign.adoptOwnership('session')).rejects.toThrow()
        else { await foreign.adoptOwnership('session'); await foreign.releaseOwnership('session') }
      } finally {
        leave.resolve(); proceed.resolve()
        await Promise.allSettled([observing, operation])
        await broker.close(); await coordinator.close(); await foreign.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
