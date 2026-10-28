import { validatedExecFramePages } from './exec-validation.ts'
import { createHash } from 'node:crypto'
import { type ExecFrameCursor, type ManagedArtifactRef, type ResultCompleteness } from '@i-harness/core-session'
import type { ExecFramePage } from './exec-reader.ts'

export interface ExecFrameSummary {
  readonly version: 1
  readonly stdout: Readonly<{ bytes: number; sha256: string }>
  readonly stderr: Readonly<{ bytes: number; sha256: string }>
  readonly totalRawBytes: number
  readonly completeness: ResultCompleteness
}

/** First read is O(captured output) authenticated IO. Holds one bounded page,
 * incremental hashes and numeric frame/record state, never the whole output. */
export async function summarizeExecFrames(original: ManagedArtifactRef, read: (cursor: ExecFrameCursor, maxBytes: number) => Promise<ExecFramePage>, signal?: AbortSignal): Promise<ExecFrameSummary> {
  const ref = Object.freeze({ ...original })
  const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') }, counts = { stdout: 0, stderr: 0 }
  for await (const page of validatedExecFramePages(ref, read, signal)) {
    for (const part of page.frames) {
      const bytes = Buffer.from(part.data, 'base64')
      hashes[part.channel].update(bytes); counts[part.channel] += bytes.length
      if (!Number.isSafeInteger(counts.stdout + counts.stderr)) throw new Error('Artifact frame count overflow')
    }
  }
  return Object.freeze({ version: 1, stdout: Object.freeze({ bytes: counts.stdout, sha256: hashes.stdout.digest('hex') }),
    stderr: Object.freeze({ bytes: counts.stderr, sha256: hashes.stderr.digest('hex') }), totalRawBytes: counts.stdout + counts.stderr, completeness: ref.completeness })
}
