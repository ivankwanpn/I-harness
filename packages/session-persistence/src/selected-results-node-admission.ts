import { types } from 'node:util'
/** Apply at Node trust boundaries before invoking the descriptor-based browser readers. */
export function assertSelectedResultsNodeAdmission(value: unknown): void {
  const visiting = new Set<object>()
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return
    if (types.isProxy(v) || visiting.has(v)) throw new TypeError('Invalid selected results node data')
    visiting.add(v)
    for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) if ('value' in d) walk(d.value)
    visiting.delete(v)
  }
  walk(value)
}
