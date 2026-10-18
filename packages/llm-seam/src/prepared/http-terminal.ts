import { systemFetch } from '@i-harness/http-transport'
import { createPreparedPayload, type PreparedPayloadOptions } from './payload.ts'
import { ownPreparedTerminal } from './owned-terminal.ts'
import { isExecutionControlError, type LiveExecutionIdentity } from './execution.ts'
import { generationError, isGenerationError } from './generation.ts'
import type { PreparedStreamControl } from './types.ts'
import { describeTransportError, type LLMStreamEvent } from '../index.ts'
import { describeHttpError } from '../provider-error/http.ts'
import { reportStreamActivity } from '../waiting-guard.ts'

export interface PreparedHttpRequest<State> { url: string; init: RequestInit; identity?: LiveExecutionIdentity; state: State }
export interface HttpTerminal<State, Body> {
  label: string
  proxy?: 'system'
  /** Explicit legacy injection remains standalone-only. */
  fetchOverride?: typeof globalThis.fetch
  prepare(body: Body, serialized: string, control: PreparedStreamControl): PreparedHttpRequest<State> | Promise<PreparedHttpRequest<State>>
  read(response: Response, body: Body, control: PreparedStreamControl, state: State): AsyncIterable<LLMStreamEvent>
}
/** Encoding/auth/decoding are trusted protocol roles. This fixed implementation
 * owns the complete final generation invocation, not an arbitrary generator. */
export function createPreparedHttpPayload<Body, State>(options: Omit<PreparedPayloadOptions<Body>, 'execute'> & { transport: HttpTerminal<State, Body> }) {
  const terminal = options.transport
  const prepared = createPreparedPayload({ ...options, async *execute(body, serialized, control, execution) {
    if (control.generation && terminal.fetchOverride) throw generationError('GENERATION_UNSUPPORTED')
    let request: PreparedHttpRequest<State>
    try { request = await terminal.prepare(body, serialized, control) }
    catch (error) {
      if (control.signal?.aborted || isGenerationError(error) || isExecutionControlError(error)) throw error
      yield { type: 'error', error: error instanceof Error ? error : new Error('Protocol request preparation failed') }
      return
    }
    const signals = [control.signal, request.init.signal].filter((signal): signal is AbortSignal => !!signal)
    const init: RequestInit = { ...request.init, method: 'POST', body: serialized,
      ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
      ...(control.generation ? { redirect: 'error' } : {}),
    }
    let response: Response
    try {
      if (terminal.proxy === 'system') response = await systemFetch(request.url, init, async () => {
        const issue = await execution.reserve()
        return () => issue(request.identity)
      })
      else {
        const issue = await execution.reserve()
        issue(request.identity)
        response = await (terminal.fetchOverride ?? globalThis.fetch)(request.url, init)
      }
    } catch (error) {
      if (control.signal?.aborted || isGenerationError(error) || isExecutionControlError(error)) throw error
      yield { type: 'error', error: await describeTransportError(terminal.label, request.url, error) }
      return
    }
    if (!response.ok || !response.body) { yield { type: 'error', error: await describeHttpError(terminal.label, response, control) }; return }
    reportStreamActivity({ ...options.request, ...control }, 'response-start')
    yield* terminal.read(response, body, control, request.state)
  } })
  return terminal.fetchOverride ? prepared : ownPreparedTerminal(prepared)
}
