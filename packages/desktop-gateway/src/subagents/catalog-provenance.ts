import { validRetainedResultRevision } from '@i-harness/core-session'

/** Auxiliary version is evidence even when no result exists. Only an explicit
 * v1 migration stamp permits historical text classification inside a v2/v3 doc. */
export function currentTaskFormat(task: Record<string, unknown>, version: unknown): boolean {
  if ('legacyFormatVersion' in task && (!Object.hasOwn(task, 'legacyFormatVersion') || task.legacyFormatVersion !== 1 || task.bodyKind !== 'legacy-text'
    || task.result !== undefined || task.publication !== undefined || task.savedObservation !== undefined)) throw new Error('Subagent task legacy provenance is invalid')
  if (version === 1 && (task.result !== undefined || task.publication !== undefined || task.savedObservation !== undefined)) throw new Error('Subagent legacy task metadata is invalid')
  if (task.result !== undefined && !validRetainedResultRevision(task.result)) throw new Error('Subagent task retained metadata is invalid')
  return (version === 2 || version === 3) && task.legacyFormatVersion !== 1
}
