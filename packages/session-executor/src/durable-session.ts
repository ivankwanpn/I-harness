import { type SessionView as Session } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { openExecutorDocument } from './lifecycle/managed-document.ts'
import { acquireManagedExecution, type ManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'
import { receivedExecutionInputsFor } from './lifecycle/execution-inputs.ts'

/** Private entry/cache; public Session loaders below remain explicit compatibility. */
export function createExecutorExecutionCache(options: { coordinator: SessionCoordinator; assertOpen?(id: string): void }) {
  type Entry = { execution: ManagedExecutionAttachment; inputs: ReturnType<typeof receivedExecutionInputsFor>; policyFloor: number }
  type Row = { loading?: Promise<Entry>; publication?: Promise<Entry>; execution?:ManagedExecutionAttachment; entry?: Entry; closing: boolean; closed?: boolean; close?: Promise<void> }
  const rows = new Map<string, Row>()
  let closed = false
  const assert = (id: string) => { if(closed)throw Error('Execution cache closed');options.assertOpen?.(id) }
  const cache = {
    get(id: string): Promise<Entry> {
      if(this!==cache)return Promise.reject(new TypeError('Original execution cache required'))
      try { assert(id) } catch(cause) { return Promise.reject(cause) }
      const existing=rows.get(id)
      if(existing)return existing.closing?Promise.reject(Error('Execution entry closed')):existing.publication!
      const row={} as Row;row.closing=false
      rows.set(id,row)
      row.loading=(async()=>{const execution=await acquireManagedExecution(options.coordinator,id)
        row.execution=execution
        if(row.closing||closed){execution.revokeNewWork();throw Error('Execution entry closed')}
        options.assertOpen?.(id)
        const entry=Object.freeze({execution,inputs:receivedExecutionInputsFor(execution),policyFloor:execution.observe().eventCount});row.entry=entry;return entry})()
      row.publication=row.loading.then(entry=>{assert(id);if(row.closing)throw Error('Execution entry closed');return entry})
      void row.publication.catch(()=>{})
      return row.publication
    },
    close(id: string): Promise<void> {
      if(this!==cache)return Promise.reject(new TypeError('Original execution cache required'))
      const row=rows.get(id);if(!row)return Promise.resolve()
      row.closing=true;row.execution?.revokeNewWork()
      if(row.closed)return Promise.resolve()
      if(row.close)return row.close
      const pending=(async()=>{
        try{await row.loading}catch(cause){if(!row.execution)throw cause}
        const execution=row.execution!;execution.revokeNewWork()
        const failures:unknown[]=[]
        try{await row.entry?.inputs.close()}catch(cause){failures.push(cause)}
        try{await execution.close()}catch(cause){failures.push(cause)}
        if(failures.length)throw new AggregateError(failures,'Private execution cleanup incomplete')
        row.closed=true;row.entry=undefined;row.execution=undefined;row.loading=undefined;row.publication=undefined
      })()
      row.close=pending;void pending.catch(()=>{if(row.close===pending)row.close=undefined})
      return pending
    },
    releaseClosed(id:string) { if(this!==cache)throw TypeError('Original execution cache required');const row=rows.get(id);if(!row?.closed)throw Error('Original execution closure not acknowledged');rows.delete(id) },
    async closeAll() { if(this!==cache)throw TypeError('Original execution cache required');closed=true;const results=await Promise.allSettled([...rows.keys()].map(id=>cache.close(id)));const failed=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed.length)throw new AggregateError(failed.map(r=>r.reason),'Execution cache cleanup incomplete') },
  }
  return Object.freeze(cache)
}

// Different adapters in one host share an in-flight owned load. Retaining only
// the promise avoids stale completed caches across an explicit close/reopen.
const pendingLoads = new WeakMap<SessionCoordinator, Map<string, Promise<Session>>>()

/** Build the SessionService.sessionFor adapter for an already-created and
 * already-owned durable session. Restored events are copied without running
 * append hooks; only new live events enter the coordinator write-behind. */
export function createDurableSessionLoader(
  coordinator: SessionCoordinator,
): (sessionId: string) => Promise<Session> {
  return (sessionId: string): Promise<Session> => {
    let loads = pendingLoads.get(coordinator)
    if (!loads) { loads = new Map(); pendingLoads.set(coordinator, loads) }
    const existing = loads.get(sessionId)
    if (existing) return existing
    const entries = loads
    const pending = (async () => {
      return (await openExecutorDocument({ coordinator, sessionId })).session
    })().finally(() => { if (entries.get(sessionId) === pending) entries.delete(sessionId) })
    entries.set(sessionId, pending)
    return pending
  }
}
