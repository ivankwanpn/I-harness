import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '../src/index.ts'

it('reports an oversized header as SESSION_HEADER_TOO_LARGE, not an empty file (S-10)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-header-limit-'))
  try {
    await writeFile(join(root, 'oversized.jsonl'), 'x'.repeat(70 * 1024) + '\n')
    const backend = createJsonlBackend(root)
    await expect(backend.profile('oversized')).rejects.toMatchObject({ code: 'SESSION_HEADER_TOO_LARGE' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
