import { lstat, open } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isHeldTaskDocumentScope, type HeldTaskDocumentScope, type RawTaskObservation, type TaskDocumentWitness, type TaskDocumentAck, type Confirmation, type TaskDocumentBackendSession } from '@i-harness/session-persistence'
import { createOwnedDocumentWrite } from './document-write.ts'
import { constructOriginalTaskWrite,isHeldTeamBirthScope,type HeldTeamBirthScope } from '@i-harness/session-persistence/internal/task-document-operations'
import {parseTeamBirthBinding} from '../../../session-persistence/src/coordinator/team-birth-binding.ts'

const LIMIT = 64 * 1024 * 1024
const CHUNK = 64 * 1024
type Opener = (path: string, flags: 'r' | 'r+') => Promise<FileHandle>
type Resource = { handle: FileHandle; close: FileHandle['close']; failed: boolean; cause?: unknown }

/** Private raw observation owner. Confirmation and Documents admission are separate future owners. */
export function createTaskDocumentObservation(root: string, path: string, scope: HeldTaskDocumentScope|HeldTeamBirthScope, opener: Opener = open, checkAvailable: () => Promise<void> = async () => {}, nativeStage?: object) {
  if (!isHeldTaskDocumentScope(scope)&&!isHeldTeamBirthScope(scope)) throw new TypeError('Invalid original document scope')
  const assert = scope.assertActive
  Reflect.apply(assert, scope, [])
  const rootPath = resolve(root), filePath = resolve(path), expected = resolve(rootPath, `${scope.key}.doc.jsonl`)
  const rel = relative(rootPath, filePath)
  if (filePath !== expected || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError('Invalid task document path')
  const resources = new Set<Resource>()
  let flight: Promise<Readonly<{ kind: 'absent' }> | RawTaskObservation> | undefined
  let cleanup: Promise<void> | undefined
  let confirming: Promise<Confirmation> | undefined
  let lastConfirmation: Confirmation | undefined
  let ack: TaskDocumentAck | undefined
  let conflict = false
  // This record is private to the session and is installed only when the
  // original observation can actually be returned to its caller.
  type Original = { witness: RawTaskObservation['witness']; bytes: Buffer; file: BigIntStats; root: BigIntStats; identity: { dev: bigint; ino: bigint } }
  let original: Original | undefined
  let absentRoot: BigIntStats | undefined
  let ownedWrite: ReturnType<typeof createOwnedDocumentWrite> | undefined
  function guard() {
    if ((!isHeldTaskDocumentScope(scope)&&!isHeldTeamBirthScope(scope)) || scope.assertActive !== assert) throw new TypeError('Changed original document scope')
    Reflect.apply(assert, scope, [])
  }
  function confirmationInput(witness: RawTaskObservation['witness']): Original {
    guard()
    if (!original || witness !== original.witness) throw new TypeError('Invalid task document witness')
    return original
  }
  async function closeResource(resource: Resource) {
    if (resource.failed && resource.handle.fd < 0) throw resource.cause
    try { await Reflect.apply(resource.close, resource.handle, []); resources.delete(resource) }
    catch (cause) { resource.failed = true; resource.cause = cause; throw cause }
  }
  async function directories() {
    const rootStat = await lstat(rootPath, { bigint: true }); guard()
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid task document root')
    const parts = relative(rootPath, dirname(filePath)).split(sep).filter(Boolean)
    let current = rootPath
    for (const part of parts) {
      current = resolve(current, part)
      const stat = await lstat(current, { bigint: true }); guard()
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid task document parent')
    }
    return rootStat
  }
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  // Entries may change on unrelated keys without replacing their directory owner.
  const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  }
  async function read() {
    guard()
    if (resources.size) throw new Error('Task document cleanup pending')
    const rootBefore = await directories()
    let before: BigIntStats
    try { before = await lstat(filePath, { bigint: true }) }
    catch (error) { guard(); if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { const rootAfter = await directories(); if (!sameDirectory(rootBefore, rootAfter)) throw new Error('Changed root'); absentRoot = rootBefore; return Object.freeze({ kind: 'absent' as const }) } throw error }
    guard()
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Task document is not a regular file')
    if (before.size < 0n || before.size > BigInt(LIMIT)) throw new Error('Task document too large')
    const precise = await lstat(filePath, { bigint: true }); guard()
    if (!precise.isFile() || precise.isSymbolicLink() || precise.ino <= 0n) throw new Error('Task document identity unavailable')
    const handle = await opener(filePath, 'r')
    const resource: Resource = { handle, close: handle.close, failed: false }
    resources.add(resource)
    let body: { ok: true; value: RawTaskObservation; original: Original } | { ok: false; cause: unknown }
    try {
      guard()
      const opened = await handle.stat({ bigint: true }); guard()
      if (!opened.isFile() || !same(before, opened)) throw new Error('Changed task document')
      const openedIdentity = await handle.stat({ bigint: true }); guard()
      if (openedIdentity.dev !== precise.dev || openedIdentity.ino !== precise.ino) throw new Error('Changed task document')
      const bytes = Buffer.alloc(Number(before.size))
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, Math.min(CHUNK, bytes.length - offset), offset); guard()
        if (!result.bytesRead) throw new Error('Short task document')
        offset += result.bytesRead
      }
      const extra = Buffer.alloc(1), eof = await handle.read(extra, 0, 1, offset); guard()
      if (eof.bytesRead) throw new Error('Changed task document size')
      const afterHandle = await handle.stat({ bigint: true }); guard()
      const afterPath = await lstat(filePath, { bigint: true }); guard()
      const finalIdentity = await lstat(filePath, { bigint: true }); guard()
      const finalHandleIdentity = await handle.stat({ bigint: true }); guard()
      const rootAfter = await directories()
      if (!same(before, afterHandle) || !same(before, afterPath) || !sameDirectory(rootBefore, rootAfter) || finalIdentity.dev !== precise.dev || finalIdentity.ino !== precise.ino || finalHandleIdentity.dev !== precise.dev || finalHandleIdentity.ino !== precise.ino) throw new Error('Changed task document')
      const value: unknown = isHeldTeamBirthScope(scope)?parseTeamBirthBinding(bytes):JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      freeze(value)
      const witness = Object.freeze({}) as RawTaskObservation['witness']
      body = { ok: true, value: Object.freeze({ kind: 'present' as const, value, witness }), original: { witness, bytes, file: before, root: rootBefore, identity: { dev: precise.dev, ino: precise.ino } } }
    } catch (cause) { body = { ok: false, cause } }
    try { await closeResource(resource) }
    catch (cause) {
      // Single failures retain their literal cause; simultaneous failures retain
      // body then cleanup causes, independently of subsequent resource settlement.
      if (!body.ok) throw new AggregateError([body.cause, cause], 'Task document observation and close failed')
      throw cause
    }
    if (!body.ok) throw body.cause
    // Closure is already recorded; revocation during close cannot expose a value.
    guard()
    original = body.original
    confirmationInput(body.value.witness)
    return body.value
  }
  class Changed extends Error {}
  async function confirmOriginal(input: Original, priorCleanup: Promise<void> | undefined): Promise<Confirmation> {
    if (priorCleanup) await priorCleanup
    if (resources.size) throw new Error('Task document cleanup pending')
    let resource: Resource | undefined
    let outcome: Confirmation
    try {
      guard()
      const rootNow = await directories()
      const pathNow = await lstat(filePath, { bigint: true }); guard()
      if (!sameDirectory(input.root, rootNow) || !pathNow.isFile() || pathNow.isSymbolicLink() || !same(input.file, pathNow)) throw new Changed()
      const handle = await opener(filePath, 'r+')
      resource = { handle, close: handle.close, failed: false }
      resources.add(resource)
      const verify = async () => {
        guard()
        const stat = await handle.stat({ bigint: true }); guard()
        if (!stat.isFile() || !same(input.file, stat)) throw new Changed()
        const chunk = Buffer.alloc(Math.min(CHUNK, Math.max(1, input.bytes.length)))
        let offset = 0
        while (offset < input.bytes.length) {
          const n = Math.min(chunk.length, input.bytes.length - offset)
          const result = await handle.read(chunk, 0, n, offset); guard()
          if (!result.bytesRead || !chunk.subarray(0, result.bytesRead).equals(input.bytes.subarray(offset, offset + result.bytesRead))) throw new Changed()
          offset += result.bytesRead
        }
        const eof = await handle.read(chunk, 0, 1, offset); guard()
        if (eof.bytesRead) throw new Changed()
        const after = await handle.stat({ bigint: true }); guard()
        const pathAfter = await lstat(filePath, { bigint: true }); guard()
        const rootAfter = await directories()
        if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || !same(input.file, after) || !same(input.file, pathAfter) || !sameDirectory(input.root, rootAfter)) throw new Changed()
      }
      await verify()
      guard()
      await handle.sync(); guard()
      await verify()
      guard()
      ack = Object.freeze({}) as TaskDocumentAck
      outcome = { kind: 'confirmed', ack, durability: 'file-synced-process-restart-v1', cleanupPending: false }
    } catch (cause) {
      if (cause instanceof Changed || (cause as NodeJS.ErrnoException)?.code === 'ENOENT') { conflict = true; outcome = { kind: 'conflict', cleanupPending: false } }
      else outcome = { kind: 'unknown', cause, cleanupPending: false }
    }
    if (resource) {
      try { await closeResource(resource) }
      catch (cause) {
        if (outcome.kind === 'unknown') outcome = { kind: 'unknown', cause: new AggregateError([outcome.cause, cause], 'Task document confirmation and close failed'), cleanupPending: true }
        else outcome = { ...outcome, cleanupPending: true }
      }
    }
    guard()
    return Object.freeze(outcome)
  }
  const session = Object.freeze({
    observe(): Promise<Readonly<{ kind: 'absent' }> | RawTaskObservation> {
      if (this !== session) return Promise.reject(new TypeError('Invalid observation receiver'))
      try { guard() } catch (error) { return Promise.reject(error) }
      return flight ??= Promise.resolve().then(read)
    },
    confirm(witness: TaskDocumentWitness): Promise<Confirmation> {
      if (this !== session) return Promise.reject(new TypeError('Invalid confirmation receiver'))
      if (ownedWrite) return Promise.reject(new Error('Task write already staged'))
      let input: Original
      try { input = confirmationInput(witness) } catch (error) { return Promise.reject(error) }
      if (confirming) return confirming
      if (ack) return Promise.resolve(Object.freeze({ kind: 'confirmed', ack, durability: 'file-synced-process-restart-v1', cleanupPending: resources.size > 0 }))
      if (conflict) return Promise.resolve(Object.freeze({ kind: 'conflict', cleanupPending: resources.size > 0 }))
      const priorCleanup = cleanup
      const attempt = Promise.resolve().then(() => confirmOriginal(input, priorCleanup))
      confirming = attempt
      void attempt.then(outcome => { lastConfirmation = outcome; if (confirming === attempt) confirming = undefined }, () => { if (confirming === attempt) confirming = undefined })
      return attempt
    },
    stageWrite(witness: TaskDocumentWitness, bytes: Uint8Array) {
      if (this !== session || ownedWrite || confirming || resources.size || conflict || lastConfirmation?.kind === 'unknown') throw new TypeError('Invalid task write stage')
      const input = confirmationInput(witness)
      const construct = () => createOwnedDocumentWrite({ path: filePath, bytes, preimage: { bytes: input.bytes, identity: input.identity }, guard, async verifyRoot() { const root = await directories(); if (!sameDirectory(input.root, root)) throw new Error('Changed task document root'); await checkAvailable(); guard() } })
      ownedWrite = nativeStage ? constructOriginalTaskWrite(nativeStage, scope, checkAvailable, opener, filePath, bytes, construct) : construct()
      return ownedWrite.handle
    },
    stageInitialize(bytes: Uint8Array) {
      if (this !== session || ownedWrite || confirming || resources.size || !absentRoot) throw new TypeError('Invalid task initialization stage')
      guard(); const expectedRoot = absentRoot
      const construct=()=>createOwnedDocumentWrite({ path: filePath, bytes, guard, async verifyRoot() { const root = await directories(); if (!sameDirectory(expectedRoot, root)) throw new Error('Changed task document root'); await checkAvailable(); guard() } })
      ownedWrite=nativeStage&&isHeldTeamBirthScope(scope)?constructOriginalTaskWrite(nativeStage,scope,checkAvailable,opener,filePath,bytes,construct):construct()
      return ownedWrite.handle
    },
    settleResources(): Promise<void> {
      if (this !== session) return Promise.reject(new TypeError('Invalid observation receiver'))
      if (cleanup) return cleanup
      const admittedConfirmation = confirming
      const attempt = Promise.resolve().then(async () => {
        if (flight) await flight.catch(() => {})
        if (admittedConfirmation) await admittedConfirmation.catch(() => {})
        if (ownedWrite) await ownedWrite.settle()
        let failed = false, cause: unknown
        for (const resource of resources) try { await closeResource(resource) } catch (error) { if (!failed) { failed = true; cause = error } }
        if (failed) throw cause
      })
      cleanup = attempt
      void attempt.finally(() => { if (cleanup === attempt) cleanup = undefined }).catch(() => {})
      return attempt
    },
  })
  return session satisfies TaskDocumentBackendSession
}
