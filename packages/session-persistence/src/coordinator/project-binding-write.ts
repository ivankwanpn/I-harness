import type { SessionCoordinator } from './types.ts'
import type { Documents } from './documents.ts'
const owners = new WeakMap<SessionCoordinator, { port: Readonly<{ write: Documents['writeOwnedProjectBinding']; retry: Documents['retryProjectBindingCleanup'] }>; put: SessionCoordinator['putDocument']; strict: SessionCoordinator['putDocumentStrict'] }>()
export function associateProjectBindingWrites(coordinator: SessionCoordinator, documents: Documents) {
  if (owners.has(coordinator)) throw TypeError('Binding owner already associated')
  owners.set(coordinator, { port: Object.freeze({ write: documents.writeOwnedProjectBinding, retry: documents.retryProjectBindingCleanup }), put: coordinator.putDocument, strict: coordinator.putDocumentStrict })
}
export function projectBindingWritesFor(coordinator: SessionCoordinator) {
  const owner = owners.get(coordinator); if (!owner) return undefined
  for (const [key, original] of [['putDocument', owner.put], ['putDocumentStrict', owner.strict]] as const) {
    const field = Object.getOwnPropertyDescriptor(coordinator, key)
    if (!field || !('value' in field) || field.value !== original) throw TypeError('Changed original binding coordinator')
  }
  return owner.port
}
