import { types } from 'node:util'
import type { TaskProtocolDocument } from './types.ts'
import { captureTaskV3Document } from './v3-codec.ts'
import { validateTaskPublicationRows } from './result-validation.ts'
export { validTaskResult, validateTaskPublicationRows } from './result-validation.ts'

export function validateTaskDocument(doc: TaskProtocolDocument): void {
  if (!doc || typeof doc !== 'object' || types.isProxy(doc)) throw new TypeError('Invalid task document')
  const version = Object.getOwnPropertyDescriptor(doc, 'formatVersion')
  if (!version || !('value' in version)) throw new TypeError('Invalid task document version')
  if (version.value === 3) { captureTaskV3Document(doc); return }
  if (![1,2].includes(version.value) || !Array.isArray(doc.tasks) || !Array.isArray(doc.notifications)) throw new Error('Unsupported task document version')
  validateTaskPublicationRows(doc)
}
