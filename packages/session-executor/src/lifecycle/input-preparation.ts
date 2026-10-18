import { createInputPreparationOwner } from './input-preparation-owner.ts'
import { type AdmittedInput, type FactOwner } from '@i-harness/core-session'
import { generationError } from '@i-harness/llm-seam'
import type { SessionAssembly } from '../assembly.ts'
import type { openExecutorDocument } from './managed-document.ts'
import { createGenerationLifecycle } from './generation-actions.ts'

interface InputExecutionOptions {
  ownerSessionId: string
  acquire(): ReturnType<typeof openExecutorDocument>
  assemble(): Promise<SessionAssembly>
  input: AdmittedInput
  alreadyAdmitted: boolean
  signal: AbortSignal
  modelActionTimeoutMs?: number
  modelActionMaxAttempts?: number
  localTestEnabled?: boolean
  prepare?: (assembly: SessionAssembly, prompt: string) => Promise<string>
}

/** Called at authorized execution start, before acquisition/admission I/O. */
export async function prepareInputExecution(options: InputExecutionOptions) {
  const start = { wall: Date.now(), monotonic: performance.now() }
  const attachment = await options.acquire(), owner: FactOwner = attachment.factOwner
  // Receipt uses the already registered input source even when optional work
  // is blocked by a retained source fault. The original clock still starts
  // before acquisition/admission; no model action may bypass that fault.
  if (!options.alreadyAdmitted) await attachment.inbox.admit(options.input, options.signal)
  let assembled: SessionAssembly | undefined
  const action = owner.beginAction(options.signal), generations = createGenerationLifecycle(owner.view, options.ownerSessionId, action, { enabled: options.localTestEnabled === true, selectedClient: () => assembled?.selectedModel() })
  const preparations = createInputPreparationOwner(owner.view, action, {
    ready: async () => { assembled = await options.assemble() },
    transform: options.prepare ? text => options.prepare!(assembled!, text) : undefined,
    cancel: inputId => attachment.inbox.cancel(inputId, 'input preparation did not reach promotion'),
  })
  let generation: Awaited<ReturnType<typeof generations.open>> | undefined
  const finish = async () => {
    const errors: unknown[] = []
    try { await generations.drain() } catch (error) { errors.push(error) }
    try { await preparations.close() } catch (error) { errors.push(error) }
    action.finish()
    if (errors.length) throw new AggregateError(errors, 'Input preparation settlement requires recovery')
  }
  try {
    const admission = owner.view.events.findLast(event => event.type === 'agent/input/admitted' && event.inputId === options.input.inputId)
    if (admission?.type !== 'agent/input/admitted' || admission.text !== options.input.text || !attachment.inbox.isPending(admission.inputId)) throw generationError('GENERATION_STALE')
    const origin = admission.intent === 'system' ? { kind: 'observation-input' as const, seq: admission.seq!, inputId: admission.inputId } : { kind: 'input' as const, seq: admission.seq! }
    generation = await generations.open('main', origin, { signal: options.signal, timeoutMs: options.modelActionTimeoutMs, maxAttempts: options.modelActionMaxAttempts, start })
    const preparation = await preparations.prepare(admission, generation), ownedGeneration = generation
    return { assembly: assembled!, generation, preparation, async close() {
      try {
        await ownedGeneration.close(options.signal.aborted ? 'stopped' : 'failed')
        if (attachment.inbox.isPending(options.input.inputId)) await attachment.inbox.cancel(options.input.inputId, 'generation ended before promotion')
      } finally { await finish() }
    } }
  } catch (error) {
    const saving: unknown[] = []
    try { await generation?.close(options.signal.aborted ? 'stopped' : 'failed') } catch (failure) { saving.push(failure) }
    try { await finish() } catch (failure) { saving.push(failure) }
    if (saving.length) throw new AggregateError([error, ...saving], 'Input preparation requires recovery', { cause: error })
    throw error
  }
}
