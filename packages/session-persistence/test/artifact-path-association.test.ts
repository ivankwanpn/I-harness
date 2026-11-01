import { expect, test } from 'vitest'
import { resolve } from 'node:path'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { artifactPathsFor } from '../src/coordinator/artifact-path-association.ts'

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
