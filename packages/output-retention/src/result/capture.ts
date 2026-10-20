import { lowerJsonData, streamJsonData, containsNativeRawJson, freezeJsonData, type JsonValue, type ResultEnvelope, type ResultExecution, type ResultCompleteness } from '@i-harness/core-session'
import type { ResultFinalization } from '@i-harness/core-tools'
import type { ResultArtifactSink, ArtifactSettlement } from '@i-harness/context-output'
import { boundedPreview } from './preview.ts'
import { resultMedia } from './media.ts'
import { mcpPresentation } from './mcp-presentation.ts'

interface ResultCaptureOptions { openArtifact(): Promise<ResultArtifactSink>; forceArtifact?: boolean; completeness?: ResultCompleteness; presentation?: 'mcp' }

/** R4A-ENC-01: callback-bearing lowering is synchronous. Only owned immutable
 * data reaches the streaming encoder; one64KiB write and one bounded token may
 * be pending. A storage retry resumes those bytes and this exact iterator. */
export function createResultCapture(output: unknown, execution: ResultExecution, options: ResultCaptureOptions): ResultFinalization {
  let programValue: unknown, encodingFailed = false
  try { programValue = lowerJsonData(output); if (programValue === undefined) throw new TypeError('No JSON representation'); freezeJsonData(programValue) }
  catch { encodingFailed = true }
  const presentation = !encodingFailed && options.presentation === 'mcp' ? mcpPresentation(programValue) : undefined
  const requiresArtifact = presentation?.requiresArtifact || (!encodingFailed && containsNativeRawJson(programValue))
  const media = resultMedia(programValue), boundExecution = Object.freeze({ ...execution })
  const envelope = (retention: ResultEnvelope['retention'], preview = ''): ResultEnvelope => ({ version: 1, execution: boundExecution, preview, media, retention })
  const iterator = encodingFailed ? undefined : streamJsonData(programValue), buffer = Buffer.alloc(65536)
  let bytes = 0, preview = presentation?.preview ?? '', previewFull = false, used = 0, token: Buffer | undefined, tokenOffset = 0, encodingDone = false, writePending = false
  let sink: ResultArtifactSink | undefined, result: Awaited<ReturnType<ResultFinalization['settle']>> | undefined, running: Promise<Awaited<ReturnType<ResultFinalization['settle']>>> | undefined
  const ready = (value: ResultEnvelope) => ({ kind: 'ready' as const, envelope: value, program: encodingFailed ? { kind: 'unavailable' as const, reason: 'encoding' as const } : { kind: 'value' as const, value: programValue } })
  function fill() {
    while (used < buffer.length && !encodingDone) {
      if (!token || tokenOffset === token.length) {
        const next = iterator!.next()
        if (next.done) { encodingDone = true; break }
        token = Buffer.from(next.value); tokenOffset = 0; bytes += token.length
        if (!Number.isSafeInteger(bytes)) throw new Error('Encoded result exceeds safe byte domain')
        if (!presentation && !media.length && !previewFull) {
          const candidate = preview + next.value
          preview = boundedPreview(candidate); previewFull = preview.length < candidate.length
        }
      }
      const length = Math.min(buffer.length - used, token.length - tokenOffset)
      token.copy(buffer, used, tokenOffset, tokenOffset + length); tokenOffset += length; used += length
    }
  }
  async function settle() {
    if (result) return result
    if (encodingFailed) return result = ready(envelope({ kind: 'unavailable', reason: 'encoding' }))
    try {
      if (writePending) {
        if (await sink!.reconcileWrite() !== 'ready') return { kind: 'recovery-required' as const }
        writePending = false; used = 0
      }
      for (;;) {
        fill()
        if (!sink && encodingDone && !media.length && bytes <= 60000 && !options.forceArtifact && !requiresArtifact) return result = ready(envelope({ kind: 'inline', value: programValue as JsonValue, encodedBytes: bytes }))
        if (!sink) {
          try { sink = await options.openArtifact() }
          catch (cause) {
            const code = (cause as { code?: string }).code
            if (code === 'ARTIFACT_QUOTA' || code === 'ARTIFACT_OWNER_UNSUPPORTED') return result = ready(envelope({ kind: 'unavailable', reason: code === 'ARTIFACT_QUOTA' ? 'quota' : 'unsupported-owner', observedEncodedBytes: bytes }, preview))
            return { kind: 'recovery-required' as const }
          }
        }
        if (used) {
          writePending = true
          await sink.write(buffer.subarray(0, used))
          writePending = false; used = 0
        }
        if (encodingDone) break
      }
      const settlement: ArtifactSettlement = await sink!.finish(options.completeness ?? 'complete')
      if (settlement.kind === 'recovery-required') return { kind: 'recovery-required' as const }
      if (settlement.kind === 'refused') return result = ready(envelope({ kind: 'unavailable', reason: settlement.reason, observedEncodedBytes: settlement.observedEncodedBytes }, preview))
      return result = ready(envelope({ kind: 'artifact', ref: settlement.ref }, presentation ? preview : media.length ? 'Result includes retained structured data and supported media.' : preview))
    } catch { return { kind: 'recovery-required' as const } }
  }
  return { settle() {
    if (running) return running
    const next = settle(); running = next
    void next.finally(() => { if (running === next) running = undefined }).catch(() => {})
    return next
  } }
}
