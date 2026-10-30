// Included by the package tsconfig; never executed as a runtime test.
import * as selected from '../src/selected-results-fork-contract.ts'

export function readonlyControls(input: unknown, expected: selected.ForkOperationV2) {
  const core = selected.readSelectedResultsCore(input)
  // @ts-expect-error admitted selection is readonly
  core.selection.atSeq = 4
  // @ts-expect-error reused nested model metadata is readonly
  core.metadata.modelSelection!.provider = 'other'
  const prepare = selected.readSelectedResultsPrepareRequest(input)
  if (prepare.selection) {
    // @ts-expect-error optional selection does not escape readonly
    prepare.selection.kind = 'completed'
  }
  if (prepare.metadata?.modelSelection) {
    // @ts-expect-error optional metadata does not escape readonly
    prepare.metadata.modelSelection.model = 'other'
  }
  const normalized = selected.createSelectedResultsIntent(core, { kind: 'project', projectId: 'p' })
  // @ts-expect-error factory envelope is readonly
  normalized.requestDigest = 'other'
  // @ts-expect-error factory intent is readonly
  normalized.intent.requestCoreDigest = 'other'
  if (normalized.intent.project.kind === 'project') {
    // @ts-expect-error project union payload is readonly
    normalized.intent.project.projectId = 'other'
  } else {
    // @ts-expect-error project union fallback is readonly
    normalized.intent.project.kind = 'unmanaged'
  }
  const invocation = selected.readSelectedResultsInvocation(input)
  // @ts-expect-error reused invocation is readonly
  invocation.targetSessionId = 'other'
  const prepared = selected.readSelectedResultsPrepared(input)
  // @ts-expect-error prepared core is deeply readonly
  prepared.core.metadata.title = 'other'
  const operation = selected.readSelectedResultsOperation(input)
  // @ts-expect-error operation invocation is deeply readonly
  operation.invocation.targetSessionId = 'other'
  const command = selected.readSelectedResultsCommand(input)
  // @ts-expect-error command envelope is readonly
  command.mode = 'retry'
  // @ts-expect-error command operation is deeply readonly
  command.operation.prepared.core.sourceSessionId = 'other'
  const result = selected.readSelectedResultsPrepareResult(input)
  if (result.kind === 'prepared') {
    // @ts-expect-error prepared result is deeply readonly
    result.prepared.core.selection.atSeq = 4
  } else {
    // @ts-expect-error unavailable result is readonly
    result.reason = 'policy'
  }
  const outcome = selected.readSelectedResultsOutcome(input, expected)
  // @ts-expect-error all outcome branches expose readonly operations
  outcome.operation.invocation.operationId = 'other'
  if (outcome.kind === 'ready' || outcome.kind === 'adopted') {
    // @ts-expect-error success envelope is readonly
    outcome.title = 'other'
    // @ts-expect-error receipt is readonly
    outcome.receipt.seedLength = 4
    // @ts-expect-error receipt invocation is readonly
    outcome.receipt.invocation.createdAt = 'other'
    // @ts-expect-error source observation is readonly
    outcome.receipt.sourceObservation.digest = 'other'
    // @ts-expect-error results summary is readonly
    outcome.receipt.results.rows = 4
  } else if (outcome.kind === 'not-issued') {
    // @ts-expect-error not-issued branch is readonly
    outcome.reason = 'cancelled'
  } else if (outcome.kind === 'refused') {
    // @ts-expect-error refused branch is readonly
    outcome.reason = 'conflict'
  } else if (outcome.kind === 'blocked') {
    // @ts-expect-error blocked branch is readonly
    outcome.capture = 'captured'
    // @ts-expect-error token invocation is deeply readonly in both arms
    outcome.token.invocation.requestDigest = 'other'
    if ('manifest' in outcome.token) {
      // @ts-expect-error unknown manifest arm is readonly
      outcome.token.manifest = 'unknown'
    } else {
      // @ts-expect-error known digest arm is readonly
      outcome.token.manifestDigest = 'other'
    }
  }
  const error = selected.readSelectedResultsHostError(input, expected)
  // @ts-expect-error error envelope is readonly
  error.reason = 'internal'
  // @ts-expect-error error operation is deeply readonly
  error.operation.prepared.requestIntent.project.kind = 'unmanaged'
  if (error.lastOutcome) {
    // @ts-expect-error optional last outcome preserves readonly
    error.lastOutcome.capture = 'unknown'
  }
  return JSON.stringify({ core, prepare, normalized, invocation, prepared, operation, command, result, outcome, error })
}

// Fresh mutable fixture construction, property reads, spreads and serialization remain legal.
export const prepareFixture: selected.ForkPrepareRequestV2 = {
  version: 2, sourceSessionId: 'source', results: 'selected-results-v1',
  selection: { kind: 'completed', atSeq: 2 },
  metadata: { title: 'hello', modelSelection: { provider: 'p', model: 'm' } },
}
export const prepareCopy = { ...prepareFixture, sourceSessionId: 'another-source' }
export const fixtureJson: string = JSON.stringify(prepareFixture)
export const sourceId: string = prepareFixture.sourceSessionId

// Check the exported DTO aliases directly, as well as inferred reader returns above.
export function aliasControls(
  selection: selected.CompletedSelection, core: selected.ForkRequestCoreV2,
  prepare: selected.ForkPrepareRequestV2, intent: selected.SelectedResultsRequestIntentV2,
  prepared: selected.ForkPreparedV2, operation: selected.ForkOperationV2,
  token: selected.ResumeTokenV2, receipt: selected.ForkReceiptSummaryV2,
  outcome: selected.ForkOutcomeV2, error: selected.ForkHostErrorDataV2,
  result: selected.ForkPrepareResultV2, command: selected.ForkCommandV2,
) {
  // @ts-expect-error selection alias is readonly
  selection.atSeq = 1
  // @ts-expect-error core alias protects imported metadata
  core.metadata.modelSelection!.model = 'other'
  // @ts-expect-error prepare alias protects optional metadata
  prepare.metadata!.workspaceId = 'other'
  // @ts-expect-error intent alias protects every project arm
  intent.project.kind = 'unassigned'
  // @ts-expect-error prepared alias is readonly
  prepared.requestDigest = 'other'
  // @ts-expect-error operation alias protects imported invocation
  operation.invocation.version = 1
  // @ts-expect-error token alias protects all union arms
  token.phase = 'header'
  // @ts-expect-error receipt alias protects nested summary
  receipt.results.digest = 'other'
  // @ts-expect-error outcome alias protects all union arms
  outcome.version = 2
  // @ts-expect-error error alias protects optional outcome
  error.lastOutcome!.operation.prepared.core.selection.atSeq = 1
  // @ts-expect-error result alias protects all union arms
  result.kind = 'prepared'
  // @ts-expect-error command alias is readonly
  command.mode = 'begin'
}
