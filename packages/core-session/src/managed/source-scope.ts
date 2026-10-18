import { managedFactOwners } from '../events/state.ts'
import type { SessionView } from './types.ts'

const scopes = new WeakMap<object, { view: SessionView; owner: object }>()
/** Composition binds sources using the same actual owner as the private view.
 * Tool payloads have neither that owner nor a source-construction capability. */
export function bindFactSettlementSource(view: SessionView, owner: object, source: object): void {
  if (managedFactOwners.get(view) !== owner) throw new TypeError('FACT_OWNER_UNSUPPORTED')
  scopes.set(source, { view, owner })
}
export function delegateFactSettlementSource<T extends object>(parent: object, source: T): T {
  const scope = scopes.get(parent)
  if (scope) scopes.set(source, scope)
  return source
}
export function isManagedSettlementSource(view: SessionView, source: object): boolean {
  const scope = scopes.get(source)
  return scope?.view === view && managedFactOwners.get(view) === scope.owner
}
