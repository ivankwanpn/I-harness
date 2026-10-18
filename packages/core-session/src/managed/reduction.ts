import { isStrictFactData } from './capture.ts'
import type { ContextReductionDraft } from './groups.ts'

/** A closed optional capability may carry rewrite data only. */
export function validContextReductionDraft(draft: ContextReductionDraft): boolean {
  if (!isStrictFactData(draft) || Reflect.ownKeys(draft).some(key => key !== 'kind' && key !== 'events') || !Array.isArray(draft.events) || !draft.events.length) return false
  const fields = {
    'compaction/replacement': ['type','version','replacementId','coverage','insertBefore','text'],
    'compaction/prune': ['type','version','pruned'], 'compaction/reset': ['type','removedSeqs'],
  }
  if (Reflect.ownKeys(draft.events).length !== draft.events.length + 1) return false
  for (let i = 0; i < draft.events.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(draft.events, String(i))
    if (!slot?.enumerable || !('value' in slot)) return false
    const event = slot.value
    if (!event || typeof event !== 'object' || !Object.hasOwn(fields, event.type)) return false
    const allowed = fields[event.type as keyof typeof fields]
    if (Reflect.ownKeys(event).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.getOwnPropertyDescriptor(event, key)?.enumerable)) return false
  }
  return true
}
