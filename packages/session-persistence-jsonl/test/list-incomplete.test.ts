import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '../src/index.ts'

it('hides zero-byte session artifacts left by an interrupted create/fork (S-08)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-list-incomplete-'))
  try {
    await writeFile(join(root, 'half.jsonl'), '')
    const backend = createJsonlBackend(root)
    await expect(backend.list()).resolves.toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('hides a reserved session whose publication marker is still durable (S-08)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-list-publishing-'))
  try {
    // A fork publishes its header before its bootstrap birth is complete; the
    // durable marker is what keeps that partial file out of list().
    await writeFile(join(root, 'child.jsonl'), '{"formatVersion":14}\n')
    await writeFile(join(root, 'child.jsonl.publishing'), '')
    const backend = createJsonlBackend(root)
    await expect(backend.list()).resolves.toEqual([])
    await rm(join(root, 'child.jsonl.publishing'))
    await expect(backend.list()).resolves.toEqual(['child'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
