import { createHash } from 'node:crypto'
import { CommitLogNotFoundError } from '@i-harness/session-commit-log'
import { canonicalJsonData } from '@i-harness/core-session'
import {
  SessionBindingObservationError,
  type ExistingSessionBindingObservation,
  type ExistingSessionBindingObservationRequest,
  type ObservedDocument,
  type SessionBindingObservation,
  type SessionBindingObservationRequest,
  type SessionMeta,
} from '../coordinator/types.ts'

/** v1 binding observations: snapshot metadata (existing sessions) and the
 *  project-binding document (existing sessions and the not-yet-born target) at
 *  open, expose that snapshot to the callback, and re-read before the
 *  callback's result is accepted. Exclusion comes from the commit log itself
 *  (a concurrent birth loses the no-overwrite publication), so the observation
 *  does not hold a lease across the callback. */
export type CommitObservationPorts = {
  profile(sessionId: string): Promise<{ meta: SessionMeta; blank: boolean }>
  getDocument(key: string): Promise<unknown | undefined>
}

const bindingKey = (id: string) => `desktop-session-project-${createHash('sha256').update(id).digest('hex')}`
const MAX_IDS = 64
const ID = /^[^\\/\u0000-\u001f\u007f]{1,256}$/

function captureIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IDS) throw new SessionBindingObservationError('invalid')
  const ids = value.map(id => {
    if (typeof id !== 'string' || !ID.test(id)) throw new SessionBindingObservationError('invalid')
    return id
  })
  if (new Set(ids).size !== ids.length) throw new SessionBindingObservationError('invalid')
  return [...ids].sort()
}

type Observed = { readonly meta: SessionMeta; readonly binding: ObservedDocument }

export type CommitObservations = {
  withExistingSessionBindingObservation<T>(request: ExistingSessionBindingObservationRequest, run: (observation: ExistingSessionBindingObservation) => Promise<T>): Promise<T>
  withSessionBindingObservation<T>(request: SessionBindingObservationRequest, run: (observation: SessionBindingObservation) => Promise<T>): Promise<T>
}

export function createCommitObservations(ports: CommitObservationPorts): CommitObservations {
  const readBinding = async (id: string): Promise<ObservedDocument> => {
    const value = await ports.getDocument(bindingKey(id))
    return value === undefined ? { kind: 'absent' } : { kind: 'present', value }
  }
  const readOne = async (id: string, signal?: AbortSignal): Promise<Observed> => {
    if (signal?.aborted) throw new SessionBindingObservationError('revoked')
    let meta: SessionMeta
    try { ({ meta } = await ports.profile(id)) } catch (error) { if (error instanceof CommitLogNotFoundError) throw new SessionBindingObservationError('unavailable'); throw error }
    if (meta.sessionId !== id || meta.archived === true) throw new SessionBindingObservationError('unavailable')
    const binding = await readBinding(id)
    if (signal?.aborted) throw new SessionBindingObservationError('revoked')
    return { meta, binding }
  }
  const fingerprint = (state: Observed) => canonicalJsonData({ meta: state.meta, binding: state.binding })

  const observe = <T>(
    states: Map<string, Observed>,
    target: { id: string; binding: ObservedDocument } | undefined,
    signal: AbortSignal | undefined,
    run: (observation: { assertCurrent(): void; metadata(id: string): Readonly<SessionMeta>; binding(id: string): ObservedDocument }) => Promise<T>,
  ): Promise<T> => {
    let released = false
    const assertCurrent = () => {
      if (released) throw new SessionBindingObservationError('revoked')
      if (signal?.aborted) throw new SessionBindingObservationError('revoked')
    }
    const observation = Object.freeze({
      assertCurrent,
      metadata(id: string) {
        assertCurrent()
        const state = states.get(id)
        if (!state) throw new SessionBindingObservationError('invalid')
        return state.meta
      },
      binding(id: string) {
        assertCurrent()
        if (target && target.id === id) return target.binding
        const state = states.get(id)
        if (!state) throw new SessionBindingObservationError('invalid')
        return state.binding
      },
    })
    return (async () => {
      const result = await run(observation)
      released = true
      if (signal?.aborted) throw new SessionBindingObservationError('revoked')
      for (const [id, before] of states) {
        const after = await readOne(id, signal)
        if (fingerprint(after) !== fingerprint(before)) throw new SessionBindingObservationError('conflict')
      }
      if (target) {
        const after = await readBinding(target.id)
        if (canonicalJsonData(after) !== canonicalJsonData(target.binding)) throw new SessionBindingObservationError('conflict')
      }
      return result
    })()
  }

  return {
    async withExistingSessionBindingObservation(request, run) {
      const ids = captureIds(request?.sessionIds)
      const states = new Map<string, Observed>()
      for (const id of ids) states.set(id, await readOne(id, request.signal))
      return observe(states, undefined, request.signal, run)
    },
    async withSessionBindingObservation(request, run) {
      const existing = captureIds(request?.existingSessionIds)
      const target = request?.target?.targetSessionId
      if (typeof target !== 'string' || !ID.test(target)) throw new SessionBindingObservationError('invalid')
      const states = new Map<string, Observed>()
      for (const id of existing) states.set(id, await readOne(id, request.signal))
      const binding = await readBinding(target)
      return observe(states, { id: target, binding }, request.signal, run)
    },
  }
}
