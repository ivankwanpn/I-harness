import { isStrictFactData } from './capture.ts'
import type { ContextReductionDraft } from './groups.ts'

const recordFields = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const dense = (value: unknown, valid: (entry: unknown) => boolean): value is readonly unknown[] => Array.isArray(value)
  && Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) && valid(value[index])).every(Boolean)
const address = (value: unknown): boolean => recordFields(value, ['seq','part']) && count(value.seq) && typeof value.part === 'string' && value.part.length > 0 && Buffer.byteLength(value.part) <= 64
const reference = (value: unknown): boolean => recordFields(value, ['kind','at']) && ['input','exchange','summary'].includes(value.kind as string) && address(value.at)

/** A closed optional capability may carry rewrite data only. */
export function validContextReductionDraft(value: unknown): value is ContextReductionDraft {
  if (!value || typeof value !== 'object' || !isStrictFactData(value) || !recordFields(value, ['kind','events'])) return false
  const draft = value as ContextReductionDraft
  if (draft.kind !== 'context-reduction' || !Array.isArray(draft.events) || !draft.events.length) return false
  const fields = {
    'compaction/replacement': ['type','version','replacementId','coverage','insertBefore','text'],
    'compaction/prune': ['type','version','pruned'], 'compaction/reset': ['type','removedSeqs'],
  }
  if (Reflect.ownKeys(draft.events).length !== draft.events.length + 1) return false
  for (let i = 0; i < draft.events.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(draft.events, String(i))
    if (!slot?.enumerable || !('value' in slot)) return false
    const event = slot.value
    if (!event || typeof event !== 'object') return false
    const type = Object.getOwnPropertyDescriptor(event, 'type')?.value
    if (typeof type !== 'string' || !Object.hasOwn(fields, type)) return false
    const allowed = fields[type as keyof typeof fields]
    if (!recordFields(event, allowed)) return false
    if (event.type === 'compaction/reset' && !dense(event.removedSeqs, count)) return false
    if (event.type === 'compaction/prune' && (event.version !== 1 || !dense(event.pruned, entry => recordFields(entry, ['callId','head','tail','removedBytes'])
      && typeof entry.callId === 'string' && !!entry.callId && typeof entry.head === 'string' && typeof entry.tail === 'string' && count(entry.removedBytes)))) return false
    if (event.type === 'compaction/replacement' && (event.version !== 1 || typeof event.replacementId !== 'string' || !/^[\x00-\x7f]{1,256}$/.test(event.replacementId)
      || typeof event.text !== 'string' || !event.text.trim() || !reference(event.insertBefore) || !dense(event.coverage, entry => recordFields(entry, ['item','sources'])
        && reference(entry.item) && dense(entry.sources, address) && entry.sources.length > 0) || event.coverage.length === 0)) return false
  }
  return true
}
