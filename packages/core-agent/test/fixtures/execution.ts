import type { LiveExecutionIdentity, PreparedStreamControl, PreparedModelRequest, ModelClient } from '@i-harness/llm-seam'
import { createPreparedPayload } from '@i-harness/llm-seam'
import { ProjectionCounter } from '@i-harness/token-meter'
let sends = 0
export const fixtureExecutionIdentity: LiveExecutionIdentity = { version: 1, runtimeId: 'fixture-runtime', bindingLifetimeId: 'fixture-binding', authEpoch: 'fixture-E', scope: 'binding-credential', coldCompatible: false }
/** Source-equivalent synchronous boundary for tests that replace a real transport. */
export function confirmFixtureExecution(prepared: PreparedModelRequest, control?: PreparedStreamControl) {
  const semantic = prepared.measurement.input.semanticIdentity!, payload = prepared.measurement.payloadIdentity!
  control?.confirmExecution?.({ version: 1, sendId: `fixture-send-${++sends}`, semanticId: semantic.semanticId, payloadId: payload.id, payloadKind: payload.kind, identity: fixtureExecutionIdentity })
  control?.validateBeforeTransport?.()
}
/** Classified test protocol for existing raw-script calibration oracles. */
export function classifiedFixtureClient(script: ModelClient): ModelClient {
  return { executionIdentity: fixtureExecutionIdentity, stream: r => script.stream(r), async prepare(request) {
    const captured = { messages: request.messages, system: request.systemPrompt, tools: request.tools }
    return createPreparedPayload({ body: captured, request, textOutput: () => ({ status: 'allowed', reason: 'ordinary-text' }),
      describe(body) { const c = new ProjectionCounter('projected-pricing-v2'); c.text('system', body.system); c.structured('toolSchemas', body.tools); for (const m of body.messages) c.unit(m, m.role, () => c.structured('visibleText', m)); return { input: c.finish({ protocol: 'fixture', modelId: 'm' }, body, { system: body.system, tools: body.tools }), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
      output: () => ({ capSupport: 'unknown', minimumCap: 1, source: 'request' }), cap: b => b,
      async *execute(_b, _s, control, execution) { execution.confirm(fixtureExecutionIdentity); yield* script.stream({ ...request, ...control, confirmExecution: undefined, validateBeforeTransport: undefined }) },
    })
  } }
}
