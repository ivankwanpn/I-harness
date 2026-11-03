import { types } from 'node:util'
import {composeOriginalCurrentnessGuards,runUnassociatedCurrentnessChecks} from './currentness-guards.ts'
import { isOriginalCapturedFactGroup, type CapturedFactGroup } from './groups.ts'
import type { CapturedActionFact } from './ports.ts'
import type { FactOutcome, SessionEventView, FactReceipt } from './types.ts'

interface CaptureRecord {
  identity?:object
  source:object
  current(): void
  active: boolean
  sourceReleased: boolean
  pins: number
  releaseIfDone(): void
  reference: WeakRef<CaptureRecord>
  members?: readonly SessionEventView[]
  outcome?: FactOutcome
}
const captures = new WeakMap<object, CaptureRecord>()
const expired = (): never => { throw new TypeError('Original capture obligation released') }

export function readAcknowledgedExecutionMembers(capture: object, outcome: FactOutcome): readonly SessionEventView[] {
  const record = captures.get(capture)
  if (!record?.active || record.outcome !== outcome || outcome.kind !== 'committed' || !record.members) {
    throw new TypeError('Original acknowledged capture required')
  }
  record.current()
  return record.members
}

/** Retain an actual instruction/body obligation before its source releases.
 * This passive pin neither owns a new action nor consults an optional lease. */
export function retainAcknowledgedExecutionMembers(capture: object, outcome: FactOutcome) {
  readAcknowledgedExecutionMembers(capture, outcome)
  const record = captures.get(capture)!
  if (record.sourceReleased) throw new TypeError('Original capture source released')
  record.pins++
  let released = false
  const assert = () => {
    if (released || !record.active) expired()
    record.current()
  }
  const pin = Object.freeze({
    get members() { assert(); return record.members! },
    assertCurrent() {
      if (this !== pin) throw new TypeError('Original capture pin required')
      assert()
    },
    release() {
      if (this !== pin) throw new TypeError('Original capture pin required')
      if (released) return
      released = true
      record.pins--
      record.releaseIfDone()
    },
  })
  return pin
}

/** Construct the actual frozen handle. An incoming methods dictionary is never
 * itself associated as a capture, so copied wrappers/DTOs gain no membership. */
function constructHandle<T extends CapturedActionFact>(commands: T, current: () => void): T {
  if (!commands || types.isProxy(commands) || Object.getPrototypeOf(commands) !== Object.prototype) {
    throw new TypeError('Original capture commands required')
  }
  const names = Reflect.ownKeys(commands)
  const required = ['admit', 'observe', 'reconcile']
  if (required.some(name => !names.includes(name)) || names.some(name => typeof name !== 'string' || ![...required, 'retryAbsent'].includes(name))) {
    throw new TypeError('Closed original capture commands required')
  }
  const fields = Object.getOwnPropertyDescriptors(commands)
  if (Object.values(fields).some(field => !('value' in field) || !field.enumerable || typeof field.value !== 'function' || types.isProxy(field.value))) {
    throw new TypeError('Original capture data methods required')
  }
  const handle: { [key: string]: () => Promise<FactOutcome> } = {}
  for (const name of names as string[]) {
    const method = fields[name]!.value as () => Promise<FactOutcome>
    handle[name] = function () {
      if (this !== handle) throw new TypeError('Original capture receiver required')
      current()
      return Reflect.apply(method, commands, [])
    }
  }
  Object.freeze(commands)
  // Every own key and method was checked above; the new handle preserves those
  // exact method results while closing receiver and mutation boundaries.
  return Object.freeze(handle) as unknown as T
}

/** Original producer component. Source lists are WEAK: a long-lived received
 * input source cannot retain every completed capture and its historical body.
 * Live handles retain their record; explicit pins retain theirs independently. */
export function isExecutionMemberOf(capture:object,identity:object){return captures.get(capture)?.identity===identity}
export function isExecutionCaptureSource(capture:object,source:object){return captures.get(capture)?.source===source}
export function createExecutionMemberOwner(assertHeld: () => void,identity?:object) {
  const groups = new WeakMap<CapturedFactGroup, Set<CaptureRecord>>()
  const sources = new WeakMap<object, Set<WeakRef<CaptureRecord>>>()
  const active = new Set<WeakRef<CaptureRecord>>()
  const forwarded = new WeakSet<object>()
  const installed = new WeakMap<CapturedFactGroup, { members: readonly SessionEventView[]; receipt: FactReceipt }>()

  function release(record: CaptureRecord) {
    record.active = false
    record.members = undefined
    record.outcome = undefined
    record.current = expired
    record.releaseIfDone = expired
    active.delete(record.reference)
  }
  return {
    capture<T extends CapturedActionFact>(group: CapturedFactGroup, commands: T, source: object, assertSource: () => void): T {
      assertHeld()
      if (!isOriginalCapturedFactGroup(group)) throw new TypeError('Original captured group required')
      const record: CaptureRecord = {
        identity,source,
        active: true, pins: 0, sourceReleased: false, reference: undefined!,
        current: composeOriginalCurrentnessGuards(assertHeld,assertSource) ?? (() => runUnassociatedCurrentnessChecks(assertHeld,assertSource)),
        releaseIfDone() {
          if (!record.sourceReleased || record.pins) return
          const records = groups.get(group)
          records?.delete(record)
          if (!records?.size) { groups.delete(group); installed.delete(group) }
          release(record)
        },
      }
      record.current()
      const handle = constructHandle(commands, () => {
        if (!record.active) expired()
        record.current()
      })
      record.reference = new WeakRef(record)
      captures.set(handle, record)
      active.add(record.reference)
      let records = groups.get(group)
      if (!records) { records = new Set(); groups.set(group, records) }
      records.add(record)
      let owned = sources.get(source)
      if (!owned) { owned = new Set(); sources.set(source, owned) }
      owned.add(record.reference)
      return handle
    },
    forward<T extends CapturedActionFact>(original: CapturedActionFact, commands: T): T {
      assertHeld()
      const record = captures.get(original)
      if (!record || !active.has(record.reference) || record.sourceReleased || forwarded.has(original)) {
        throw new TypeError('Original same-owner capture wrapper required')
      }
      record.current()
      const handle = constructHandle(commands, () => {
        if (!record.active) expired()
        record.current()
      })
      captures.set(handle, record)
      forwarded.add(original)
      return handle
    },
    installed(group: CapturedFactGroup, members: readonly SessionEventView[], receipt: FactReceipt) {
      const prior = installed.get(group)
      if (prior) {
        if (prior.receipt !== receipt || prior.members.length !== members.length || prior.members.some((event, index) => event !== members[index])) {
          throw new TypeError('Installed capture changed')
        }
        return
      }
      installed.set(group, { members, receipt })
    },
    acknowledge(group: CapturedFactGroup, outcome: FactOutcome) {
      assertHeld()
      const actual = installed.get(group)
      if (!actual || outcome.kind !== 'committed' || outcome.receipt !== actual.receipt || outcome.seqs.length !== actual.members.length || outcome.seqs.some((seq, index) => seq !== actual.members[index]!.seq)) {
        throw new TypeError('Original installed capture outcome required')
      }
      for (const record of groups.get(group) ?? []) {
        if (!record.active) continue
        record.current()
        if (record.outcome && record.outcome !== outcome) throw new TypeError('Acknowledged capture outcome changed')
        record.members = actual.members
        record.outcome = outcome
      }
    },
    releaseSource(source: object) {
      const records = sources.get(source)
      if (!records) return
      for (const reference of records) {
        const record = reference.deref()
        if (record) { record.sourceReleased = true; record.releaseIfDone() }
      }
      records.clear()
      sources.delete(source)
    },
    assertReleased() {
      for (const reference of active) {
        if (reference.deref()?.active) throw new TypeError('Original capture obligations still retained')
        active.delete(reference)
      }
    },
    close() { this.assertReleased() },
  }
}
