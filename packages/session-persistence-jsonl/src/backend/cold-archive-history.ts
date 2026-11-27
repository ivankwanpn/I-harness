import { createHash } from 'node:crypto'
import type { ColdArchiveHistoryReader } from '@i-harness/session-persistence/internal/archive-read'
import type { SessionMeta } from '@i-harness/session-persistence'
import { CURRENT_FORMAT_VERSION, SESSION_HISTORY_LIMIT, freezeJsonData, type JournalPrefix, type SessionEvent } from '@i-harness/core-session'
import type { createArchiveReadOwner } from './archive-read-owner.ts'
import { readSessionArchive } from './archive-reader.ts'
import { ArchiveEvidenceMismatch, type VerifiedArchiveBody } from './verified-archive-body.ts'

interface ColdEvidence {
  readonly sessionId: string
  readonly generation: object
  readonly extent: number
  readonly dev: bigint
  readonly ino: bigint
  readonly headerDigest: string
  readonly verified: VerifiedArchiveBody
}
export const MAX_PREPARED_HISTORY_BYTES = 8 * 1024 * 1024
export const MAX_PREPARED_HISTORY_EVENTS = 16_384
export interface PreparedArchiveHistory {
  readonly sessionId: string
  readonly size: number
  readonly dev: bigint
  readonly ino: bigint
  readonly headerDigest: string
  readonly bodyDigest: string
  readonly prefix: Readonly<JournalPrefix>
  readonly events: SessionEvent[]
}
class HistoryPreparationUnavailable extends Error {}

/** The exact constructor's native archive reader. Proofs retain coordinates
 * only and have no authority beyond the original backend's read admission. */
export function createColdArchiveHistoryReader(options: {
  archive: ReturnType<typeof createArchiveReadOwner>
  assertOriginal(): void
  file(sessionId: string): string
  checkDeleted(sessionId: string): Promise<void>
  qualify(sessionId: string, prefix: { header: SessionMeta; birth: Buffer }): Promise<void>
  prepareHistory?(history: PreparedArchiveHistory): void
}): ColdArchiveHistoryReader {
  const { archive } = options
  const evidenceRecords = new WeakMap<object, ColdEvidence>()
  function currentGeneration() {
    options.assertOriginal()
    return archive.publicReadGeneration()
  }
  function assertCurrent(generation: object) {
    if (currentGeneration() !== generation) throw new Error('ARCHIVE_READ_UNAVAILABLE')
  }
  function observe(sessionId: string, generation: object, prepared: boolean) {
    return async (handle: Parameters<typeof readSessionArchive>[0], extent: number, identity: { dev: bigint; ino: bigint }) => {
      if (prepared && extent >= MAX_PREPARED_HISTORY_BYTES) throw new HistoryPreparationUnavailable()
      const result = await readSessionArchive(handle, extent, false, async prefix => {
        await options.qualify(sessionId, prefix)
        const { header } = prefix
        if (prepared && (header.formatVersion !== CURRENT_FORMAT_VERSION || !header.journal ||
            header.journal.legacyEventCount || header.journal.legacyBodyBytes || header.journal.separatorBytes ||
            header.semanticSeed || header.parentSession !== undefined || header.seedLength !== undefined ||
            header.origin === 'fork' || header.forkPublication !== undefined)) throw new HistoryPreparationUnavailable()
      }, undefined, true)
      await options.checkDeleted(sessionId)
      const physical: ColdEvidence | undefined = result.verified ? {
        sessionId, generation, extent, dev: identity.dev, ino: identity.ino,
        headerDigest: createHash('sha256').update(result.birth).digest('hex'), verified: result.verified,
      } : undefined
      return { version: result.header.formatVersion, events: result.events, meta: result.header, physical, originalDecode: result.originalDecode }
    }
  }
  function retainEvidence(physical: ColdEvidence) {
    const evidence = Object.freeze({})
    evidenceRecords.set(evidence, Object.freeze(physical))
    return evidence
  }

  return Object.freeze({
    async readSealedHistory(sessionId: string) {
      const generation = currentGeneration()
      await options.checkDeleted(sessionId)
      assertCurrent(generation)
      const history = await archive.runSealed(options.file(sessionId), async (handle, extent) => {
        let prefix: Readonly<JournalPrefix> | undefined
        const decoded = await readSessionArchive(handle, extent, false, value => options.qualify(sessionId, value),
          undefined, false, value => { prefix = value })
        await options.checkDeleted(sessionId)
        assertCurrent(generation)
        if (!prefix || decoded.header.sessionId !== sessionId) return undefined
        return { version: decoded.header.formatVersion, meta: decoded.header, events: decoded.events, prefix }
      }, sessionId)
      assertCurrent(generation)
      return history
    },

    async readFull(sessionId: string) {
      const generation = currentGeneration()
      await options.checkDeleted(sessionId)
      assertCurrent(generation)
      const observed = await archive.run(options.file(sessionId), observe(sessionId, generation, false), false, sessionId)
      assertCurrent(generation)
      const { physical, originalDecode: _originalDecode, ...result } = observed
      if (!physical) return result
      return { ...result, evidence: retainEvidence(physical) }
    },

    async readFullForHistoryPage(sessionId: string) {
      if (!options.prepareHistory) return undefined
      const generation = currentGeneration()
      await options.checkDeleted(sessionId)
      assertCurrent(generation)
      const observed = await archive.runSealed(options.file(sessionId), observe(sessionId, generation, true), sessionId)
        .catch((error: unknown) => {
          if (error instanceof HistoryPreparationUnavailable) return undefined
          throw error
        })
      assertCurrent(generation)
      if (!observed) return undefined
      const { physical, originalDecode, ...result } = observed
      if (!physical) return result
      const evidence = retainEvidence(physical)
      if (!originalDecode || observed.meta.sessionId !== sessionId || result.events.length > MAX_PREPARED_HISTORY_EVENTS)
        return { ...result, evidence }
      // No caller can mutate decoded payloads before the one-shot handoff.
      // The owning page planner detaches the bounded returned page.
      freezeJsonData(result.events)
      let available = true
      return { ...result, evidence, retainDecoded() {
        if (!available) return
        available = false
        assertCurrent(generation)
        options.prepareHistory!({
          sessionId, size: physical.extent, dev: physical.dev, ino: physical.ino,
          headerDigest: physical.headerDigest, bodyDigest: physical.verified.digest,
          prefix: physical.verified.prefix, events: result.events,
        })
      } }
    },

    async readWindow(sessionId: string, evidence: object, ordinals: ReadonlySet<number>) {
      const generation = currentGeneration()
      const proof = evidenceRecords.get(evidence)
      if (!proof || proof.sessionId !== sessionId || proof.generation !== generation) return undefined
      // Read a page and at most one earlier image admission per page event.
      const requested = new Set<number>()
      for (const seq of ordinals) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq >= proof.verified.prefix.eventCount || requested.size >= 2 * SESSION_HISTORY_LIMIT) {
          throw new RangeError('Invalid cold history window coordinates')
        }
        requested.add(seq)
      }
      await options.checkDeleted(sessionId)
      assertCurrent(generation)
      try {
        const events = await archive.runSealed(options.file(sessionId), async (handle, extent, identity) => {
          if (extent !== proof.extent || identity.dev !== proof.dev || identity.ino !== proof.ino) return undefined
          const selected = await readSessionArchive(handle, extent, false, prefix => options.qualify(sessionId, prefix), {
            ordinals: requested, prefix: proof.verified.prefix, verified: proof.verified,
            coldHeaderDigest: proof.headerDigest, assertCurrent: () => assertCurrent(generation),
          })
          await options.checkDeleted(sessionId)
          return selected.events
        }, sessionId)
        assertCurrent(generation)
        if (!events) evidenceRecords.delete(evidence)
        return events
      } catch (error) {
        if (!(error instanceof ArchiveEvidenceMismatch)) throw error
        assertCurrent(generation)
        evidenceRecords.delete(evidence)
        return undefined
      }
    },
  })
}
