import { conversationFormatError as fail } from '../events/conversation.ts'
import { eligibleWorkflowTerminal, workflowTerminalRef, type WorkflowDeliverySourceEvent, type WorkflowTerminalEvent } from '../events/workflow-delivery.ts'
import type { DeliveryKey } from '../events/delivery.ts'
export interface WorkflowDeliveryCandidate { source: Readonly<WorkflowDeliverySourceEvent>; terminal: Readonly<WorkflowTerminalEvent> }
/** Workflow-only scalar stage; generation, recipient and receipt authority stay
 * in the original delivery index. No runtime/capture/issuer implementation. */
export function createWorkflowDeliveryIndex() {
  const terminals = new Map<number, WorkflowTerminalEvent>(), handoffs = new Set<number>(), pending = new Map<number, WorkflowDeliveryCandidate>()
  return {
    pending: () => [...pending.values()].map(value => structuredClone(value)),
    stage(context: { source(seq: number): WorkflowDeliverySourceEvent | undefined; generation(): string | undefined; received(key: DeliveryKey): boolean }) {
      const staged = new Map<number, WorkflowTerminalEvent>(), routed = new Set<number>(), candidates = new Map<number, WorkflowDeliveryCandidate | undefined>()
      const terminal = (seq: number) => staged.get(seq) ?? terminals.get(seq)
      const parent = (binding: WorkflowDeliverySourceEvent) => binding.delivery === 'parent' || handoffs.has(binding.seq!) || routed.has(binding.seq!)
      const refresh = (binding: WorkflowDeliverySourceEvent) => {
        const end = terminal(binding.seq!), ref = end && workflowTerminalRef(end)
        const key: DeliveryKey | undefined = ref && { kind: 'workflow', sourceNamespace: 'workflow', recipientSessionId: binding.recipientSessionId, sourceId: binding.sourceId, resultRevision: ref.revision }
        candidates.set(binding.seq!, end && key && parent(binding) && eligibleWorkflowTerminal(end) && binding.generationId === context.generation() && !context.received(key) ? { source: binding, terminal: end } : undefined)
      }
      return {
        parent,
        handoff(sourceSeq: number, seq: number) {
          const binding = context.source(sourceSeq)
          if (!binding || sourceSeq >= seq || binding.generationId !== context.generation() || parent(binding)) fail('invalid Workflow parent handoff')
          routed.add(sourceSeq); refresh(binding)
        },
        end(event: WorkflowTerminalEvent) {
          const binding = context.source(event.sourceSeq)
          if (!binding || event.sourceSeq >= event.seq! || binding.sourceId !== event.invocationId || terminal(event.sourceSeq)) fail('invalid or duplicate Workflow terminal')
          staged.set(event.sourceSeq, event); refresh(binding)
        },
        received(seq: number) { candidates.set(seq, undefined) },
        commit(generationChanged: boolean) {
          for (const [seq, end] of staged) terminals.set(seq, end)
          for (const seq of routed) handoffs.add(seq)
          if (generationChanged) pending.clear()
          for (const [seq, candidate] of candidates) {
            if (candidate && candidate.source.generationId === context.generation()) pending.set(seq, candidate)
            else pending.delete(seq)
          }
        },
      }
    },
  }
}
