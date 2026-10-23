import { randomUUID } from 'node:crypto'
import type { FsWatchService } from '@i-harness/fs-watch'
import type { InstructionObservationPort, InstructionPendingWrite, InstructionScope } from '../contracts.ts'
import { frozen, paths, scopeData } from '../discovery.ts'
import { createObservationRoutes, type PortControl } from './watch.ts'

export interface InstructionPendingLease { readonly id: string; settle(): void }
export interface InstructionObservationOwner {
  port(scope: InstructionScope): InstructionObservationPort
  beginPending(paths: readonly string[]): InstructionPendingLease
  close(): Promise<void>
}

/** Host capability only. Tokens describe outstanding native mutations; they
 * grant no execution permission and are never accepted from model output. */
export function createInstructionObservationOwner(watch: FsWatchService): InstructionObservationOwner {
  const routes = createObservationRoutes(watch), ports = new Set<PortControl>(), pending = new Map<string, InstructionPendingWrite>()
  let closed = false, closing: Promise<void> | undefined
  const notify = (changed: readonly string[]) => { for (const port of [...ports]) port.pendingChanged(changed) }
  return Object.freeze({
    port(input: InstructionScope) {
      if (closed) throw new Error('Instruction observation owner closed')
      const port = routes.port(scopeData(input), () => [...pending.values()], () => ports.delete(port)); ports.add(port)
      return port.port
    },
    beginPending(input: readonly string[]) {
      if (closed) throw new Error('Instruction observation owner closed')
      if (!Array.isArray(input) || input.length > 256 || pending.size >= 256) throw new Error('Instruction pending capacity exceeded')
      const normalized = frozen(paths(input)), id = randomUUID()
      pending.set(id, frozen({ id, paths: normalized })); notify(normalized)
      let settled = false
      return Object.freeze({ id, settle() {
        if (settled) return
        settled = true
        if (closed) return
        pending.delete(id); notify(normalized)
      } })
    },
    close() {
      if (closing) return closing
      closed = true
      const active: Promise<void>[] = []
      // Reserve the join before a terminal port callback can reenter owner.close.
      closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(active)
        const routed = await Promise.allSettled([routes.close()])
        const failures = [...results, ...routed].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        pending.clear()
        if (failures.length) throw new AggregateError(failures, 'Instruction observation owner cleanup failed')
        ports.clear()
      })
      // Fence every port synchronously before joining any asynchronous cleanup.
      active.push(...[...ports].map(port => port.close()))
      void closing.catch(() => { closing = undefined })
      return closing
    },
  })
}
