import { isNondurableSession, type FactOwner, type ManagedAction, type ProducerFactOutcome } from '@i-harness/core-session'
import type { TitleGenerationFactory, ModelClient } from '@i-harness/llm-seam'
import { createGenerationLifecycle } from './generation-actions.ts'

/** Host/CLI keeps the original F1 source; title receives only its purpose. */
export function createTitleGenerationContext(owner: FactOwner, sessionId: string, action: ManagedAction<ProducerFactOutcome>, options: { localTestEnabled?: boolean; selectedClient(): ModelClient | undefined }) {
  if (isNondurableSession(owner.view)) return { open: undefined, drain: async () => {} }
  const lifecycle = createGenerationLifecycle(owner.view, sessionId, action, { enabled: options.localTestEnabled === true, selectedClient: options.selectedClient })
  const open: TitleGenerationFactory = async (inputSeq, timeoutMs) => {
    const generation = await lifecycle.open('title', { kind: 'input', seq: inputSeq }, { timeoutMs })
    const capability: Awaited<ReturnType<TitleGenerationFactory>> = { signal: generation.signal, control: generation.control('auxiliary'), bind: prepared => generation.bind(prepared), close: disposition => generation.close(disposition) }
    return Object.freeze(capability)
  }
  return { open, drain: () => lifecycle.drain() }
}
