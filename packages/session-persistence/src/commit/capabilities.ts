import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createBindingObservations } from '../coordinator/binding-observation.ts'
import { createOwnership } from '../coordinator/ownership.ts'
import { createOriginalJsonlPathResolution } from '../coordinator/canonical-path-resolution.ts'
import { associateArtifactPaths } from '../coordinator/artifact-path-association.ts'
import { createTaskDocumentOperations, type TaskDocumentConfiguration } from '../coordinator/task-document-operation.ts'
import { createProcessReadLatches } from '../coordinator/process-read-latches.ts'
import { openCommitTaskDocumentSession } from './task-document.ts'
import type { ObservedDocument, SessionMeta } from '../coordinator/types.ts'

export type CapabilityDocuments = {
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
  profile(sessionId: string): Promise<{ meta: SessionMeta; blank: boolean }>
}

export type CommitCapabilityOptions = {
  /** Present when the composition has a task-document validator (subagent). */
  readonly taskDocument?: { readonly validator: TaskDocumentConfiguration['validator'] }
  readonly sessionOfDocument?: (document: object) => string | undefined
}

/** Cross-cutting capabilities (ordering ledger, result revocation, task
 *  documents) need a real Ownership instance: their participants are validated
 *  through the ownership batch ledger, which only accepts artifact-bound
 *  registrations. The artifacts live under <root>/.capabilities so session data
 *  stays in the commit log. */
export function createCommitCapabilities(root: string, documents: CapabilityDocuments, options: CommitCapabilityOptions = {}) {
  const capabilityRoot = resolve(root, '.capabilities')
  const resolution = createOriginalJsonlPathResolution(capabilityRoot)
  const backend = {
    id: 'jsonl',
    lockRoot: capabilityRoot,
    putDocument: documents.putDocument,
    getDocument: documents.getDocument,
    profile: documents.profile,
    readDocumentObserved: async (key: string): Promise<ObservedDocument> => {
      const value = await documents.getDocument(key)
      return value === undefined ? { kind: 'absent' } : { kind: 'present', value }
    },
  }
  const preparations = {
    async prepareRoot() { await mkdir(capabilityRoot, { recursive: true }) },
    async prepareDocumentParents(key: string) { await mkdir(dirname(resolution.document(key)), { recursive: true }) },
  }
  associateArtifactPaths(backend as never, resolution.bindBackend(backend as never, preparations))
  const ownership = createOwnership(backend as never, { lock: { enabled: true, lockRoot: capabilityRoot } })
  const observations = createBindingObservations(backend as never, ownership)
  const admission = observations.createResultRevocationAdmission(ownership)
  const sessionOf = options.sessionOfDocument ?? (() => undefined)
  const taskLatches = createProcessReadLatches(ownership.exclusionScope)
  const operations = options.taskDocument
    ? createTaskDocumentOperations(ownership, observations, {
        validator: options.taskDocument.validator,
        captureParent(document) {
          const id = sessionOf(document as object)
          if (!id) throw new TypeError('Original task parent session unavailable')
          return {
            id,
            assertCurrent() { (document as { assertReady?(): void }).assertReady?.() },
          }
        },
        open: scope => openCommitTaskDocumentSession(scope, { getDocument: documents.getDocument, putDocument: documents.putDocument }),
      }, run => run(), taskLatches)
    : undefined
  return { ownership, observations, admission, operations }
}
