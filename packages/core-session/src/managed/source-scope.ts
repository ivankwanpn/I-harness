import { managedFactOwners } from '../events/state.ts'
import type { SessionView } from './types.ts'

const scopes = new WeakMap<object, { view: SessionView; owner: object; sessionId: string }>()
const memoryScopes = new WeakMap<object, SessionView>()
export function bindMemorySettlementSource(view: SessionView, source: object): void { memoryScopes.set(source, view) }
export function isOwnedSettlementSource(view: SessionView, source: object): boolean { return isManagedSettlementSource(view, source) || memoryScopes.get(source) === view }
/** Composition binds sources using the same actual owner as the private view.
 * Tool payloads have neither that owner nor a source-construction capability. */
export function bindFactSettlementSource(view: SessionView, owner: object, source: object, sessionId: string): void {
  if (managedFactOwners.get(view) !== owner) throw new TypeError('FACT_OWNER_UNSUPPORTED')
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('FACT_OWNER_UNSUPPORTED')
  scopes.set(source, { view, owner, sessionId })
}
/** Returns identity only for the existing genuine source/view/owner binding. */
export function settlementSourceSessionId(view: SessionView, source: object): string | undefined {
  return isManagedSettlementSource(view, source) ? scopes.get(source)?.sessionId : undefined
}
export function delegateFactSettlementSource<T extends object>(parent: object, source: T): T {
  const scope = scopes.get(parent)
  if (scope) scopes.set(source, scope)
  const memoryView = memoryScopes.get(parent)
  if (memoryView) memoryScopes.set(source, memoryView)
  return source
}
export function isManagedSettlementSource(view: SessionView, source: object): boolean {
  const scope = scopes.get(source)
  return scope?.view === view && managedFactOwners.get(view) === scope.owner
}
