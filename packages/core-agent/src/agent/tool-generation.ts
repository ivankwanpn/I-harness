import type { AgentDeps } from './types.ts'
import type { ExecuteToolCallsOptions } from '../tool-batch/types.ts'
import { generationError, type AuxiliaryGenerationAction, type ApprovalGenerationAction, type MediaGenerationAction, type ToolModelGeneration } from '@i-harness/llm-seam'
import type { SessionView } from '@i-harness/core-session'

const reviewerBindings = new WeakMap<object, { view: object; action: AuxiliaryGenerationAction; consumed: boolean }>()
/** Read-only validator. Only actual accepted-tool composition below can mint. */
export function borrowApprovalGeneration(binding: object | undefined, view: SessionView): AuxiliaryGenerationAction | undefined {
  if (!binding) return undefined
  const owned = reviewerBindings.get(binding)
  if (!owned || owned.view !== view || owned.consumed || view.header?.origin !== 'approval-review') throw generationError('GENERATION_STALE')
  owned.action.signal.throwIfAborted(); owned.consumed = true
  return owned.action
}

/** These purpose-bound closures capture the exact accepted call and live turn.
 * Code Mode can later attach only its real same-writer invocation source. */
export function toolGenerationFactory(deps: AgentDeps): ExecuteToolCallsOptions['modelGeneration'] {
  const lifecycle = deps.generationLifecycle, parent = deps.generationAction, session = deps.session, assertOpen = deps.assertFactOpen
  const owner = deps.factOwner, generationFactory = deps.generationFactory, sessionId = deps.sessionId
  if (!lifecycle || !parent) return undefined
  const purposes = (source: typeof lifecycle, kind: 'tool' | 'code', eventSeq: number, callId: string, name: string, signal: AbortSignal, check: () => void): ToolModelGeneration => ({
    approval: async options => {
      check()
      const generation = await source.open('approval', { kind, seq: eventSeq, parentActionId: parent.actionId }, { signal, timeoutMs: options.timeoutMs, selectedClient: options.selectedClient, start: { wall: Date.now(), monotonic: performance.now() } })
      let attached = false
      const capability: ApprovalGenerationAction = { signal: generation.signal, control: generation.control('auxiliary', check), bind: (prepared, bindingSource) => generation.bind(prepared, bindingSource), close: disposition => generation.close(disposition), forChild(view) {
        check(); generation.assertOpen()
        const child = view as SessionView
        if (this !== capability || attached || child.header?.origin !== 'approval-review' || child.header.parentSession !== sessionId || child.header.seedLength !== 0) throw generationError('GENERATION_STALE')
        attached = true
        const binding = Object.freeze({})
        reviewerBindings.set(binding, { view, action: capability, consumed: false })
        return binding
      } }
      return Object.freeze(capability)
    },
    media: async timeoutMs => {
      check()
      const dispatch = session.events.findLast(event => event.type === 'tool/dispatch' && kind === 'tool' && event.callId === callId && event.eventSeq === eventSeq
        || event.type === 'code/dispatch' && kind === 'code' && event.callId === callId && event.eventSeq === eventSeq)
      if (name !== 'read_video' || !dispatch || dispatch.type !== 'tool/dispatch' && dispatch.type !== 'code/dispatch') throw generationError('GENERATION_STALE')
      const generation = await source.open('media', { kind, seq: dispatch.seq!, parentActionId: parent.actionId }, { signal, timeoutMs, start: { wall: Date.now(), monotonic: performance.now() } })
      const capability: MediaGenerationAction = { signal: generation.signal, control: generation.control('auxiliary', check), bindAudio: () => generation.bindAudio(), close: disposition => generation.close(disposition) }
      return Object.freeze(capability)
    },
  })
  return (call, signal) => {
    const original = call.eventSeq === undefined ? undefined : session.events[call.eventSeq]
    const checkOrigin = () => {
      signal.throwIfAborted()
      if (!original || original.type !== 'tool/call' || session.events[call.eventSeq!] !== original || original.callId !== call.callId || original.name !== call.name) throw generationError('GENERATION_STALE')
    }
    const check = () => { checkOrigin(); assertOpen?.() }
    const factories = purposes(lifecycle, 'tool', call.eventSeq!, call.callId, call.name, signal, check)
    if (call.name === 'code_exec' && owner && generationFactory) {
      let attached = false
      const lineage: import('@i-harness/llm-seam').CodeGenerationLineage = { forInvocation() { throw generationError('GENERATION_STALE') }, bindCell(cellId) {
        checkOrigin()
        if (this !== lineage || attached || !cellId) throw generationError('GENERATION_STALE')
        attached = true
        const bound: import('@i-harness/llm-seam').CodeGenerationLineage = { bindCell() { throw generationError('GENERATION_STALE') }, forInvocation(input) {
        checkOrigin()
        if (this !== bound || input.cellId !== cellId || input.view !== session || owner.view !== session || !owner.ownsAction?.(input.action) || !input.current()) throw generationError('GENERATION_STALE')
        const invocation = session.events[input.eventSeq]
        if (invocation?.type !== 'code/call' || invocation.cellId !== cellId || invocation.parentCallId !== call.callId || invocation.callId !== input.callId || invocation.name !== input.name || input.eventSeq <= call.eventSeq!) throw generationError('GENERATION_STALE')
        const current = () => {
          checkOrigin(); input.signal.throwIfAborted(); input.action.assertOpen()
          if (!input.current() || session.events[input.eventSeq] !== invocation) throw generationError('GENERATION_STALE')
        }
        const source = generationFactory(input.action)
        return { factories: Object.freeze(purposes(source, 'code', input.eventSeq, input.callId, input.name, input.signal, current)), close: () => source.drain() }
        } }
        return Object.freeze(bound)
      } }
      factories.codeLineage = Object.freeze(lineage)
    }
    return Object.freeze(factories)
  }
}
