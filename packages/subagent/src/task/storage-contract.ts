import type { SessionEventView } from '@i-harness/core-session'
import { validateTaskDocument } from './validation.ts'
import type { TaskProtocolDocument } from './types.ts'

import { calculateTaskDocumentConsistency } from './consistency.ts'

/** Pure existing task codec, injected by the original host construction. */
export const taskDocumentStorageContract = Object.freeze({
  validate(value: unknown): void { validateTaskDocument(value as TaskProtocolDocument) },
  key(parent: string): string { if (!parent) throw new Error('Invalid task parent'); return `task-${parent}` },
  empty(): TaskProtocolDocument { return { formatVersion: 2, tasks: [], notifications: [] } },
  consistency(parent: string, events: readonly SessionEventView[], seedLength: number, value: unknown) {
    if (value !== undefined) validateTaskDocument(value as TaskProtocolDocument)
    return calculateTaskDocumentConsistency(parent, events, seedLength, value)
  },
})
