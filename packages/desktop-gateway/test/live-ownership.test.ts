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
    it(`${action} waits for an original observation pin without losing its own live adoption (alreadyLive=${alreadyLive})`, async () => {
      const base = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
      if (!base) throw new Error('Fresh native evidence root required')
      const root = await mkdtemp(join(base, 'gateway-adopt-')), store = join(root, 'sessions'), workspace = join(root, 'workspace')
      await mkdir(workspace)
      const backend = createJsonlBackend(store)
      const coordinator = createSessionCoordinator(backend, { lock: { enabled: true }, acquireDeadlineMs: 100, acquireRetryMs: 1 })
      const foreign = createSessionCoordinator(backend, { lock: { enabled: true }, acquireDeadlineMs: 100, acquireRetryMs: 1 })
      const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
      const broker = createProjectScopeBroker(coordinator, workspace, createConversationVisibility(coordinator), { async assertIdle() {} })
      const service = { queueState: () => ({ running: false, queued: 0 }), tasks: () => [] } as unknown as SessionService
      const manager = createSessionManagement(coordinator, service, createConversationVisibility(coordinator))
      let observing: Promise<unknown> | undefined, operation: Promise<unknown> | undefined
      try {
        await coordinator.create({ sessionId: 'session' })
        if (!alreadyLive) await coordinator.releaseOwnership('session')
        observing = coordinator.withExistingSessionBindingObservation!({ sessionIds: ['session'] }, async () => { entered.resolve(); await leave.promise })
        await entered.promise
        // Let the observation finish registering its live binding ownership
        // before the writer admission starts: otherwise the admission can race
        // the registration and take the metadata-only path.
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(coordinator.ownerOf('session')).toBe(true)
        let settled = false, observingOutcome: unknown
        const observingSettled = observing.then(() => 'resolved', error => { observingOutcome = error; return 'rejected' })
        operation = action === 'move' ? broker.move('session', undefined, undefined) : manager.mutate('session', 'archive')
        void operation.then(() => { settled = true }, () => { settled = true })
        // The live writer admission revokes the retained original reader and
        // waits for its in-flight read to drain: the operation cannot commit
        // while that read is still active.
        await new Promise(resolve => setTimeout(resolve, 150))
        if (action === 'archive' && !alreadyLive) {
          // An original archive over a reader-only pin flushes through the
          // writer path, which either drains the retained reader here or leaves
          // it untouched before the flush. Both outcomes must release the
          // reader's own pin and never leak live ownership from the archive.
          expect(coordinator.ownerOf('session')).toBe(true)
          const drained = !settled
          leave.resolve()
          expect(await observingSettled).toBe(drained ? 'rejected' : 'resolved')
          await Promise.allSettled([operation])
          expect(coordinator.ownerOf('session')).toBe(false)
        } else {
          // The live writer admission revokes the retained original reader and
          // waits for its in-flight read to drain: the operation cannot commit
          // while that read is still active.
          expect(settled).toBe(false)
          expect(coordinator.ownerOf('session')).toBe(true)
          leave.resolve()
          expect(await observingSettled).toBe('rejected')
          expect(String(observingOutcome)).toMatch(/revoked|current|changed|unavailable/i)
          await operation
          expect(coordinator.ownerOf('session')).toBe(alreadyLive)
          if (alreadyLive) await expect(foreign.adoptOwnership('session')).rejects.toThrow()
          else { await foreign.adoptOwnership('session'); await foreign.releaseOwnership('session') }
        }      } finally {
        leave.resolve()
        await Promise.allSettled([observing, operation])
        await broker.close(); await coordinator.close(); await foreign.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
