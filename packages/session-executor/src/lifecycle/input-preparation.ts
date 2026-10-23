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
  const action = owner.beginAction(options.signal), closeDecided = Promise.withResolvers<void>()
  let generations: ReturnType<typeof createGenerationLifecycle> | undefined, preparations: ReturnType<typeof createInputPreparationOwner> | undefined
  let generation: Awaited<ReturnType<ReturnType<typeof createGenerationLifecycle>['open']>> | undefined
  const closeGeneration = () => {
    // close() captures its original required terminal fact synchronously.
    // Release the source prerequisite before joining that fact or its drain.
    try { return generation?.close(options.signal.aborted ? 'stopped' : 'failed') }
    finally { closeDecided.resolve() }
  }
  const finish = async () => {
    const errors: unknown[] = []
    closeDecided.resolve()
    try { action.finish() } catch (error) { errors.push(error) }
    try { await generations?.drain() } catch (error) { errors.push(error) }
    try { await preparations?.close() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Input preparation settlement requires recovery')
  }
  try {
    generations = createGenerationLifecycle(owner.view, options.ownerSessionId, action, { enabled: options.localTestEnabled === true, selectedClient: () => assembled?.selectedModel() }, { beforeDrain: () => closeDecided.promise })
    preparations = createInputPreparationOwner(owner.view, action, {
      ready: async () => { assembled = await options.assemble() },
      transform: options.prepare ? text => options.prepare!(assembled!, text) : undefined,
      cancel: inputId => attachment.inbox.cancel(inputId, 'input preparation did not reach promotion'),
    })
    const admission = owner.view.events.findLast(event => event.type === 'agent/input/admitted' && event.inputId === options.input.inputId)
    if (admission?.type !== 'agent/input/admitted' || admission.text !== options.input.text || !attachment.inbox.isPending(admission.inputId)) throw generationError('GENERATION_STALE')
    const origin = admission.intent === 'system' ? { kind: 'observation-input' as const, seq: admission.seq!, inputId: admission.inputId } : { kind: 'input' as const, seq: admission.seq! }
    generation = await generations.open('main', origin, { signal: options.signal, timeoutMs: options.modelActionTimeoutMs, maxAttempts: options.modelActionMaxAttempts, start })
    const preparation = await preparations.prepare(admission, generation)
    return { assembly: assembled!, generation, preparation, async close() {
      let failed = false, failure: unknown
      try {
        await closeGeneration()
        if (attachment.inbox.isPending(options.input.inputId)) await attachment.inbox.cancel(options.input.inputId, 'generation ended before promotion')
      } catch (error) { failed = true; failure = error }
      try { await finish() }
      catch (saving) { if (failed) throw new AggregateError([failure, saving], 'Input execution close requires recovery', { cause: failure }); throw saving }
      if (failed) throw failure
    } }
  } catch (error) {
    const saving: unknown[] = []
    try { await closeGeneration() } catch (failure) { saving.push(failure) }
    try { await finish() } catch (failure) { saving.push(failure) }
    if (saving.length) throw new AggregateError([error, ...saving], 'Input preparation requires recovery', { cause: error })
    throw error
  }
}
