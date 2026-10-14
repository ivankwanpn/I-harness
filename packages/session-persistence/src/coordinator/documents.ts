import type { PersistenceBackend } from "./types.ts"
import type { Ownership } from "./ownership.ts"

export function createDocuments(
  backend: Pick<PersistenceBackend, "putDocument" | "getDocument">,
  { lockEnabled, acquireLease }: Pick<Ownership, "lockEnabled" | "acquireLease">,
  report: (error: unknown) => void,
) {
  const deletedDocuments = new Set<string>()
  let docChain: Promise<void> = Promise.resolve()

  // Documents are per-key (not per-session) mutating state: under the lease,
  // each write runs inside a borrowed per-key lease namespaced "doc:<key>" in
  // the same lock root (disjoint from session leases). Fail-closed: a conflict
  // skips the write; ordinary write failures are reported by putDocument.
  async function putDocumentWithLease(key: string, data: unknown): Promise<void> {
    if (!lockEnabled) return backend.putDocument(key, data)
    const lock = await acquireLease(`doc:${key}`)
    try {
      await backend.putDocument(key, data)
    } finally {
      await lock.release()
    }
  }

  return {
    closeAdmissions(keys: string[]) { for (const key of keys) deletedDocuments.add(key) },
    pendingWrites: () => docChain,
    async putDocumentStrict(key: string, data: unknown) {
      if (deletedDocuments.has(key)) throw new Error("Session document is deleted")
      const p = docChain.then(() => putDocumentWithLease(key, data))
      docChain = p.catch(() => {})
      return p
    },
    async putDocument(key: string, data: unknown) {
      if (deletedDocuments.has(key)) { report(new Error("Session document is deleted")); return }
      const p = docChain.then(() => putDocumentWithLease(key, data))
      docChain = p.catch(() => {}) // keep the chain alive after a failure
      return p.catch((error: unknown) => { report(error) }) // reporter exceptions still reject the caller
    },
    async getDocument(key: string) {
      return backend.getDocument(key)
    },
  }
}

export type Documents = ReturnType<typeof createDocuments>
