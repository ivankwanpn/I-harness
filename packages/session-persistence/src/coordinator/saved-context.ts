import { types } from 'node:util'
import { deriveContextBudget, deriveContextRecovery, type SessionView } from '@i-harness/core-session'
import type { ExecutionObservation } from '@i-harness/core-session/internal/execution'
import type { SavedContextBinding, SavedContextFacts } from './types.ts'

export function captureSavedContextBinding(binding?: SavedContextBinding): SavedContextBinding | undefined {
  if (binding === undefined) return undefined
  const invalid = () => new TypeError('Saved context binding scalars required')
  if (!binding || typeof binding !== 'object' || types.isProxy(binding)) throw invalid()
  const model = Object.getOwnPropertyDescriptor(binding, 'modelId')
  const protocol = Object.getOwnPropertyDescriptor(binding, 'protocol')
  const provider = Object.getOwnPropertyDescriptor(binding, 'providerId')
  if (!model || !('value' in model) || typeof model.value !== 'string' ||
    !protocol || !('value' in protocol) || typeof protocol.value !== 'string' ||
    provider && (!('value' in provider) || provider.value !== undefined && typeof provider.value !== 'string')) throw invalid()
  return { modelId: model.value, protocol: protocol.value, ...(provider?.value === undefined ? {} : { providerId: provider.value }) }
}

function detach(budget: SavedContextFacts['budget'], recovery: SavedContextFacts['recovery']): SavedContextFacts {
  return structuredClone({ ...(budget ? { budget } : {}), ...(recovery ? { recovery } : {}) })
}

export function savedContextFromSession(session: SessionView, sessionId: string, binding?: SavedContextBinding): SavedContextFacts {
  const budget = deriveContextBudget(session, sessionId)
  return detach(budget, deriveContextRecovery(session, sessionId, binding ?? budget))
}

export function savedContextFromObservation(observation: ExecutionObservation, binding?: SavedContextBinding): SavedContextFacts {
  const budget = observation.budget()
  const facts = detach(budget, observation.recovery(binding ?? budget))
  observation.assertCurrent()
  return facts
}
