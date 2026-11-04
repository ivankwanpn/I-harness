import { mkdtemp, lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createOwnedDocumentWrite } from '../src/backend/document-write.ts'

const identityOf = async (path: string) => { const s = await lstat(path, { bigint: true }); return { dev: s.dev, ino: s.ino } }

it('compares the preimage by digest and refuses a tampered document (S-06)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-doc-preimage-'))
  try {
    const path = join(root, 'task.jsonl')
    await writeFile(path, 'original')
    const write = createOwnedDocumentWrite({ path, bytes: Buffer.from('next'), preimage: { bytes: Buffer.from('original'), identity: await identityOf(path) }, guard() {}, async verifyRoot() {} })
    await writeFile(path, 'tampered')
    const outcome = await write.handle.issue()
    expect(outcome.kind).toBe('conflict')
    await write.settle()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('commits over an unchanged preimage (S-06)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-doc-preimage-'))
  try {
    const path = join(root, 'task.jsonl')
    await writeFile(path, 'original')
    const write = createOwnedDocumentWrite({ path, bytes: Buffer.from('next'), preimage: { bytes: Buffer.from('original'), identity: await identityOf(path) }, guard() {}, async verifyRoot() {} })
    const outcome = await write.handle.issue()
    expect(outcome.kind).toBe('committed')
    await write.settle()
    await expect(readFile(path, 'utf8')).resolves.toBe('next')
  } finally { await rm(root, { recursive: true, force: true }) }
})
