import { types } from 'node:util'
import type { SessionEventView } from '../managed/types.ts'

/** Source indexing reads metadata, never discarded payloads. Check that graph
 * by descriptor before even the discriminant/seq is used by readiness/history.
 * Selected payload slots remain owned by the renderer's capture port. */
export function validateSemanticSourceMetadata(event: SessionEventView): void {
  const fail = (): never => { throw new TypeError('Invalid semantic source metadata') }
  const ancestors = new Set<object>()
  const work: ({ value: unknown; images?: boolean } | { leave: object })[] = [{ value: event }]
  while (work.length) {
    const task = work.pop()!
    if ('leave' in task) { ancestors.delete(task.leave); continue }
    const value = task.value
    if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') continue
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); continue }
    if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) fail()
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail()
    const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields)
    if (keys.some(key => typeof key !== 'string') || array && keys.length !== value.length + 1) fail()
    // History only needs image presence/count. Image objects and their byte
    // fields are payloads, captured only for selected messages/results.
    if (task.images) { if (!array) fail(); continue }
    ancestors.add(value); work.push({ leave: value })
    for (const key of keys as string[]) {
      if (array && key === 'length') continue
      const field = fields[key]!
      if (['text', 'content', 'args', 'output', 'thinkingBlocks', 'providerContinuation'].includes(key)
        || key === 'value' && fields.kind?.value === 'inline'
        || key === 'preview' && fields.retention) continue
      if (!field.enumerable || !('value' in field)) fail()
      work.push({ value: field.value, images: key === 'images' || key === 'media' && !!fields.retention })
    }
  }
  const fields = Object.getOwnPropertyDescriptors(event)
  if (typeof fields.type?.value !== 'string' || fields.seq && (fields.seq.value === undefined || !Number.isSafeInteger(fields.seq.value) || fields.seq.value < 0)) fail()
}
