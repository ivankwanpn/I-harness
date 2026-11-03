import { expect, it } from 'vitest'
import { ProjectionCounter } from '@i-harness/token-meter'
import { createPreparedPayload, createRetryingClient, resolveRetryPolicy, prepareModelRequest, modelFailureFacts, retryErrorCode, safeModelFailureFacts, wrapPreparedRequest, readPreparedValidation } from '../src/index.ts'
import { createPreparedValidation, sanitizePreparedValidation, validationCollector } from '../src/prepared/validation.ts'
import type { ValidationRule, ValidationSite } from '../src/prepared/validation.ts'
import { finalValidationError } from '../src/prepared/rejection.ts'
const request = { systemPrompt: '', tools: [], messages: [] }
function fixture() {
  let validations = 0, descriptions = 0, sends = 0
  const packets: unknown[] = []
  const prepared = createPreparedPayload({ body: { messages: ['中'] as unknown, cap: 1 }, request,
    validate(body, packet) { validations++; packets.push(packet); const check = validationCollector('openai-compatible'); if (!Array.isArray(body.messages)) check.issue('shape', 'messages'); return check.finish() },
    describe(body) { descriptions++; const counter = new ProjectionCounter(); counter.structured('otherInput', body); return { input: counter.finish({ modelId: 'm', protocol: 'openai-compatible' }, body, {}), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
    output: body => ({ capSupport: 'supported', minimumCap: 1, effectiveCap: body.cap, source: 'request' }),
    cap: (body, cap) => ({ ...body, cap: cap ?? 1, messages: cap === 7 ? null : body.messages }),
    async *execute(_body, _serialized, _control, execution) { execution.confirm(); sends++; yield { type: 'end' } },
  })
  return { prepared, packets, counts: () => ({ validations, descriptions, sends }) }
}
it('rejects an invalid validator result discriminant instead of treating it as accepted', () => {
  const report = validationCollector('custom').finish().report
  expect(() => createPreparedPayload({ body: {}, request, validate: (() => ({ kind: 'unknown', report })) as never, describe() { throw Error('description must not run') }, output() { throw Error('output must not run') }, cap: body => body, async *execute() { throw Error('send must not run') } })).toThrow('Invalid final validation result')
})
it('validates each actual derivative before description and preserves exact report through wrappers', async () => {
  const f = fixture(), capped = f.prepared.withOutputCap(2), restored = capped.withOutputCap(undefined), repeated = restored.withOutputCap(2)
  expect(f.counts()).toEqual({ validations: 4, descriptions: 4, sends: 0 })
  expect(f.packets[0]).toEqual({ kind: 'http-json-body', bodyBytes: Buffer.byteLength('{"messages":["中"],"cap":1}') })
  expect(() => f.prepared.withOutputCap(7)).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  expect(f.counts()).toEqual({ validations: 5, descriptions: 4, sends: 0 })
  const wrapped = wrapPreparedRequest(repeated, stream => stream())
  expect(wrapped.validation).toBe(repeated.validation)
  for await (const _ of wrapped.stream()) {}
  expect(f.counts().sends).toBe(1)
})
it('keeps a coherent typed rejection above hostile context text but below auth/abort/quota/TLS', () => {
  const check = validationCollector('openai-compatible'); check.issue('tool-group', 'messages', 'message-order')
  const result = check.finish(); if (result.kind !== 'rejected') throw Error('fixture')
  const error = finalValidationError(result.reason, result.report); error.message = 'prompt is too long: sentinel-private'
  expect(retryErrorCode(error)).toBe('INVALID_ARGUMENT')
  expect(modelFailureFacts(error)).toMatchObject({ code: 'INVALID_ARGUMENT', reason: 'message-order', validation: result.report })
  for (const code of ['AUTH', 'ABORTED', 'QUOTA', 'TLS']) expect(retryErrorCode(Object.assign(new Error('wrapper'), { code, cause: error }))).toBe(code)
  const forged = Object.assign(new Error('prompt is too long'), { code: 'INVALID_ARGUMENT', modelFailure: { code: 'INVALID_ARGUMENT', reason: 'message-order', validation: { ...result.report, status: 'checked' } } })
  expect(retryErrorCode(forged)).toBe('CONTEXT_WINDOW_EXCEEDED')
  const wrapped = Object.assign(new Error('context_length_exceeded private'), { modelFailure: { code: 'CONTEXT_WINDOW_EXCEEDED', reason: 'context-limit' }, cause: error })
  expect(modelFailureFacts(wrapped)).toMatchObject({ code: 'INVALID_ARGUMENT', reason: 'message-order', validation: result.report })
})
it('reconstructs bounded own-field reports and rejects prototype/control smuggling', () => {
  const f = fixture(), report = f.prepared.validation!
  expect(Object.isFrozen(report)).toBe(true)
  expect(sanitizePreparedValidation(JSON.parse(JSON.stringify(report)))).toEqual(report)
  for (const key of ['constructor', 'toString', '__proto__']) {
    expect(sanitizePreparedValidation({ ...report, [key]: 'sentinel' })).toBeUndefined()
    expect(sanitizePreparedValidation({ ...report, status: 'invalid', issues: [{ rule: 'shape', site: 'input', [key]: 'sentinel' }] })).toBeUndefined()
  }
  expect(sanitizePreparedValidation(Object.create(report))).toBeUndefined()
  expect(sanitizePreparedValidation({ ...report, status: 'invalid', issues: [Object.create({ rule: 'shape', site: 'input' })] })).toBeUndefined()
  expect(sanitizePreparedValidation(Object.assign(Object.create(null), report))).toEqual(report)
  const invalid = createPreparedValidation({ ...report, status: 'invalid', issues: Array.from({ length: 100 }, () => ({ rule: 'shape', site: 'messages' })), omittedIssueCount: 999999 })
  expect(invalid.issues).toHaveLength(1); expect(invalid.omittedIssueCount).toBe(65535)
  expect(Buffer.byteLength(JSON.stringify(invalid))).toBeLessThanOrEqual(4096)
  const safe = safeModelFailureFacts({ code: 'INVALID_ARGUMENT', reason: 'schema', validation: invalid, message: 'sentinel prompt', raw: 'sentinel args' })
  expect(safe?.validation).toEqual(invalid)
  expect(JSON.stringify(safe)).not.toContain('sentinel')
})
it('constructor rejects hidden fields/accessors before reading their values', () => {
  const report = fixture().prepared.validation!
  const hidden = { ...report }; Object.defineProperty(hidden, 'constructor', { value: 'sentinel', enumerable: false })
  expect(() => createPreparedValidation(hidden)).toThrow(TypeError)
  let reads = 0
  const accessor = { ...report }; Object.defineProperty(accessor, 'native', { get() { reads++; return 'absent' }, enumerable: true })
  expect(() => createPreparedValidation(accessor)).toThrow(TypeError)
  expect(reads).toBe(0)
  const issue = { rule: 'shape', site: 'input' }; Object.defineProperty(issue, '__proto__', { value: 'sentinel' })
  expect(() => createPreparedValidation({ ...report, status: 'invalid', issues: [issue as never] })).toThrow(TypeError)
})
it('deduplicates and bounds the full issue/gap vocabulary and refuses incoherent rejection reasons', () => {
  const rules: ValidationRule[] = ['shape', 'binding', 'tool-id', 'tool-group', 'native-replay', 'parameter-type', 'parameter-conflict', 'unsupported-parameter', 'output-range', 'body-limit', 'media-limit']
  const sites: ValidationSite[] = ['request', 'model', 'messages', 'input', 'tools', 'native', 'generation', 'media']
  const report = createPreparedValidation({ ...fixture().prepared.validation!, status: 'invalid', native: 'unverified', issues: rules.flatMap(rule => sites.map(site => ({ rule, site }))), gaps: ['legacy-tool-ownership', 'native-origin-unknown', 'native-contract-unavailable', 'protocol-contract-unavailable', 'extension-unchecked', 'limit-unverified', 'remote-input-unavailable', 'custom-client'], omittedIssueCount: 0 })
  expect(report.issues).toHaveLength(12); expect(report.omittedIssueCount).toBe(76)
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(4096)
  expect(() => finalValidationError('constructor' as never, report)).toThrow(TypeError)
  const check = validationCollector('openai-compatible'); check.issue('tool-group', 'messages', 'message-order')
  const invalid = check.finish().report
  expect(() => finalValidationError('schema', invalid)).toThrow(TypeError)
  expect(retryErrorCode(Object.assign(new Error('prompt is too long'), { modelFailure: { code: 'INVALID_ARGUMENT', reason: 'schema', validation: invalid } }))).toBe('CONTEXT_WINDOW_EXCEEDED')
})
it('keeps typed local invalid argument terminal under retry always', async () => {
  const check = validationCollector('openai-compatible'); check.issue('shape', 'messages')
  const result = check.finish(); if (result.kind !== 'rejected') throw Error('fixture')
  const error = finalValidationError(result.reason, result.report); error.message = 'context_length_exceeded sentinel'
  let sends = 0
  const retry = createRetryingClient({ async *stream() { sends++; yield { type: 'error', error } } }, resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const events = []; for await (const event of retry.stream(request)) events.push(event)
  expect(sends).toBe(1)
  expect(events.filter(event => event.type === 'error')).toHaveLength(1)
})
it('provides honest reports for stream-only and custom prepared compatibility without mutating handles', async () => {
  let sends = 0
  const raw = { async *stream() { sends++; yield { type: 'end' as const } } }
  const fallback = await prepareModelRequest(raw, request)
  expect(readPreparedValidation(fallback)).toMatchObject({ route: 'custom', coverage: 'neutral-only', status: 'partial', gaps: ['custom-client'] })
  const custom = Object.freeze({ ...fallback, validation: undefined })
  const prepared = await prepareModelRequest({ ...raw, async prepare() { return custom } }, request)
  expect(prepared).toBe(custom)
  expect(readPreparedValidation(prepared).status).toBe('partial')
  for await (const _ of prepared.stream()) {}
  expect(sends).toBe(1)
  expect(validationCollector('custom').finish()).toMatchObject({ kind: 'accepted', report: { status: 'partial', coverage: 'neutral-only', gaps: ['custom-client'] } })
})
