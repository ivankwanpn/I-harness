import { createHash } from 'node:crypto'
import { mkdir, open, rm, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import type { ResultCompleteness } from '@i-harness/core-session'
import type { ArtifactOperation, ArtifactSettlement, ResultArtifactSink, WriteContinuationResult } from './types.ts'
import { atomicJson, readExact, writeAll } from './io.ts'
import { buildIndex, CHUNK, dimensions, leafHash } from './index.ts'
import { artifactRef } from './manifest.ts'
import { createArtifactPublication } from './recovery.ts'

export interface WriterAuthority {
  directory: string; operation: ArtifactOperation
  mutate<T>(work: () => Promise<T>): Promise<T>
  reserve(growth: number): Promise<void>
  lifetime(): 'current' | 'deleted' | 'unavailable'
  recoveryAllowed(): boolean
  cancelPublication(): Promise<void>
  closed(): void
}
export interface OwnedArtifactSink extends ResultArtifactSink { suspend(): Promise<void> }
interface FailedIssue { admitted: PendingWrite; cause?: unknown; candidate: boolean; finalized: boolean; consumed: boolean; applied: boolean }
interface PendingWrite { bytes: Buffer; start: number; ordinal: number; digest: string; bodyDone: boolean; accounted: boolean; copied: number; reserved: boolean }

/** Matching partial bytes may be completed; foreign bytes never get replaced. */
async function resumeBytes(handle: FileHandle, bytes: Buffer, start: number): Promise<void> {
  const info = await handle.stat(), available = info.size - start
  if (!info.isFile() || available < 0 || available > bytes.length) throw new Error('Artifact write prefix conflict')
  if (available && !(await readExact(handle, available, start)).equals(bytes.subarray(0, available))) throw new Error('Artifact write prefix conflict')
  await writeAll(handle, bytes.subarray(available), start + available)
}

export async function createArtifactWriter(authority: WriterAuthority, recoverEmptyInitialization = false): Promise<OwnedArtifactSink> {
  const { directory, operation } = authority
  await mkdir(directory, { recursive: true })
  async function openEmpty(name: string): Promise<FileHandle> {
    const path = resolve(directory, name)
    try { return await open(path, 'wx+') }
    catch (cause) {
      if (!recoverEmptyInitialization || (cause as NodeJS.ErrnoException).code !== 'EEXIST' || (await lstat(path)).isSymbolicLink()) throw cause
      const handle = await open(path, 'r+')
      const info = await handle.stat()
      if (!info.isFile() || info.size !== 0) { await handle.close(); throw new Error('Artifact initialization conflict') }
      return handle
    }
  }
  const body = await openEmpty('body')
  let leaves: FileHandle
  try { leaves = await openEmpty('leaves') } catch (cause) { await body.close(); throw cause }
  const digest = createHash('sha256'), partial = Buffer.alloc(CHUNK)
  let used = 0, leafCount = 0, ordinal = 0, serial: Promise<unknown> = Promise.resolve(), finished = false, closed = false
  let pending: PendingWrite | undefined, completion: ArtifactSettlement | undefined, completeness: ResultCompleteness | undefined
  let failedIssue: FailedIssue | undefined
  let refusing: ArtifactOperation['reason']
  const assertCurrent = () => {
    const lifetime = authority.lifetime()
    if (lifetime !== 'current') throw Object.assign(new Error('Original artifact lifetime unavailable'), { code: lifetime === 'deleted' ? 'ARTIFACT_DELETED' : 'ARTIFACT_SOURCE_CLOSED' })
  }
  const publish = createArtifactPublication(directory, operation, assertCurrent)
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => { const next = serial.then(work); serial = next.catch(() => {}); return next }
  const metadataPath = resolve(directory, 'operation.json')
  const save = (renameRejected?: (cause: unknown) => void) => atomicJson(metadataPath, operation, renameRejected)
  async function closeFiles() { if (!closed) { await body.close(); await leaves.close(); closed = true; authority.closed() } }
  async function refuse(reason: NonNullable<ArtifactOperation['reason']>) {
    refusing = reason
    operation.phase = 'refused'; operation.reason = reason
    await closeFiles()
    await authority.cancelPublication()
    await rm(resolve(directory, 'body'), { force: true }); await rm(resolve(directory, 'leaves'), { force: true }); await save()
    completion = { kind: 'refused', reason, observedEncodedBytes: operation.encodedBytes }
  }
  async function flushLeaf() {
    await resumeBytes(leaves, leafHash(leafCount, partial.subarray(0, used)), leafCount * 32)
    leafCount++; used = 0
  }
  async function applyPending(issue?: FailedIssue, continuation?: { allowed(): boolean; applied(): void }): Promise<void> {
    const admitted = pending
    if (!admitted) return
    if (admitted.ordinal !== ordinal || createHash('sha256').update(admitted.bytes).digest('hex') !== admitted.digest) throw new Error('Artifact admitted write conflict')
    await authority.mutate(async () => {
      if (continuation && !continuation.allowed()) return
      if (refusing) { await refuse(refusing); pending = undefined; ordinal++; return }
      if (!admitted.reserved) {
        assertCurrent()
        try { await authority.reserve(admitted.bytes.length + 131104) }
        catch (cause) {
          if ((cause as { code?: string }).code !== 'ARTIFACT_QUOTA') throw cause
          operation.encodedBytes = admitted.start + admitted.bytes.length; await refuse('quota'); pending = undefined; ordinal++; return
        }
        admitted.reserved = true
      }
      if (!admitted.bodyDone) { await resumeBytes(body, admitted.bytes, admitted.start); admitted.bodyDone = true }
      if (!admitted.accounted) { digest.update(admitted.bytes); operation.encodedBytes = admitted.start + admitted.bytes.length; admitted.accounted = true }
      while (admitted.copied < admitted.bytes.length || used === CHUNK) {
        if (used === CHUNK) { await flushLeaf(); continue }
        const length = Math.min(CHUNK - used, admitted.bytes.length - admitted.copied)
        admitted.bytes.copy(partial, used, admitted.copied, admitted.copied + length); used += length; admitted.copied += length
      }
      await save(issue ? cause => {
        const error = cause as (NodeJS.ErrnoException & { dest?: string }) | null
        // Only the actual owned metadata rename rejection reaches this callback.
        if (operation.phase === 'capturing' && error?.code === 'EPERM' && error.syscall === 'rename' && error.dest === metadataPath) {
          issue.cause = cause; issue.candidate = true
        }
      } : undefined)
      pending = undefined; ordinal++
      if (issue) issue.applied = true
      continuation?.applied()
    })
  }
  async function commit(): Promise<ArtifactSettlement> {
    if (completion) return completion.kind === 'refused' ? { ...completion, observedEncodedBytes: operation.encodedBytes } : completion
    if (pending || !finished || completeness === undefined) return { kind: 'recovery-required', operationId: operation.owner.operationId }
    const capturedCompleteness = completeness
    try {
      return await authority.mutate(async () => {
        if (refusing) { await refuse(refusing); return completion! }
        if (operation.phase === 'capturing') {
          assertCurrent()
          const shape = dimensions(operation.encodedBytes)
          await authority.reserve(shape.indexBytes + 196608)
          assertCurrent()
          if (used || leafCount === 0) await flushLeaf()
          await body.sync(); await leaves.sync()
          const treeRoot = await buildIndex(resolve(directory, 'index'), resolve(directory, 'leaves'), operation.encodedBytes)
          assertCurrent()
          operation.manifest = { version: 1, codec: operation.codec, encodedBytes: operation.encodedBytes, contentDigest: digest.digest('hex'), completeness: capturedCompleteness,
            chunkBytes: 65536, leaves: shape.leaves, paddedLeaves: shape.paddedLeaves, treeRoot }
          operation.ref = artifactRef(operation.id, operation.manifest); operation.phase = 'staged'; await save()
        }
        // A staged save that rejected may already exist. Resolve the exact
        // original bytes before applying deletion or source lifetime fences.
        await save()
        await closeFiles(); await rm(resolve(directory, 'leaves'), { force: true })
        completion = await publish()
        return completion
      })
    } catch (cause) {
      const reason = (cause as { code?: string }).code === 'ARTIFACT_QUOTA' && operation.phase === 'capturing' ? 'quota' : (cause as { code?: string }).code === 'ARTIFACT_DELETED' ? 'capture-canceled' : undefined
      if (reason) {
        try { await authority.mutate(() => refuse(reason)); return completion! } catch { /* same pending refusal resumes on reconcile */ }
      }
      return { kind: 'recovery-required', operationId: operation.owner.operationId }
    }
  }
  return {
    write(input) {
      if (finished || pending || closed && completion?.kind !== 'refused' || input.length > CHUNK) return Promise.reject(new Error('Artifact write requires one unfinished bounded chunk'))
      const bytes = Buffer.from(input)
      if (completion?.kind === 'refused') { operation.encodedBytes += bytes.length; return Promise.resolve() }
      pending = { bytes, start: operation.encodedBytes, ordinal, digest: createHash('sha256').update(bytes).digest('hex'), bodyDone: false, accounted: false, copied: 0, reserved: false }
      const issue: FailedIssue = { admitted: pending, candidate: false, finalized: false, consumed: false, applied: false }
      failedIssue = undefined
      return enqueue(() => applyPending(issue)).catch(cause => {
        // Exact outer identity proves clean retirement under the genuine
        // WorkspaceMutationOwner contract. Never inspect aggregate children.
        if (issue.candidate && cause === issue.cause && pending === issue.admitted) {
          issue.finalized = true; failedIssue = issue
        }
        throw cause
      })
    },
    continueFailedWrite(originalCause, continuationAllowed) {
      const issue = failedIssue
      const same = () => failedIssue === issue && !!issue?.finalized && pending === issue.admitted
      const allowed = () => {
        try { return !finished && !closed && !refusing && completeness === undefined && operation.phase === 'capturing'
          && authority.lifetime() === 'current' && authority.recoveryAllowed() && continuationAllowed() === true }
        catch { return false }
      }
      if (!issue || !same() || issue.consumed || originalCause !== issue.cause)
        return Promise.resolve({ kind: 'not-eligible', reason: 'original-unavailable' })
      if (!allowed()) return Promise.resolve({ kind: 'not-eligible', reason: 'gate-denied' })
      issue.consumed = true
      return enqueue(async (): Promise<WriteContinuationResult> => {
        const unresolved = (reason: 'original-unavailable' | 'gate-denied' | 'continuation-failed', cause?: unknown): WriteContinuationResult => ({
          kind: 'unresolved', progress: issue.applied ? 'record-applied' : 'pending', reason,
          ...(cause !== undefined && cause !== originalCause ? { cause } : {}),
        })
        if (!same()) return unresolved('original-unavailable')
        if (!allowed()) return unresolved('gate-denied')
        let appliedHere = false
        try {
          // Exactly one mutation layer; gate also runs inside the acquired turn.
          await applyPending(undefined, {
            allowed: () => same() && allowed(),
            applied: () => { appliedHere = true; issue.applied = true },
          })
        } catch (cause) {
          return unresolved('continuation-failed', cause)
        }
        if (!appliedHere) return unresolved('gate-denied')
        if (failedIssue !== issue || !allowed()) return unresolved('gate-denied')
        failedIssue = undefined
        return { kind: 'written' }
      })
    },
    finish(value) {
      if (!['complete', 'source-limited', 'capture-canceled', 'producer-incomplete'].includes(value)) return Promise.reject(new Error('Invalid artifact completeness'))
      if (completeness !== undefined && completeness !== value) return Promise.reject(new Error('Artifact completeness is immutable'))
      if (pending) return Promise.resolve({ kind: 'recovery-required', operationId: operation.owner.operationId })
      completeness = value; finished = true; return enqueue(commit)
    },
    reconcileWrite() { return enqueue(async () => { try { await applyPending(); return 'ready' as const } catch { return 'recovery-required' as const } }) },
    reconcile() { return enqueue(commit) },
    suspend() { return enqueue(async () => { await closeFiles() }) },
  }
}
