import { open } from 'node:fs/promises'
import type { HeldTaskDocumentScope, TaskDocumentWrite, TaskWriteOutcome } from './task-document-types.ts'
type OriginalAuxScope=HeldTaskDocumentScope

type ScopeOwner = { captureIssued(): (() => void) | undefined; assertOriginal(): void }
type Producer = { canReconcile():boolean;reconcile(): Promise<TaskWriteOutcome>; retireUnissued(): Promise<TaskWriteOutcome> }
export type OriginalTaskWriteLifetime = Readonly<{ issued(): boolean;canReconcile():boolean; assertIssued(): void; reconcile(): Promise<TaskWriteOutcome>; retireUnissued(): Promise<TaskWriteOutcome> }>
const scopes = new WeakMap<object, ScopeOwner>()
const stages = new WeakMap<object, { scope: OriginalAuxScope; available: () => Promise<void>; check(): void }>()
const writes = new WeakMap<object, OriginalTaskWriteLifetime>()
type Capture = { scope: OriginalAuxScope; path: string; bytes: Buffer; lifetime?: OriginalTaskWriteLifetime }
let capture: Capture | undefined

/** Called synchronously by the original held-scope factory before exposing it. */
export function associateTaskWriteScope(scope: HeldTaskDocumentScope, owner: ScopeOwner): void {
  if (scopes.has(scope)) throw new TypeError('Task scope already associated')
  scopes.set(scope, owner)
}

/** Only the original JSONL constructor retains this stage token. */
export function createOriginalTaskNativeStage(scope: OriginalAuxScope, available: () => Promise<void>, check: () => void): object {
  if (!scopes.has(scope)) throw new TypeError('Original task scope unavailable')
  check()
  const token = Object.freeze({})
  stages.set(token, { scope, available, check })
  return token
}

export function constructOriginalTaskWrite<T extends { handle: TaskDocumentWrite }>(token: object, scope: OriginalAuxScope, available: () => Promise<void>, opener: unknown, path: string, bytes: Uint8Array, construct: () => T): T {
  const original = stages.get(token)
  if (!original || original.scope !== scope || original.available !== available || opener !== open) throw new TypeError('Foreign native Task write stage')
  original.check()
  const previous = capture, current: Capture = { scope, path, bytes: Buffer.from(bytes) }
  capture = current
  try {
    const result = construct()
    // A delegating wrapper retains the actual constructor's one producer.
    // A nondelegating/custom result has no producer and receives no grant.
    if (current.lifetime) writes.set(result.handle, current.lifetime)
    return result
  } finally { capture = previous }
}

/** Invoked by the native document writer constructor, never a status DTO. */
export function captureOriginalTaskWriteProducer(path: string, bytes: Uint8Array, producer: Producer): Readonly<{ beforeIssue(): void }> | undefined {
  const current = capture
  if (!current || current.path !== path || !current.bytes.equals(Buffer.from(bytes))) return undefined
  if (current.lifetime) throw new TypeError('Multiple native Task write producers')
  const owner = scopes.get(current.scope)!
  let issued = false, qualification: (() => void) | undefined
  const lifetime: OriginalTaskWriteLifetime = Object.freeze({
    issued() { if (this !== lifetime) throw new TypeError('Invalid Task write lifetime'); return issued },
    canReconcile(){if(this!==lifetime)throw new TypeError('Invalid Task write lifetime');return issued&&producer.canReconcile()},
    assertIssued() { if (this !== lifetime || !issued || !qualification) throw new Error('Original issued Task qualifier unavailable'); qualification() },
    async reconcile() { if (this !== lifetime) throw new TypeError('Invalid Task write lifetime'); lifetime.assertIssued(); const result = await producer.reconcile(); lifetime.assertIssued(); return result },
    async retireUnissued() { if (this !== lifetime || issued) throw new Error('Original Task write already issued'); owner.assertOriginal(); const result = await producer.retireUnissued(); owner.assertOriginal(); return result },
  })
  current.lifetime = lifetime
  const result = Object.freeze({ beforeIssue() {
    if (this !== result) throw new TypeError('Invalid native Task issue fence')
    // This callback is adjacent to the native producer's real issued transition.
    // It cannot qualify a future publication after retirement.
    qualification = owner.captureIssued()
    issued = true
  } })
  return result
}

export function originalTaskWriteLifetime(write: object): OriginalTaskWriteLifetime | undefined { return writes.get(write) }
