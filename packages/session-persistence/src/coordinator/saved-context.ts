import { types } from 'node:util'
import { deriveContextBudget, deriveContextRecovery, type SessionView } from '@i-harness/core-session'
import { deriveLastProviderInput } from '@i-harness/core-session/internal/archive'
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
  const coverage = Object.getOwnPropertyDescriptor(binding, 'identityCoverage')?.value
  const fingerprint = Object.getOwnPropertyDescriptor(binding, 'bindingConfigFingerprint')?.value
  return { modelId: model.value, protocol: protocol.value, ...(provider?.value === undefined ? {} : { providerId: provider.value }),
    ...(coverage === 'complete' && typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint) ? {
      identityCoverage: coverage, bindingConfigFingerprint: fingerprint,
    } : {}) }
}

function hasOriginalBinding(budget: SavedContextFacts['budget'], binding?: SavedContextBinding): boolean {
  return budget?.version === 2 && budget.identityCoverage === 'complete' && binding?.identityCoverage === 'complete' &&
    budget.bindingConfigFingerprint !== undefined && budget.bindingConfigFingerprint === binding.bindingConfigFingerprint &&
    budget.providerId !== undefined && budget.providerId === binding.providerId && budget.modelId === binding.modelId && budget.protocol === binding.protocol
}

function detach(budget: SavedContextFacts['budget'], recovery: SavedContextFacts['recovery'], tokens?: number): SavedContextFacts {
  return structuredClone({ ...(budget ? { budget } : {}), ...(recovery ? { recovery } : {}),
    ...(tokens === undefined ? {} : { lastReportedInputTokens: tokens }) })
}

export function savedContextFromSession(session: SessionView, sessionId: string, binding?: SavedContextBinding): SavedContextFacts {
  const budget = deriveContextBudget(session, sessionId)
  const tokens = hasOriginalBinding(budget, binding) ? deriveLastProviderInput(session.events, sessionId)?.tokens : undefined
  return detach(budget, deriveContextRecovery(session, sessionId, binding ?? budget), tokens)
}

export function savedContextFromObservation(observation: ExecutionObservation, binding?: SavedContextBinding): SavedContextFacts {
  const budget = observation.budget()
  const tokens = hasOriginalBinding(budget, binding) ? observation.lastReportedInputTokens() : undefined
  const facts = detach(budget, observation.recovery(binding ?? budget), tokens)
  observation.assertCurrent()
  return facts
}
