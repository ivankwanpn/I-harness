import type { ExecFrameCapture, ExecFramePart } from '@i-harness/exec'
import type { ResultArtifactSink } from '@i-harness/context-output'
import { encodeExecFrameRecord, type ResultCompleteness, type ResultDependency } from '@i-harness/core-session'

interface ExecFrameCaptureOptions { sourceId: string; openArtifact(): Promise<ResultArtifactSink> }
const header = Buffer.from('IHEXEC01\n', 'ascii')
/** Canonical, bounded frame encoding. Raw bytes never become preview prose. */
export function createExecFrameCapture(options: ExecFrameCaptureOptions): ExecFrameCapture {
  let sink: ResultArtifactSink | undefined, headerWritten = false, pending: Buffer | undefined, issued: 'header' | 'record' | undefined
  let encodedBytes = header.length, completeness: ResultCompleteness | undefined, opening: Promise<ResultArtifactSink> | undefined
  let previous: { channel: ExecFramePart['channel']; frame: number; next: number; end: boolean } | undefined
  let unavailable: Extract<ResultDependency['retention'], { kind: 'unavailable' }> | undefined
  let result: Awaited<ReturnType<ExecFrameCapture['settle']>> | undefined, settling: Promise<Awaited<ReturnType<ExecFrameCapture['settle']>>> | undefined
  async function getSink() {
    if (sink) return sink
    opening ??= options.openArtifact()
    try { return sink = await opening }
    catch (cause) {
      opening = undefined
      const code = (cause as { code?: string }).code
      if (code === 'ARTIFACT_QUOTA' || code === 'ARTIFACT_OWNER_UNSUPPORTED') unavailable = { kind: 'unavailable', reason: code === 'ARTIFACT_QUOTA' ? 'quota' : 'unsupported-owner' }
      throw cause
    }
  }
  async function flush() {
    if (unavailable) { pending = undefined; return }
    let writer: ResultArtifactSink
    try { writer = await getSink() } catch (cause) { if (unavailable) { pending = undefined; return }; throw cause }
    if (issued) {
      if (await writer.reconcileWrite() !== 'ready') throw new Error('Original frame write requires reconciliation')
      if (issued === 'header') headerWritten = true
      else pending = undefined
      issued = undefined
    }
    if (!headerWritten) { issued = 'header'; await writer.write(header); issued = undefined; headerWritten = true }
    if (pending) { issued = 'record'; await writer.write(pending); issued = undefined; pending = undefined }
  }
  const ready = (retention: ResultDependency['retention']) => ({ kind: 'ready' as const, dependency: { kind: 'exec-frames' as const, sourceId: options.sourceId, retention } })
  async function settle() {
    if (result) return result
    if (completeness === undefined) return { kind: 'recovery-required' as const }
    try {
      await flush()
      if (unavailable) return result = ready({ ...unavailable, observedEncodedBytes: encodedBytes })
      const saved = await sink!.finish(completeness)
      if (saved.kind === 'recovery-required') return { kind: 'recovery-required' as const }
      if (saved.kind === 'refused') return result = ready({ kind: 'unavailable', reason: saved.reason, observedEncodedBytes: saved.observedEncodedBytes })
      return result = ready({ kind: 'artifact', ref: saved.ref })
    } catch { return { kind: 'recovery-required' as const } }
  }
  return {
    sourceId: options.sourceId,
    async write(part) {
      if (completeness !== undefined || pending || issued || part.bytes.length > 32768 || !['stdout', 'stderr'].includes(part.channel)
        || ![part.frame, part.offset, part.offset + part.bytes.length].every(value => Number.isSafeInteger(value) && value >= 0)
        || typeof part.end !== 'boolean' || previous && (part.frame === previous.frame ? previous.end || part.channel !== previous.channel || part.offset !== previous.next : part.frame < previous.frame || !previous.end || part.offset !== 0)
        || !previous && part.offset !== 0) throw new Error('Invalid native frame progression')
      pending = Buffer.from(encodeExecFrameRecord({ channel: part.channel, frame: part.frame, offset: part.offset, end: part.end, data: Buffer.from(part.bytes).toString('base64') }))
      if (pending.length > 45056) throw new Error('Native frame record exceeds budget')
      encodedBytes += pending.length
      if (!Number.isSafeInteger(encodedBytes)) throw new Error('Native frame encoding exceeds safe byte domain')
      previous = { channel: part.channel, frame: part.frame, next: part.offset + part.bytes.length, end: part.end }
      await flush()
    },
    complete(value) {
      const declared = value === 'complete' && previous && !previous.end ? 'producer-incomplete' : value
      if (completeness !== undefined && completeness !== declared) throw new Error('Native frame completeness is immutable')
      completeness = declared
    },
    settle() {
      if (settling) return settling
      const next = settle(); settling = next
      void next.finally(() => { if (settling === next) settling = undefined }).catch(() => {})
      return next
    },
  }
}
