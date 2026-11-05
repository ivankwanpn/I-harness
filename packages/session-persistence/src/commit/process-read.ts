import { freezeJsonData, type SessionEventView } from '@i-harness/core-session'
import type { CommitLog } from '@i-harness/session-commit-log'
import type { ObservedDocument, SessionMeta } from '../coordinator/types.ts'
import type { ProcessReadInitial, ProcessReadObservation, ProcessReadOptions, ProcessReadUpdate } from '../coordinator/process-read-owner.ts'
import { buildSession, guardIgnorable, preflightSessionFormat } from '../format/validation.ts'

export type CommitProcessReadPorts = {
  readonly open: (sessionId: string) => Promise<CommitLog>
  readonly getDocument: (key: string) => Promise<unknown | undefined>
  readonly metaOf: (log: CommitLog) => SessionMeta
}

const unavailable = () => new Error('PROCESS_READ_UNAVAILABLE')

function observeDocument(value: unknown): ObservedDocument {
  return value === undefined ? { kind: 'absent' } : { kind: 'present', value }
}

export async function withCommitProcessReadObservation<T, U>(
  ports: CommitProcessReadPorts,
  id: string,
  options: ProcessReadOptions,
  work: (observation: ProcessReadObservation) => Promise<T>,
  publish: (candidate: T, observation: ProcessReadObservation, last: ProcessReadUpdate) => Promise<U>,
): Promise<U> {
  const keys = [...new Set(options.documentKeys)]
  if (keys.length > 32 || keys.some(key => typeof key !== 'string')) throw new TypeError('Invalid process read document keys')
  const log = await ports.open(id)
  let active = true
  try {
    const meta = ports.metaOf(log)
    const raw = log.view().entries.map(event => ({ ...event }))
    preflightSessionFormat(meta.formatVersion, raw, meta)
    if (guardIgnorable(raw.map(event => ({ ...event }))).length !== raw.length) throw unavailable()
    const captured = freezeJsonData(raw) as readonly SessionEventView[]
    const session = freezeJsonData(buildSession(meta, raw)) as never
    const documents = new Map<string, ObservedDocument>()
    for (const key of keys) documents.set(key, observeDocument(await ports.getDocument(key)))
    const initial: ProcessReadInitial = Object.freeze({ session, highWater: captured.length, documents })
    let delivered = captured.length
    let checking = false
    const assertCurrent = () => { if (!active || !log.open) throw unavailable() }
    const observation: ProcessReadObservation = Object.freeze({
      initial,
      async check() {
        if (this !== observation || !active || checking) throw unavailable()
        checking = true
        try {
          assertCurrent()
          await log.refresh()
          assertCurrent()
          const current = log.view().entries.map(event => ({ ...event })) as SessionEventView[]
          if (current.length < captured.length) throw unavailable()
          for (let index = 0; index < captured.length; index++) {
            if (JSON.stringify(current[index]) !== JSON.stringify(captured[index])) throw unavailable()
          }
          if (current.length === delivered) return Object.freeze({ kind: 'unchanged' as const, highWater: delivered })
          const suffix = freezeJsonData(current.slice(delivered).map(event => ({ ...event }))) as readonly SessionEventView[]
          const update: ProcessReadUpdate = Object.freeze({ kind: 'suffix' as const, from: delivered, to: current.length, events: suffix })
          delivered = current.length
          return update
        } finally { checking = false }
      },
      assertCurrent() { if (this !== observation) throw new TypeError('Invalid observation receiver'); assertCurrent() },
    })
    const candidate = await work(observation)
    assertCurrent()
    const last = await observation.check()
    assertCurrent()
    const result = await publish(candidate, observation, last)
    assertCurrent()
    return result
  } finally {
    active = false
    await log.close().catch(() => {})
  }
}
