import { types } from 'node:util'
import { isStrictFactData } from './capture.ts'

export type SettlementEventKind = 'tool-result' | 'code' | 'delivery' | 'rewind' | 'retention' | 'lifecycle' | 'usage' | 'assistant-audit'
const delivery = new Set(['subagent/end', 'subagent/inbox', 'job/status', 'team/member', 'team/task', 'team/message/queued', 'team/message/delivered'])
const lifecycle = new Set(['step/end', 'turn/end', 'step/failed', 'reasoning'])
const terminal = new Set(['completed', 'failed', 'terminated', 'interrupted'])

/** Validate only the source constructor's structural discriminator. Valid
 * ordinary output still follows its existing one-time legacy lowering. */
export function validSettlementEvent(kind: SettlementEventKind, event: unknown): boolean {
  if (!event || typeof event !== 'object' || types.isProxy(event)) return false
  try {
    const type = Object.getOwnPropertyDescriptor(event, 'type')
    if (!type || !('value' in type) || typeof type.value !== 'string') return false
    switch (kind) {
      case 'tool-result': return type.value === 'tool/result'
      case 'code': {
        if (type.value === 'code/result' || type.value === 'code/output') return true
        const state = Object.getOwnPropertyDescriptor(event, 'state')
        return type.value === 'code/cell' && !!state && 'value' in state && terminal.has(state.value)
      }
      case 'delivery': return delivery.has(type.value)
      case 'rewind': return type.value === 'rewind/point'
      case 'retention': return type.value === 'context/result-ref' && isStrictFactData(event)
      case 'lifecycle': return lifecycle.has(type.value)
      case 'usage': return type.value === 'context/usage'
      case 'assistant-audit': return type.value === 'assistant/message'
    }
  } catch { return false }
}
