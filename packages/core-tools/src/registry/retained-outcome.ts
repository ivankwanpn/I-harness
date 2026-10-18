import { committedFactSeqs, FactRecoveryRequiredError, isManagedSettlementSource, isNondurableSession, type CapturedSettlementFact, type ProducerFactOutcome, type SessionView, type SettlementFacts } from '@i-harness/core-session'
import type { PreparedCall, ToolExec } from '../types.ts'

export interface RetainedOutcomeSink {
  beforeRead(refresh: () => Promise<void>): void
  observed(): void
  progress(): void
  unavailable(): void
  requireRecovery(): void
  ready(output: unknown): void
}
export interface RetainedToolOutcome {
  take(): Promise<{ kind: 'ready'; output: unknown } | { kind: 'recovery-required' }>
  drainReferences(): Promise<void>
}
interface ValueSource { observed: number; state: 'unknown' | 'progress' | 'ready' | 'consumed'; output?: unknown; refresh?: () => Promise<void>; changed: ReturnType<typeof Promise.withResolvers<void>> }
interface Scope { exec: ToolExec; view: SessionView; source: SettlementFacts<ProducerFactOutcome> }
interface Dispatch { scope: Scope; sources: ValueSource[]; references: Set<CapturedSettlementFact<ProducerFactOutcome>>; open: boolean; ordinal: number }
const preparedScopes = new WeakMap<PreparedCall, Scope>(), dispatches = new WeakMap<ToolExec, Dispatch>()
const recoveries = new WeakMap<object, { prepared: PreparedCall; outcome: RetainedToolOutcome }>()

export function assertToolSettlementScope(view: SessionView | undefined, source: SettlementFacts<ProducerFactOutcome> | undefined): void {
  if (!view) { if (source) throw Object.assign(new Error('Tool settlement requires its actual view'), { code: 'FACT_OWNER_UNSUPPORTED' }); return }
  if (!isNondurableSession(view) && (!source || !isManagedSettlementSource(view, source))) throw Object.assign(new Error('Tool settlement requires its owned source'), { code: 'FACT_OWNER_UNSUPPORTED' })
  source?.assertHeld()
}
export function bindPreparedSettlement(prepared: PreparedCall, source?: SettlementFacts<ProducerFactOutcome>): void {
  assertToolSettlementScope(prepared.exec.session, source)
  if (source) preparedScopes.set(prepared, { exec: prepared.exec, view: prepared.exec.session!, source })
}
function assertScope(scope: Scope, prepared: PreparedCall): void {
  if (prepared.exec !== scope.exec || prepared.exec.session !== scope.view) throw new FactRecoveryRequiredError()
  assertToolSettlementScope(scope.view, scope.source)
}
function isRecovery(error: unknown): boolean {
  return error instanceof Error && ['FACT_RECOVERY_REQUIRED', 'FACT_CAPTURE_FAILED', 'FACT_INSTALL_FAILED'].includes(String((error as { code?: string }).code ?? ''))
}
function selected(dispatch: Dispatch): ValueSource | undefined {
  return dispatch.sources.filter(source => source.observed).sort((a, b) => b.observed - a.observed)[0]
}
export function hasRetainedToolBody(exec: ToolExec, error: unknown): boolean {
  const dispatch = dispatches.get(exec)
  return !!dispatch && isRecovery(error) && !!selected(dispatch)
}
export function retainedToolOutcome(error: unknown, prepared: PreparedCall): RetainedToolOutcome | undefined {
  const retained = error && typeof error === 'object' ? recoveries.get(error) : undefined
  return retained?.prepared === prepared ? retained.outcome : undefined
}
function thenable(value: unknown): boolean {
  if (!value || typeof value !== 'object' && typeof value !== 'function') return false
  const seen = new Set<object>()
  for (let current: object | null = value as object; current; current = Object.getPrototypeOf(current)) {
    if (seen.has(current)) return true
    seen.add(current)
    const descriptor = Object.getOwnPropertyDescriptor(current, 'then')
    if (descriptor) return !('value' in descriptor) || typeof descriptor.value === 'function'
  }
  return false
}

/** Registered on the real dispatch scope before executing a body. Only this
 * registry can brand recovery; ordinary Errors and payload flags carry none. */
export function beginRetainedDispatch(prepared: PreparedCall) {
  const scope = preparedScopes.get(prepared)
  if (!scope) return undefined
  assertScope(scope, prepared)
  const dispatch: Dispatch = { scope, sources: [], references: new Set(), open: true, ordinal: 0 }
  dispatches.set(prepared.exec, dispatch)
  const register = (): RetainedOutcomeSink => {
    assertScope(scope, prepared)
    if (!dispatch.open) throw new FactRecoveryRequiredError()
    const source: ValueSource = { observed: 0, state: 'unknown', changed: Promise.withResolvers<void>() }
    dispatch.sources.push(source)
    const change = () => { const previous = source.changed; source.changed = Promise.withResolvers<void>(); previous.resolve() }
    return {
      beforeRead(refresh) { assertScope(scope, prepared); if (!dispatch.open || source.observed || source.refresh) throw new FactRecoveryRequiredError(); source.refresh = refresh },
      observed() { assertScope(scope, prepared); source.observed ||= ++dispatch.ordinal },
      progress() { assertScope(scope, prepared); if (source.state !== 'ready' && source.state !== 'consumed') { source.state = 'progress'; change() } },
      unavailable() { assertScope(scope, prepared); if (source.state !== 'ready' && source.state !== 'consumed') { source.state = 'unknown'; change() } },
      requireRecovery() {
        assertScope(scope, prepared)
        if (!source.observed || source.state === 'ready' || source.state === 'consumed') throw new FactRecoveryRequiredError()
        scope.source.requireRecovery()
      },
      ready(output) {
        assertScope(scope, prepared)
        if (!source.observed || source.state === 'consumed') throw new FactRecoveryRequiredError()
        let unsupported = true
        try { unsupported = thenable(output) } catch { /* Retain unsupported real data without invoking it. */ }
        if (unsupported) { source.output = output; scope.source.requireRecovery(); throw new FactRecoveryRequiredError() }
        if (source.state === 'ready') { if (source.output !== output) throw new FactRecoveryRequiredError(); return }
        source.output = output; source.state = 'ready'; change()
      },
    }
  }
  Object.defineProperty(prepared.exec, 'retainOutcome', { value: register, enumerable: false, configurable: true })
  Object.defineProperty(prepared.exec, 'retainResultReference', { enumerable: false, configurable: true, value: async (event: Parameters<typeof scope.source.retention.capture>[0]) => {
    assertScope(scope, prepared)
    const fact = scope.source.retention.capture(event)
    dispatch.references.add(fact)
    committedFactSeqs(await fact.admit())
    dispatch.references.delete(fact)
  } })
  const body = register()
  const finish = () => { dispatch.open = false; delete prepared.exec.retainOutcome; delete prepared.exec.retainResultReference }
  return {
    body,
    success() { finish(); dispatches.delete(prepared.exec); for (const source of dispatch.sources) { source.output = undefined; source.state = 'consumed' } },
    failure(error: unknown) {
      finish()
      const source = isRecovery(error) ? selected(dispatch) : undefined
      if (!source) { dispatches.delete(prepared.exec); return error }
      const outcome: RetainedToolOutcome = {
        async take() {
          assertScope(scope, prepared)
          for (const fact of dispatch.references) {
            try { committedFactSeqs(await fact.reconcile()); dispatch.references.delete(fact) }
            catch { return { kind: 'recovery-required' } }
          }
          if (source.state !== 'ready' && source.state !== 'consumed' && source.refresh) {
            try { await source.refresh() } catch { return { kind: 'recovery-required' } }
            assertScope(scope, prepared)
          }
          while (source.state === 'progress') { await source.changed.promise; assertScope(scope, prepared) }
          if (source.state !== 'ready') return { kind: 'recovery-required' }
          const output = source.output; source.output = undefined; source.state = 'consumed'
          return { kind: 'ready', output }
        },
        async drainReferences() {
          assertScope(scope, prepared)
          const errors: unknown[] = []
          for (const fact of dispatch.references) try { committedFactSeqs(await fact.reconcile()); dispatch.references.delete(fact) } catch (error) { errors.push(error) }
          if (errors.length) throw new FactRecoveryRequiredError()
        },
      }
      const recovery = Object.assign(new FactRecoveryRequiredError(), { cause: error })
      recoveries.set(recovery, { prepared, outcome })
      return recovery
    },
  }
}
