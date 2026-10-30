import { isManagedFactOwner, isNondurableFactOwner, type FactOwner, type SessionView } from '@i-harness/core-session'
import type { ToolRegistry } from '@i-harness/core-tools'
import type { ConstructorModelOriginVerifier, PreparedModelOriginDriver } from '@i-harness/core-tools/model-origin'
import { takeModelMember } from './live-continuation.ts'

export type AgentModelOriginBinding = object
export interface ModelOriginState { view: SessionView; factOwner: FactOwner; registry: ToolRegistry; driver: PreparedModelOriginDriver; consumed: boolean }
type State = ModelOriginState
const bindings = new WeakMap<object, State>()
export function createAgentModelOriginOwner({ view, factOwner }: { view: SessionView; factOwner: FactOwner }) {
  if (!isManagedFactOwner(view, factOwner) && !isNondurableFactOwner(view, factOwner)) throw new Error('Original fact owner required')
  let bound = false
  let state: State | undefined
  const verifier: ConstructorModelOriginVerifier = Object.freeze({ take(proof: object, expected: import('@i-harness/core-tools/model-origin').ModelOriginExpectation) { if (!state) throw new Error('Unbound model origin'); return takeModelMember(state, proof, expected) } })
  return { verifier, bind(registry: ToolRegistry, driver: PreparedModelOriginDriver): AgentModelOriginBinding {
    if (bound) throw new Error('Model origin already bound')
    bound = true
    const binding = Object.freeze({})
    state = { view, factOwner, registry, driver, consumed: false }
    bindings.set(binding, state)
    return binding
  } }
}
export function consumeAgentModelOrigin(binding: AgentModelOriginBinding, view: SessionView, factOwner: FactOwner, registry: ToolRegistry): State {
  const state = bindings.get(binding)
  if (!state || state.consumed || state.view !== view || state.factOwner !== factOwner || state.registry !== registry) throw new Error('Original model origin binding required')
  state.consumed = true
  return state
}
