import type { ToolExec } from '@i-harness/core-tools'
import { userSteerForTool, waitForObservation } from '@i-harness/core-tools'
import type { BackgroundJobView, ExecService, NativeJobIdentity } from '@i-harness/exec'
import { sameManagedArtifactRef } from '@i-harness/core-session'
import { readExecTextWindow, ExecTextWindowError } from '../../../context-output/src/artifact/exec-text-window.ts'
import type { ReportPolicy } from '../report-policy.ts'

const messages = {
  'invalid-selector': 'Invalid native output selector.', 'unsupported-selector': 'Selector is unsupported for this backend.',
  'instance-required': 'Native text continuation requires job_instance_id.', 'stale-instance': 'Native job instance changed.',
  'stale-source': 'Native output source changed.', 'stale-digest': 'Native stdout digest changed.',
  'invalid-range': 'Offset must be a stdout UTF8 scalar boundary within captured output.',
  'native-capability-unavailable': 'Native output capability unavailable.', 'output-pending': 'Native output is pending.',
  'output-unavailable': 'Native output unavailable.', 'metadata-budget': 'Response budget cannot fit required metadata and advancing text.',
  'text-view-unavailable': 'Captured stdout has no exact UTF8 text view.', 'budget': 'Invalid native response budget.',
} as const
export type NativeOutputError = keyof typeof messages
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const knownReasons = new Set(['not-found', 'stale', 'unauthorized', 'corrupt', 'range', 'budget', 'unavailable', 'unsupported-owner', 'retention-unsupported', 'summary-unsupported', 'frame-read-unsupported', 'read-unavailable', 'output-pending', 'storage-unavailable', 'quota', 'source-limited', 'disabled', 'encoding', 'storage-refused', 'capture-canceled'])
const sameIdentity = (a: NativeJobIdentity | undefined, b: NativeJobIdentity) => !!a && a.version === b.version && a.jobId === b.jobId && a.instanceId === b.instanceId && a.sourceId === b.sourceId && a.ownerSessionId === b.ownerSessionId

/** Every refusal admits optional groups atomically; no caller strings enter messages. */
export function nativeOutputRefusal(code: NativeOutputError, cap = 16384, groups: Record<string, unknown>[] = []): Record<string, unknown> {
  let result: Record<string, unknown> = { error: { code, message: messages[code] } }
  if (size(result) > cap) return { error: { code: 'budget' } }
  for (const group of groups) { const candidate = { ...result, ...group }; if (size(candidate) <= cap) result = candidate }
  return result
}

export async function nativeJobOutput(service: ExecService, selected: BackgroundJobView | undefined, args: Record<string, unknown>, exec: ToolExec, policy: ReportPolicy): Promise<Record<string, unknown>> {
  const identity = selected?.nativeJob ? Object.freeze({ ...selected.nativeJob }) : undefined
  let cap = 16384, latest = selected!
  const groups: Record<string, unknown>[] = identity ? [{ job_id: identity.jobId, native_job: identity }] : []
  const refuse = (code: NativeOutputError) => nativeOutputRefusal(code, cap, [...(latest ? [{ status: latest.status }] : []), ...groups])
  if (!Number.isSafeInteger(policy.maxReportBytes) || policy.maxReportBytes < 1024 || !Number.isSafeInteger(policy.childPreviewBytes) || policy.childPreviewBytes < 4
    || args.max_output_bytes !== undefined && (!Number.isSafeInteger(args.max_output_bytes) || (args.max_output_bytes as number) < 1024)) return refuse('budget')
  cap = Math.min(args.max_output_bytes as number ?? policy.maxReportBytes, policy.maxReportBytes)
  if (!identity || !service.getJobView || !service.observeJobOutput || !service.readJobOutputFrames) return refuse('native-capability-unavailable')
  for (const key of ['job_instance_id', 'source_id', 'digest']) if (args[key] !== undefined && typeof args[key] !== 'string') return refuse('invalid-selector')
  if (args.digest !== undefined && !/^[a-f0-9]{64}$/.test(args.digest as string)) return refuse('invalid-selector')
  if (args.offset_bytes !== undefined && (!Number.isSafeInteger(args.offset_bytes) || (args.offset_bytes as number) < 0)) return refuse('invalid-selector')
  if (['cursor', 'body', 'result_revision', 'ref_revision', 'ref_id'].some(k => args[k] !== undefined) || args.field !== undefined && args.field !== 'text') return refuse('unsupported-selector')
  const continuation = ['offset_bytes', 'digest', 'source_id', 'field'].some(k => args[k] !== undefined)
  if (continuation && args.job_instance_id === undefined) return refuse('instance-required')
  if (args.job_instance_id !== undefined && args.job_instance_id !== identity.instanceId) return refuse('stale-instance')
  if (args.source_id !== undefined && args.source_id !== identity.sourceId) return refuse('stale-source')
  const current = () => {
    exec.abortSignal?.throwIfAborted()
    latest = service.getJobView!(identity.jobId)
    if (!sameIdentity(latest.nativeJob, identity)) throw new Error('Native output invocation no longer current')
  }
  current()
  const reason = args.wait === true ? await waitForObservation({ ready: () => { current(); return latest.status !== 'running' },
    changes: { subscribe: wake => service.subscribeJob(identity.jobId, () => { current(); wake() }) },
    timeoutMs: args.timeout_ms === Infinity || Number.isNaN(args.timeout_ms) ? undefined : Math.max(0, args.timeout_ms as number ?? 30000),
    abortSignal: exec.abortSignal, userSteer: userSteerForTool(exec),
  }) : undefined
  current()
  const observation = await service.observeJobOutput(identity.jobId, { jobInstanceId: identity.instanceId, sourceId: identity.sourceId, signal: exec.abortSignal })
  current()
  if (!sameIdentity(observation.nativeJob, identity)) throw new Error('Native observation identity changed')
  const source = observation.source
  const base: Record<string, unknown> = { job_id: identity.jobId, native_job: identity, status: latest.status,
    ...(latest.outputDiagnostics ? { output_diagnostics: { ...latest.outputDiagnostics } } : {}),
    source: source.kind === 'unavailable' ? { kind: source.kind, reason: knownReasons.has(source.reason) ? source.reason : 'unavailable' } : { kind: source.kind },
    ...(reason === 'user-steer' && latest.status === 'running' ? { yielded: true, yield_reason: 'user-steer' } : {}) }
  groups.push({ source: base.source })
  if (source.kind !== 'retained-summary') {
    if (continuation) return refuse(source.kind === 'pending' ? 'output-pending' : 'output-unavailable')
    let display = Buffer.from(latest.stdout).subarray(0, policy.childPreviewBytes).toString('utf8')
    let value = { ...base, text: display, display_only: true, truncated: true }
    while (size(value) > cap && display.length) { display = display.slice(0, Math.floor(display.length / 2)); value = { ...value, text: display } }
    return size(value) <= cap ? value : refuse('metadata-budget')
  }
  const { summary, dependency } = source
  if (dependency.retention.kind !== 'artifact' || !Number.isSafeInteger(summary.stdout.bytes) || !Number.isSafeInteger(summary.stderr.bytes)
    || !Number.isSafeInteger(summary.totalRawBytes) || summary.stdout.bytes < 0 || summary.stderr.bytes < 0 || summary.totalRawBytes !== summary.stdout.bytes + summary.stderr.bytes
    || !/^[a-f0-9]{64}$/.test(summary.stdout.sha256) || !/^[a-f0-9]{64}$/.test(summary.stderr.sha256)
    || summary.completeness !== dependency.retention.ref.completeness) return refuse('output-unavailable')
  const ref = Object.freeze({ ...dependency.retention.ref })
  const raw = { scope: 'captured', completeness: summary.completeness, total_bytes: summary.stdout.bytes, stderr_total_bytes: summary.stderr.bytes,
    total_raw_bytes: summary.totalRawBytes, digest: summary.stdout.sha256, stderr_digest: summary.stderr.sha256, digest_format: 'sha256-raw-v1' }
  const full_result = { tool: 'context_output_read', args: { ref, maxBytes: 32768 }, access: 'catalog-required', catalog_from: 'envelope.dependencies.ref' }
  groups.push(raw, { full_result })
  if (args.digest !== undefined && args.digest !== summary.stdout.sha256) return refuse('stale-digest')
  const offset = args.offset_bytes as number ?? 0
  if (offset > summary.stdout.bytes) return refuse('invalid-range')
  const read = async (cursor: import('@i-harness/core-session').ExecFrameCursor, maxBytes: number) => {
    current()
    const result = await service.readJobOutputFrames!(identity.jobId, { jobInstanceId: identity.instanceId, sourceId: identity.sourceId, cursor, maxBytes, signal: exec.abortSignal })
    current()
    if (result.kind !== 'page') {
      groups.push({ read_failure: result.kind === 'unavailable' ? { kind: result.kind, reason: knownReasons.has(result.reason) ? result.reason : 'unavailable' } : { kind: result.kind } })
      throw new Error('Native frame page unavailable')
    }
    if (result.dependency.sourceId !== dependency.sourceId || result.dependency.retention.kind !== 'artifact' || !sameManagedArtifactRef(ref, result.dependency.retention.ref)) throw new Error('Native frame dependency changed')
    return result.page
  }
  try {
    const window = await readExecTextWindow(ref, summary.stdout.bytes, offset, continuation ? cap : Math.min(cap, policy.childPreviewBytes), read, exec.abortSignal)
    current()
    let text = window.text
    const assemble = () => {
      const next = offset + Buffer.byteLength(text)
      return { ...base, ...raw, full_result, text, offset_bytes: offset, next_offset_bytes: next,
        truncated: next < summary.stdout.bytes || summary.completeness !== 'complete',
        text_result: { tool: 'job_output', args: { job_id: identity.jobId, job_instance_id: identity.instanceId, source_id: identity.sourceId, digest: summary.stdout.sha256, offset_bytes: next } } }
    }
    let value = assemble()
    while (size(value) > cap && text.length) {
      const bytes = Buffer.from(text), target = Math.floor(bytes.length / 2)
      let end = target
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
      text = bytes.subarray(0, end).toString('utf8'); value = assemble()
    }
    if (size(value) > cap || !text.length && offset < summary.stdout.bytes) return refuse('metadata-budget')
    current(); return value
  } catch (cause) {
    current()
    if (cause instanceof ExecTextWindowError) {
      if (cause.code === 'invalid-range') return refuse('invalid-range')
      const value = { ...base, ...raw, full_result, text: '', display_only: true, truncated: true, error: { code: cause.code, message: messages[cause.code] } }
      return size(value) <= cap ? value : refuse('text-view-unavailable')
    }
    return refuse('output-unavailable')
  }
}
