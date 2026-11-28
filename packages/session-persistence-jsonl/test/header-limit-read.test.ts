import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlBackend } from '../src/index.ts'
import { HEADER_READ_MAX_BYTES } from '../src/backend/header-limit.ts'

const probe = vi.hoisted(() => ({ path: '', bytes: 0, chunk: Infinity }))
vi.mock('node:fs/promises', async load => {
  const real = await load<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (args[0] === probe.path && args[1] === 'r') {
      const read = handle.read.bind(handle)
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, Math.min(length, probe.chunk), position)
        probe.bytes += result.bytesRead
        return result
      }) as typeof handle.read
    }
    return handle
  } }
})

it('profiles a long transcript from a small prefix and preserves a maximum-size UTF-8 header across short reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-header-profile-'))
  const path = join(root, 'saved.jsonl')
  const header = (title: string) => JSON.stringify({ formatVersion: 1, sessionId: 'saved', title }) + '\n'
  const events = JSON.stringify({ type: 'assistant/message', seq: 0, text: 'a'.repeat(HEADER_READ_MAX_BYTES * 2) }) + '\n'
  try {
    const backend = createJsonlBackend(root)
    await writeFile(path, header('short') + events)
    probe.path = path
    probe.bytes = 0
    await expect(backend.profile('saved')).resolves.toMatchObject({ meta: { title: 'short' }, blank: false })
    expect(probe.bytes).toBeLessThanOrEqual(1024)

    // Put a multibyte character across the first KiB boundary and the newline
    // precisely at the byte limit, even when the filesystem returns short reads.
    const prefixBytes = header('').indexOf('""') + 1
    const titlePrefix = 'x'.repeat(1023 - prefixBytes) + '測試'
    const longTitle = titlePrefix + 'z'.repeat(HEADER_READ_MAX_BYTES - Buffer.byteLength(header(titlePrefix)))
    await writeFile(path, header(longTitle) + events)
    probe.chunk = 357
    probe.bytes = 0
    await expect(backend.profile('saved')).resolves.toMatchObject({ meta: { title: longTitle } })
    expect(probe.bytes).toBe(HEADER_READ_MAX_BYTES)
  } finally {
    probe.path = ''
    probe.chunk = Infinity
    await rm(root, { recursive: true, force: true })
  }
})

it('reports an oversized header as SESSION_HEADER_TOO_LARGE, not an empty file (S-10)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-header-limit-'))
  try {
    await writeFile(join(root, 'oversized.jsonl'), 'x'.repeat(70 * 1024) + '\n')
    const backend = createJsonlBackend(root)
    await expect(backend.profile('oversized')).rejects.toMatchObject({ code: 'SESSION_HEADER_TOO_LARGE' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
