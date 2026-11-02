import { subscribeManagedExecution, type ManagedExecutionDomain } from '@i-harness/core-session/internal/execution'
import type { CodeModeFactOwner } from './facts.ts'
import { captureLegacyFact, isStrictFactData, committedFactSeqs, FactRecoveryRequiredError, subscribe, type CodeSettlementFact, type FactOwner, type ManagedAction, type ProducerFactOutcome, type SessionEvent, type SettlementFacts, type SettlementOwnerProgress } from '@i-harness/core-session'
import { callback, readCut, sameCut, type CellFacts, type Pending } from './event-facts/state.ts'
import { createOutputQueue, recoveryError } from './event-facts/queue.ts'

/** A mount owns one ordered queue. Each actual admission retains its one
 * original output source until its terminal has synchronously sealed it. */
export function createCodeModeEventFacts(owner: CodeModeFactOwner, drainProducers: () => Promise<void>, onObservationChange?: () => void, committedDescriptor?: { retains(cellId:string):boolean; commit(record:object):Promise<void> }, domain?:ManagedExecutionDomain) {
  if(domain&&domain.owner!==owner)throw TypeError('Original private Code owner required')
  const cells = new Map<string, CellFacts>(), pending = new Set<Pending>()
  const admissionHolds = new Map<string, { action?: ManagedAction<ProducerFactOutcome> }>()
  type Notification = { state: 'running' | 'succeeded' | 'failed'; reason?: unknown }
  const held = new Set<CellFacts>(), failedAdmissions = new Map<string, WeakMap<() => void, Notification>>()
  // Only unresolved joins retain listeners. Settled admissions keep the existing
  // scalar deduplication marker; weak callback bookkeeping retains no payload.
  type Notice = { settled: boolean; listeners: Set<() => void>; failure?: { reason: unknown } }
  const admissionNotices = new Map<string, Notice>()
  const notify = (cellId: string, listener: () => void) => {
    const calls = failedAdmissions.get(cellId)!
    const prior = calls.get(listener)
    if (prior?.state === 'failed') throw prior.reason
    if (prior?.state === 'succeeded') return
    if (prior) throw new FactRecoveryRequiredError()
    const call: Notification = { state: 'running' }
    calls.set(listener, call)
    try { listener(); call.state = 'succeeded' }
    catch (reason) { call.state = 'failed'; call.reason = reason; throw reason }
  }
  const settleNotice = (cellId: string, notice: Notice) => {
    if (notice.failure) throw notice.failure.reason
    notice.settled = true
    try {
      for (const listener of notice.listeners) { notify(cellId, listener); notice.listeners.delete(listener) }
      if (admissionNotices.get(cellId) === notice) admissionNotices.delete(cellId)
    } catch (reason) { notice.failure = { reason }; throw reason }
  }
  let retired = false, stickyRecovery = false, admitting = 0, driveSerial = Promise.resolve()
  const changed = () => { try { onObservationChange?.() } catch { /* Passive observers cannot fail producers. */ } }
  const requireRecovery = () => { stickyRecovery = true; changed(); source.requireRecovery() }
  const observationState = (): 'available' | 'unavailable' | 'retired' => retired ? 'retired' : stickyRecovery || admitting || pending.size || held.size || admissionHolds.size ? 'unavailable' : 'available'
  const queue = createOutputQueue({ changed, owner: committedDescriptor ? owner : undefined, domain,
    failed(record, reason) {
      const cell = record.cell ?? record.actionCell
      if (cell) {
        cell.failed = true; cell.errors.push(reason); cell.revision++
        cell.fail(reason)
        if (!record.cellClosed) cell.source.requireRecovery()
      }
      requireRecovery()
    },
    hold(record) {
      const cell = record.kind === 'output' ? record.cell : undefined
      if (cell) { cell.recoveryRecords.add(record); cell.revision++; cell.holdEpoch++; cell.held = true; held.add(cell); cell.source.holdRecovery() }
      // Ordinary mount records have frozen DTOs and original native captures.
      // Native pending/quarantine fences their uncertain receipts; an extra
      // mount hold has no checkpoint release path. Store refusal likewise
      // stays queued without becoming an output-source hold obligation.
      changed()
    },
    completed(record) {
      pending.delete(record)
      const cell = record.cell
      if (record.kind === 'output' && cell) { cell.outputs.delete(record); cell.recoveryRecords.delete(record); cell.revision++ }
      changed()
    },
  })
  const enroll = (record: Pick<Pending, 'kind'> & Partial<Pending>) => {
    const enrolled = queue.enroll({ attempted: false, disposed: false, cancelled: false, settled: false, commit: callback(), cancel: callback(), settle: callback(), ...record })
    if (committedDescriptor && record.expectedMember && committedDescriptor.retains(record.expectedMember.cellId)) {
      const token=(record.action??record.cell?.action??mountAction).owner
      if(token)enrolled.expectedOwner=Object.freeze({sessionId:token.sessionId,incarnation:token.incarnation})
      enrolled.descriptor = () => committedDescriptor.commit(enrolled)
    }
    pending.add(enrolled); return enrolled
  }
  const settle = async (cell: CellFacts): Promise<SettlementOwnerProgress> => {
    if (cell.failed) throw recoveryError(cell.errors)
    if (!cell.outputs.size) return { kind: 'advanced' }
    const result = await queue.pump(cell)
    if (cell.failed) throw recoveryError(cell.errors)
    if (!cell.outputs.size) return { kind: 'advanced' }
    return { kind: 'blocked', reason: result.kind === 'blocked' ? result.reason : new FactRecoveryRequiredError() }
  }
  const refresh = (): Promise<void> => {
    const run = driveSerial.then(async () => {
      for (;;) {
        const result = await queue.pump()
        if (result.kind === 'close-cell') {
          await result.cell.source.close()
          held.delete(result.cell); result.cell.held = false; changed()
          queue.releaseTerminal(result.record)
          continue
        }
        // A callback may append an original Store beyond this pump's fixed
        // watermark. Give that queued head its real first attempt under the
        // still-held output epoch before asking a checkpoint to release it.
        if (result.kind === 'idle' && queue.hasPending()) continue
        let released = false
        for (const cell of [...held]) if (!cell.recoveryRecords.size && !cell.failed) {
          const epoch = cell.holdEpoch
          await cell.source.checkpoint()
          if (epoch === cell.holdEpoch) { held.delete(cell); cell.held = false; changed(); released = true }
        }
        if (released) continue
        if (result.kind === 'blocked') throw recoveryError([result.reason])
        if (!queue.hasPending()) {
          for (const notice of admissionNotices.values()) if (notice.failure) throw recoveryError([notice.failure.reason])
          return
        }
      }
    })
    driveSerial = run.catch(() => {})
    return run
  }
  const drain = async () => {
    // Settle eligible original prerequisites before joining producers. A live
    // cell's close waits for the producer's terminal seal, so initiate producer
    // cancellation before asking those unsealed sources to close.
    await refresh()
    await drainProducers()
    await refresh()
  }
  const mountAction = owner.beginAction(), source = mountAction.registerSettlementSource(drain)
  mountAction.finish()
  const listener=()=>{if(pending.size)void refresh().catch(()=>{})}
  const off = domain ? subscribeManagedExecution(domain,listener) : subscribe((owner as FactOwner).view,listener)
  const seal = (cell: CellFacts) => { if (!cell.sealed) { cell.sealed = true; cell.revision++; cell.sealNow() } }
  const required = (event: CodeSettlementFact, onCommit?: () => void, failedAdmission = false, onSettled?: () => void) => {
    if (!isStrictFactData(event)) { requireRecovery(); throw new FactRecoveryRequiredError() }
    const original = captureLegacyFact(event)
    if (original.kind !== 'captured') { requireRecovery(); throw new FactRecoveryRequiredError() }
    const captured = original.value, cell = captured.type === 'code/cell' ? cells.get(captured.cellId) : undefined
    // The existing admission handler may report the same original failure.
    // Keep its already-enqueued interrupted fact instead of allocating another.
    if (!failedAdmission && captured.type === 'code/cell' && captured.state === 'interrupted' && failedAdmissions.has(captured.cellId)) {
      let notice = admissionNotices.get(captured.cellId)
      if (notice?.failure) throw recoveryError([notice.failure.reason])
      if (onSettled) {
        if (!notice) {
          notice = { settled: true, listeners: new Set() }
          admissionNotices.set(captured.cellId, notice)
        }
        notice.listeners.add(onSettled)
        if (notice.settled) {
          try { settleNotice(captured.cellId, notice) }
          catch (reason) {
            // A late join has no queued record left to quarantine for it. Keep
            // that notification debt, preserving even a falsey primary reason.
            try { requireRecovery() } catch { /* Already closed; retain the original callback failure. */ }
            throw recoveryError([reason])
          }
        }
      }
      return refresh()
    }
    if (cell?.terminal) throw new FactRecoveryRequiredError()
    const admission = captured.type === 'code/cell' ? admissionHolds.get(captured.cellId) : undefined
    const record = enroll({ kind: captured.type === 'code/cell' ? 'terminal' : 'required', cell, source, expectedMember:Object.freeze({type:captured.type,cellId:captured.cellId}),
      prepare: async () => captured, commit: callback(onCommit), settle: callback(() => {
        if (captured.type === 'code/cell') {
          const admittedAction = cell?.action ?? admission?.action
          admittedAction?.finish()
          if (cells.get(captured.cellId) === cell) cells.delete(captured.cellId)
          if (admissionHolds.get(captured.cellId) === admission) admissionHolds.delete(captured.cellId)
        }
        onSettled?.()
        if (captured.type === 'code/cell') {
          const notice = admissionNotices.get(captured.cellId)
          if (notice) settleNotice(captured.cellId, notice)
        }
      }),
    })
    if (cell) { cell.terminal = record; seal(cell) }
    changed(); return refresh()
  }
  return {
    source, refresh, observationState, requireRecovery,
    privateCellAction(id:string){if(!domain)throw Error('Original private Code cell required');const cell=cells.get(id);if(!cell||cell.sealed)throw Error('Original private Code cell unavailable');cell.source.assertHeld();cell.action.assertOpen();return cell.action as ManagedAction<import('@i-harness/core-session').FactOutcome>},
    assertHeld() { source.assertHeld() },
    requiredPrepared(cellId: string, prepare: (assertHeld: () => void) => Promise<CodeSettlementFact>, onCommit?: () => void) {
      const cell = cells.get(cellId)
      if (!cell || cell.sealed) throw new FactRecoveryRequiredError()
      const record = enroll({ kind: 'output', cell, source: cell.source, expectedMember:Object.freeze({type:'code/output',cellId}), prepare: () => prepare(cell.source.assertHeld), commit: callback(onCommit) })
      cell.outputs.add(record); cell.revision++; changed()
      return refresh()
    },
    captureReference(ref: Extract<SessionEvent, { type: 'context/result-ref' }>['ref']) {
      const captured = captureLegacyFact({ type: 'context/result-ref' as const, ignorable: true as const, ref })
      if (captured.kind !== 'captured') { requireRecovery(); throw new FactRecoveryRequiredError() }
      const record = enroll({ kind: 'reference', source, capture: () => source.retention.capture(captured.value) })
      changed(); return async () => { if (!record.settled) await refresh() }
    },
    required(event: CodeSettlementFact, onCommit?: () => void, onSettled?: () => void) { return required(event, onCommit, false, onSettled) },
    async optional(event: Extract<SessionEvent, { type: 'code/cell' }>, signal?: AbortSignal) {
      if (cells.has(event.cellId)) throw new FactRecoveryRequiredError()
      admitting++; changed()
      const admission: { action?: ManagedAction<ProducerFactOutcome> } = {}
      let cell: CellFacts | undefined
      try {
        failedAdmissions.delete(event.cellId)
        const action = owner.beginAction(signal), sealGate = Promise.withResolvers<void>(), failure = Promise.withResolvers<never>()
        // Observe the original failure promise before any producer/callback
        // can reject it; lifecycle still races the same retained promise.
        void failure.promise.catch(() => {})
        admission.action = action
        cell = { action, source: undefined as unknown as SettlementFacts<ProducerFactOutcome>, outputs: new Set(), recoveryRecords: new Set(), revision: 0, holdEpoch: 0, held: false, sealed: false, seal: sealGate.promise, sealNow: () => sealGate.resolve(), failure: failure.promise, fail: reason => failure.reject(reason), failed: false, errors: [] }
        const original = cell
        cell.source = action.registerSettlementSource(async () => {
          // Failure wakes an existing unsealed wait by rejection. Only the
          // actual terminal enqueue can fulfill the successful seal branch.
          await Promise.race([original.seal, original.failure])
          const result = await settle(original)
          if (result.kind === 'blocked') throw recoveryError([result.reason])
        }, undefined, { readCut: () => readCut(original), isCurrent: cut => sameCut(original, cut), settle: () => settle(original) })
        cells.set(event.cellId, cell)
        committedFactSeqs(await action.facts.code.record(event))
      } catch (error) {
        admissionHolds.set(event.cellId, admission)
        failedAdmissions.set(event.cellId, new WeakMap())
        admissionNotices.set(event.cellId, { settled: cell?.terminal?.settled ?? false, listeners: new Set() })
        if (cell?.terminal?.settled) admissionNotices.delete(event.cellId)
        if (!cell?.terminal) void required({ ...event, state: 'interrupted', error: 'Code Mode admission did not complete' }, undefined, true).catch(() => {})
        throw error
      } finally { admitting--; changed() }
    },
    async store(event: Extract<SessionEvent, { type: 'code/store' }>, onCommit: () => void, onCancelled: () => void) {
      const cell = cells.get(event.cellId)
      if (!cell || cell.sealed) throw new FactRecoveryRequiredError()
      const record = enroll({ kind: 'store', action: cell.action, actionCell: cell, fact: cell.action.captureCodeStore(event), source:cell.source, expectedMember:Object.freeze({type:'code/store',cellId:event.cellId}), commit: callback(onCommit), cancel: callback(onCancelled) })
      changed()
      try { await refresh() } catch (reason) { if (!record.settled) throw record.failure ? record.failure.reason : reason }
    },
    stopOptional() { for (const cell of cells.values()) cell.action.stop() },
    assertObserved() { if (pending.size || admissionNotices.size) throw new FactRecoveryRequiredError() },
    async close() { if (!retired) { retired = true; changed() }; await source.close(); off() },
  }
}



