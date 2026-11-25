import { expect, test, vi } from 'vitest'
import { resolve } from 'node:path'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { artifactPathsFor } from '../src/coordinator/artifact-path-association.ts'
import { createOriginalJsonlPathResolution } from '../src/coordinator/canonical-path-resolution.ts'

test('original JSONL backend supplies canonical actual suffixed artifacts only to its own association', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const root = await mkdtemp(resolve(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'association-')), backend = createJsonlBackend(root)
  const paths = artifactPathsFor(backend)!
  expect(paths.session('x/../parent')).toMatchObject({kind:'ready',key:(paths.session('parent') as any).key})
  expect(paths.taskForParent('x/../parent')).toMatchObject({kind:'ready',key:(paths.document('parent') as any).key})
  expect(paths.document('task-parent')).toMatchObject({kind:'ready',key:(paths.taskForParent('parent') as any).key})
  expect(artifactPathsFor({ ...backend })).toBeUndefined()
  backend.read = async () => { throw new Error('changed') }
  expect(() => artifactPathsFor(backend)).toThrow()
})

test('original document preparation creates its parent directories without writing the artifact', async () => {
  const { mkdtemp, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'prepare-'))
  const backend = createJsonlBackend(root), paths = artifactPathsFor(backend)!
  await paths.prepareDocument('nested/key')
  expect((await stat(join(root, 'nested'))).isDirectory()).toBe(true)
  await expect(stat(join(root, 'nested', 'key.doc.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a private fixed backend needs no repeated descriptor reads', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const root = await mkdtemp(resolve(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'fixed-association-'))
  try {
    const fixed = createJsonlBackend(root, { fixedCapabilities: true })
    const mutable = createJsonlBackend(root)
    const fixedPaths = artifactPathsFor(fixed)!
    const mutablePaths = artifactPathsFor(mutable)!
    const original = Object.getOwnPropertyDescriptor
    const reads = { fixed: 0, mutable: 0 }
    const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor').mockImplementation((object, key) => {
      if (object === fixed) reads.fixed++
      if (object === mutable) reads.mutable++
      return original(object, key)
    })
    try {
      for (let i = 0; i < 4; i++) {
        fixedPaths.assertOriginal()
        mutablePaths.assertOriginal()
      }
    } finally { descriptor.mockRestore() }
    expect(reads.fixed).toBe(0)
    expect(reads.mutable).toBeGreaterThan(0)
    expect(Reflect.set(fixed, 'read', () => { throw new Error('changed') })).toBe(false)
    expect(fixedPaths.session('parent')).toMatchObject({ kind: 'ready' })
    mutable.read = async () => { throw new Error('changed') }
    expect(() => mutablePaths.assertOriginal()).toThrow('PROCESS_READ_UNAVAILABLE')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('freezing an accessor does not qualify it as a fixed backend operation', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const root = await mkdtemp(resolve(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'accessor-association-'))
  const getter = vi.fn(() => { throw new Error('backend getter ran') })
  try {
    const backend = createJsonlBackend(root)
    Object.defineProperty(backend, 'read', { enumerable: true, get: getter })
    Object.freeze(backend)
    const owner = createOriginalJsonlPathResolution(root).bindBackend(backend, {
      async prepareRoot() {}, async prepareDocumentParents() {},
    })
    expect(() => owner.assertOriginal()).toThrow('PROCESS_READ_UNAVAILABLE')
    expect(getter).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})
