import type { ManagedAction, ProducerFactOutcome } from '@i-harness/core-session'
import type { SessionAssembly } from '../assembly.ts'
import type { SessionModelBindingResult, SessionServiceOptions } from '../service.ts'
import { createTitleGenerationContext } from '../lifecycle/title-generation.ts'

/** Host callbacks remain fail-soft; required title-source settlement does not.
 * The exact original callback failure remains primary if its drain also fails. */
export async function runPostSubmit(options: {
  sessionId: string; assembly: SessionAssembly; signal: AbortSignal; localTestEnabled: boolean
  binding(): Promise<SessionModelBindingResult>
  callback: NonNullable<SessionServiceOptions['afterSuccessfulSubmit']>
  warn(error: unknown): void
}): Promise<void> {
  const { assembly, signal } = options
  let action: ManagedAction<ProducerFactOutcome> | undefined
  let title: ReturnType<typeof createTitleGenerationContext> | undefined
  let failed = false, failure: unknown
  try {
    if (assembly.factOwner.view !== assembly.session) throw Object.assign(new Error('Post-turn action requires its actual Session view'), { code: 'FACT_OWNER_UNSUPPORTED' })
    action = assembly.factOwner.beginAction(signal)
    title = createTitleGenerationContext(assembly.factOwner, options.sessionId, action, { localTestEnabled: options.localTestEnabled, selectedClient: assembly.selectedModel })
    const state = await options.binding()
    action.assertOpen()
    await options.callback(options.sessionId, assembly, state.status === 'ready'
      ? { ...(state.binding.contextWindow !== undefined ? { contextWindow: state.binding.contextWindow } : {}), ...(state.binding.maxOutputTokens !== undefined ? { maxOutputTokens: state.binding.maxOutputTokens } : {}) }
      : {}, { view: assembly.session, signal: action.signal, assertOpen: action.assertOpen, facts: { metadata: action.facts.metadata }, openGeneration: title.open })
  } catch (error) {
    failed = true; failure = error
    try { options.warn(error) } catch { /* Optional diagnostics do not change host-callback policy. */ }
  } finally {
    try { await title?.drain() }
    catch (saving) { throw failed ? new AggregateError([failure, saving], 'Post-turn settlement requires recovery', { cause: failure }) : saving }
    finally { action?.finish() }
  }
}
