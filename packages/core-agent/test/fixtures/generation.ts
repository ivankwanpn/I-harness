import type { FactOwner } from '@i-harness/core-session'
import type { ModelClient } from '@i-harness/llm-seam'
import { createGenerationLifecycle } from '../../../session-executor/src/lifecycle/generation-actions.ts'

/** Explicit built-in local-test execution for existing persistence/effect
 * controls. These invocations make no physical transport or payload claim. */
export const localTestGeneration = (owner: FactOwner, sessionId: string, model: ModelClient) =>
  (action: Parameters<typeof createGenerationLifecycle>[2]) => createGenerationLifecycle(owner.view, sessionId, action, { enabled: true, selectedClient: () => model })
