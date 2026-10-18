import type { LLMStreamEvent, ModelClient } from '../index.ts'
import type { PreparedRequestMeasurement } from '@i-harness/token-meter'
import { prepareModelRequest } from './fallback.ts'
import { preparedControls, preparedModelClient, snapshotModelData, wrapPreparedRequest } from './wrappers.ts'
import { isOwnedPreparedTerminal, ownPreparedTerminal } from './owned-terminal.ts'
import { rememberModelSource } from './client-source.ts'

/** Package-private: only the fixed retry/wait/observation implementations use
 * this composition entry. Public arbitrary callback wrappers remain unowned. */
export function withOwnedPreparedRequests(client: ModelClient, wrap: (inner: ModelClient, measurement: PreparedRequestMeasurement) => ModelClient, retryPolicy?: import('@i-harness/core-session').GenerationRetry): ModelClient {
  const outer = preparedModelClient(async request => {
    const captured = snapshotModelData(request), prepared = await prepareModelRequest(client, captured)
    captured.signal?.throwIfAborted()
    const result = wrapPreparedRequest(prepared, (stream, control, measurement) => wrap({ stream: executionRequest => stream(preparedControls(captured, executionRequest)) }, measurement)
      .stream({ ...captured, ...preparedControls(captured, control) }), retryPolicy ?? prepared.retryPolicy)
    return isOwnedPreparedTerminal(prepared) || prepared.localExecutionIdentity ? ownPreparedTerminal(result, prepared) : result
  })
  const wrapped = { ...outer, get executionIdentity() { return client.executionIdentity } }
  rememberModelSource(wrapped, () => client)
  return wrapped
}

/** Structured signal composition always invokes the same owned inner path. */
export function withPreparedSignal(prepared: import('./types.ts').PreparedModelRequest, read: () => AbortSignal | undefined) {
  const result = wrapPreparedRequest(prepared, (stream, control) => {
    const signal = read()
    return stream(preparedControls(control ?? {}, { ...(signal ? { signal } : {}) }))
  })
  return isOwnedPreparedTerminal(prepared) || prepared.localExecutionIdentity ? ownPreparedTerminal(result, prepared) : result
}

export interface ModelObservation<State> {
  start(request: import('../index.ts').LLMRequest, measurement: PreparedRequestMeasurement): State | Promise<State>
  event?(state: State, event: LLMStreamEvent): void
  finish(state: State, outcome: 'completed' | 'failed' | 'cancelled'): void | Promise<void>
  onError?(error: unknown): void
}
/** Observers may inspect lifecycle facts, but cannot replace/skip inner.stream
 * or turn a recording failure into another model generation. */
export function observeModelClient<State>(client: ModelClient, observation: ModelObservation<State>): ModelClient {
  const failed = (error: unknown) => { try { observation.onError?.(error) } catch { /* Diagnostic isolation. */ } }
  return withOwnedPreparedRequests(client, (inner, measurement) => ({ async *stream(request) {
    let state: State | undefined, available = false, drained = false, outcome: 'completed' | 'failed' | 'cancelled' = 'completed'
    try { state = await observation.start(request, measurement); available = true } catch (error) { failed(error) }
    try {
      for await (const event of inner.stream(request)) {
        if (event.type === 'error') outcome = 'failed'
        if (event.type === 'end') drained = true
        if (available) try { observation.event?.(state!, event) } catch (error) { failed(error) }
        yield event
      }
      drained = true
    } catch (error) { outcome = 'failed'; throw error }
    finally {
      if (request.signal?.aborted || !drained && outcome === 'completed') outcome = 'cancelled'
      if (available) try { await observation.finish(state!, outcome) } catch (error) { failed(error) }
    }
  } }))
}
