import { createHash } from 'node:crypto'
import type { ColdArchiveHistoryReader } from '@i-harness/session-persistence/internal/archive-read'
import type { SessionMeta } from '@i-harness/session-persistence'
import { SESSION_HISTORY_LIMIT } from '@i-harness/core-session'
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

/** The exact constructor's native archive reader. Proofs retain coordinates
 * only and have no authority beyond the original backend's read admission. */
export function createColdArchiveHistoryReader(options: {
  archive: ReturnType<typeof createArchiveReadOwner>
  assertOriginal(): void
  file(sessionId: string): string
  checkDeleted(sessionId: string): Promise<void>
  qualify(sessionId: string, prefix: { header: SessionMeta; birth: Buffer }): Promise<void>
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

  return Object.freeze({
    async readFull(sessionId: string) {
      const generation = currentGeneration()
      await options.checkDeleted(sessionId)
      assertCurrent(generation)
      const observed = await archive.run(options.file(sessionId), async (handle, extent, identity) => {
        const result = await readSessionArchive(handle, extent, false, prefix => options.qualify(sessionId, prefix), undefined, true)
        await options.checkDeleted(sessionId)
        const physical = result.verified ? {
          sessionId, generation, extent, dev: identity.dev, ino: identity.ino,
          headerDigest: createHash('sha256').update(result.birth).digest('hex'), verified: result.verified,
        } : undefined
        return { version: result.header.formatVersion, events: result.events, meta: result.header, physical }
      }, false, sessionId)
      assertCurrent(generation)
      const { physical, ...result } = observed
      if (!physical) return result
      const evidence = Object.freeze({})
      evidenceRecords.set(evidence, Object.freeze(physical))
      return { ...result, evidence }
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
