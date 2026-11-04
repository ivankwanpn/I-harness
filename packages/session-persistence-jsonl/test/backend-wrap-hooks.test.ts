import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '../src/index.ts'

it('installs pre-bind append and reconcile wrappers before the canonical guard (D-12)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-jsonl-wrap-'))
  try {
    const counts = { append: 0, reconcile: 0 }
    const backend = createJsonlBackend(root, {
      wrapOwnedBatch: append => async (...args) => { counts.append += 1; return append(...args) },
      wrapOwnedReconcile: reconcile => async (...args) => { counts.reconcile += 1; return reconcile(...args) },
    })
    expect(typeof backend.appendOwnedBatch).toBe('function')
    expect(typeof backend.reconcileOwnedBatch).toBe('function')
    await Promise.resolve(backend.appendOwnedBatch!.apply(backend, [{} as never, {} as never, {} as never, {} as never])).catch(() => {})
    await Promise.resolve(backend.reconcileOwnedBatch!.apply(backend, [{} as never, {} as never, {} as never, {} as never])).catch(() => {})
    expect(counts).toEqual({ append: 1, reconcile: 1 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
