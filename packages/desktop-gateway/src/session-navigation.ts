import { createHash } from 'node:crypto'
import { isStrictFactData } from '@i-harness/core-session'

export interface SessionNavigation { pinned: boolean; unread: boolean; projectId?: string }
export interface SessionProjectBinding { bound: boolean; projectId?: string }
export const navigationDocumentKey = (id: string) => `desktop-navigation-${createHash('sha256').update(id).digest('hex')}`
export const projectBindingDocumentKey = (id: string) => `desktop-session-project-${createHash('sha256').update(id).digest('hex')}`

export function parseSessionNavigation(document: unknown): SessionNavigation {
  if (document === undefined) return { pinned: false, unread: false }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw Error('Session navigation metadata is invalid')
  const row = document as { version?: unknown; pinned?: unknown; unread?: unknown }
  if (row.version !== 1 || typeof row.pinned !== 'boolean' || typeof row.unread !== 'boolean') throw Error('Session navigation metadata is invalid')
  return { pinned: row.pinned, unread: row.unread }
}

export function parseSessionProjectBinding(document: unknown): SessionProjectBinding {
  if (document === undefined) return { bound: false }
  if (!document || typeof document !== 'object' || Array.isArray(document) || !isStrictFactData(document)) throw Error('Invalid session project binding')
  const row = document as Record<string, unknown>
  if (row.version !== 1 || Object.getOwnPropertyNames(row).some(field => !['version', 'projectId'].includes(field))
    || Object.values(Object.getOwnPropertyDescriptors(row)).some(field => !field.enumerable || field.value === undefined)) throw Error('Invalid session project binding')
  if (Object.hasOwn(row, 'projectId') && (typeof row.projectId !== 'string' || !row.projectId || row.projectId.length > 256 || /[\u0000-\u001f\u007f]/.test(row.projectId))) throw Error('Invalid project or session ID')
  return { bound: true, ...(typeof row.projectId === 'string' ? { projectId: row.projectId } : {}) }
}
