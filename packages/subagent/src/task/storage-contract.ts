import { validateTaskDocument } from './validation.ts'
import type { TaskProtocolDocument } from './types.ts'

/** Pure existing task codec, injected by the original host construction. */
export const taskDocumentStorageContract = Object.freeze({
  validate(value: unknown): void { validateTaskDocument(value as TaskProtocolDocument) },
})
