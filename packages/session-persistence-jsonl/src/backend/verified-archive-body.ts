import { createHash } from 'node:crypto'
import { decodeFactBatch, type JournalMetadata, type JournalPrefix, type SessionEvent } from '@i-harness/core-session'
import { createJournalStreamDecoder, type JournalFrameExtent } from '@i-harness/core-session/internal/archive'

/** Evidence from an already verified read by this owner. It retains no event bodies. */
export interface VerifiedArchiveBody {
  readonly formatVersion: number
  readonly legacyPrefixDigest: string
  readonly prefix: Readonly<JournalPrefix>
  readonly digest: string
  readonly frames: readonly JournalFrameExtent[]
}

function findFrame(frames: readonly JournalFrameExtent[], ordinal: number): JournalFrameExtent {
  let start = 0
  let end = frames.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if (frames[middle]!.firstSeq <= ordinal) start = middle + 1
    else end = middle
  }
  const frame = frames[start - 1]
  if (!frame || ordinal >= frame.firstSeq + frame.count) throw new Error('Owned dependency ordinal mismatch')
  return frame
}

/** Hash every body byte from the same descriptor pass that supplies the
 * selected frames. Reuse framing only after matching the old raw digest. */
export function createVerifiedArchiveBodyDecoder(
  metadata: JournalMetadata,
  formatVersion: number,
  expected: Readonly<JournalPrefix>,
  ordinals: ReadonlySet<number>,
  accept: (event: SessionEvent) => void,
  prior?: VerifiedArchiveBody,
) {
  if (metadata.legacyEventCount || metadata.legacyBodyBytes || metadata.separatorBytes) return undefined
  const previous = prior && prior.formatVersion === formatVersion &&
    prior.legacyPrefixDigest === metadata.legacyPrefixDigest &&
    prior.prefix.bodyBytes > 0 && prior.prefix.bodyBytes <= expected.bodyBytes &&
    prior.prefix.eventCount <= expected.eventCount ? prior : undefined
  const selectedFrames = previous ? [...new Set([...ordinals]
    .filter(ordinal => ordinal < previous.prefix.eventCount)
    .map(ordinal => findFrame(previous.frames, ordinal)))].sort((a, b) => a.offset - b.offset) : []
  const hash = createHash('sha256')
  const frames: JournalFrameExtent[] = []
  const consume = (events: SessionEvent[]) => {
    for (const event of events) if (ordinals.has(event.seq!)) accept(event)
  }
  const onFrame = (extent: JournalFrameExtent) => { frames.push(extent) }
  let decoder = previous ? undefined : createJournalStreamDecoder(metadata, formatVersion, consume, { onFrame })
  let position = 0
  let frameIndex = 0
  let fragments: Buffer[] = []

  function captureSelectedFrames(bytes: Buffer) {
    const end = position + bytes.length
    while (frameIndex < selectedFrames.length) {
      const frame = selectedFrames[frameIndex]!
      if (frame.offset >= end) break
      const frameEnd = frame.offset + frame.length
      const part = bytes.subarray(Math.max(0, frame.offset - position), Math.min(bytes.length, frameEnd - position))
      fragments.push(part)
      if (frameEnd > end) break
      const raw = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments)
      const decoded = decodeFactBatch(raw)
      if (decoded.key.firstSeq !== frame.firstSeq || decoded.key.count !== frame.count)
        throw new Error('Owned dependency ordinal mismatch')
      consume(decoded.events)
      fragments = []
      frameIndex++
    }
  }

  return {
    push(bytes: Buffer) {
      let offset = 0
      if (previous && !decoder) {
        offset = Math.min(bytes.length, previous.prefix.bodyBytes - position)
        const prefixBytes = bytes.subarray(0, offset)
        hash.update(prefixBytes)
        captureSelectedFrames(prefixBytes)
        position += offset
        if (position === previous.prefix.bodyBytes) {
          if (hash.copy().digest('hex') !== previous.digest || frameIndex !== selectedFrames.length)
            throw new Error('Owned dependency prefix mismatch')
          decoder = createJournalStreamDecoder(metadata, formatVersion, consume, { from: previous.prefix, onFrame })
        }
      }
      if (offset < bytes.length) {
        const suffix = bytes.subarray(offset)
        hash.update(suffix)
        decoder!.push(suffix)
        position += suffix.length
      }
    },
    finish() {
      if (!decoder) throw new Error('Owned dependency prefix mismatch')
      const result = decoder.finish()
      const verified: VerifiedArchiveBody = {
        formatVersion,
        legacyPrefixDigest: metadata.legacyPrefixDigest,
        prefix: result.prefix,
        digest: hash.digest('hex'),
        frames: previous ? (frames.length ? previous.frames.concat(frames) : previous.frames) : frames,
      }
      return { ...result, verified }
    },
  }
}
