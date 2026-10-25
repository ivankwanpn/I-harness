import type { ManagedAction, ProducerFactOutcome, SessionView, SettlementFacts } from '@i-harness/core-session'
import type { PreparedCall, RetainedToolOutcome } from '@i-harness/core-tools'
import type { BatchCall, ExecuteToolCallsOptions } from './types.ts'

export type LiveBatchToken = object
export type CheckpointEvidence = { site: 'retained-dispatch' | 'raw-checkpoint'; error: unknown; index: number; prepared?: PreparedCall; retained?: RetainedToolOutcome }
export interface LiveInvocation {
  readonly view: SessionView
  readonly action: ManagedAction<ProducerFactOutcome>
  registerBatchSource(drain: () => Promise<void>): SettlementFacts<ProducerFactOutcome>
  assertInvocationOpen(): void
  invalidate(): void
}
interface BatchState {
  invocation: LiveInvocation; scope: object; batch: BatchCall[]; options: ExecuteToolCallsOptions
  source?: SettlementFacts<ProducerFactOutcome>; error?: unknown
  phase: 'prepared' | 'marked' | 'reserved' | 'consumed'
}
const invocations = new WeakMap<LiveInvocation, Set<LiveBatchToken>>()
const tokens = new WeakMap<LiveBatchToken, BatchState>()
const optionsTokens = new WeakMap<ExecuteToolCallsOptions, LiveBatchToken>()

/** Created only by the managed Agent's actual withFactAction owner. */
export function createLiveInvocation(view: SessionView, action: ManagedAction<ProducerFactOutcome>, register: LiveInvocation['registerBatchSource']): LiveInvocation {
  const invocation: LiveInvocation = Object.freeze({ view, action,
    registerBatchSource(drain: () => Promise<void>) { invocation.assertInvocationOpen(); return register(drain) },
    assertInvocationOpen() {
      if (!invocations.has(invocation)) throw new Error('Live invocation has expired')
      action.signal.throwIfAborted(); action.assertOpen()
    },
    invalidate() {
      for (const token of invocations.get(invocation) ?? []) releaseLiveBatch(token)
      invocations.delete(invocation)
    },
  })
  invocations.set(invocation, new Set())
  return invocation
}
export function issueLiveBatch(invocation: LiveInvocation, scope: object, batch: BatchCall[], options: ExecuteToolCallsOptions): LiveBatchToken {
  invocation.assertInvocationOpen()
  const token = Object.freeze({})
  tokens.set(token, { invocation, scope, batch, options, phase: 'prepared' })
  optionsTokens.set(options, token); invocations.get(invocation)!.add(token)
  return token
}
/** Capture before resolveBatchFacts creates its options facade. */
export function prepareLiveBatch(options: ExecuteToolCallsOptions, view: SessionView, batch: BatchCall[]): LiveBatchToken | undefined {
  const token = optionsTokens.get(options), state = token && tokens.get(token)
  if (!state || state.options !== options || state.batch !== batch || state.invocation.view !== view || state.phase !== 'prepared') return undefined
  state.invocation.assertInvocationOpen()
  return token
}
export function bindLiveBatchSource(token: LiveBatchToken | undefined, source: SettlementFacts<ProducerFactOutcome>): void {
  const state = token && tokens.get(token)
  if (state && state.phase === 'prepared' && !state.source) state.source = source
}
/** Called by join only after the original source.close resolves. */
export function markLiveBatchClosed(token: LiveBatchToken | undefined, source: SettlementFacts<ProducerFactOutcome>, error: unknown): void {
  const state = token && tokens.get(token)
  if (!state || state.source !== source || state.phase !== 'prepared') return
  try { state.invocation.assertInvocationOpen() } catch { return }
  state.error = error; state.phase = 'marked'
}
export function reserveLiveContinuation(token: LiveBatchToken | undefined, error: unknown, invocation: LiveInvocation | undefined, scope: object, batch: BatchCall[]): boolean {
  const state = token && tokens.get(token)
  if (!state || state.phase !== 'marked' || state.error !== error || state.invocation !== invocation || state.scope !== scope || state.batch !== batch || !invocations.has(invocation!)) return false
  state.phase = 'reserved'
  return true
}
export function consumeLiveContinuation(token: LiveBatchToken): void {
  const state = tokens.get(token)
  if (!state || state.phase !== 'reserved') throw new Error('Live batch continuation is unavailable')
  state.phase = 'consumed'
  releaseLiveBatch(token)
}
export function releaseLiveBatch(token: LiveBatchToken): void {
  const state = tokens.get(token)
  if (!state) return
  optionsTokens.delete(state.options); invocations.get(state.invocation)?.delete(token); tokens.delete(token)
}
