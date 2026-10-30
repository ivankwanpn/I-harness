import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession } from '../../core-session/src/index.ts'
import { createFsTools } from "./helpers/registry-fs.ts"

it.each(['queued', 'reference-only', 'unavailable'] as const)('successful read keeps %s metadata inside the real JSON page budget', async status => {
  const root = await mkdtemp(join(tmpdir(), 'ih-read-scope-')), target = join(root, 'data.txt')
  const content = '中文"quoted"\n'.repeat(500)
  await writeFile(target, content)
  const session = createSession(), calls: unknown[] = []
  const tool = createFsTools({ workspace: root, readPolicy: { maxOutputBytes: 1024 }, async observeInstructionTarget(value, exec) { calls.push([value, exec.session]); return { status, ...(status === 'reference-only' ? { reason: 'outside-root' as const } : {}) } } }).find(tool => tool.name === 'read')!
  try {
    const exec = { session, callId: 'read' }
    let offset = 0, digest: string | undefined, rebuilt = ''
    do {
      const page = await tool.execute({ path: target, ...(offset ? { offset_bytes: offset, digest } : {}) }, exec) as { content: string; digest: string; next_offset_bytes: number; instruction_scope: { status: string }; truncated: boolean }
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024)
      expect(page.instruction_scope.status).toBe(status)
      rebuilt += page.content; digest = page.digest; offset = page.next_offset_bytes
      if (!page.truncated) break
    } while (true)
    expect(rebuilt).toBe(content)
    expect(calls.every(value => (value as unknown[])[1] === session)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('classification failure preserves the successful read content and list entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-read-fault-')); await writeFile(join(root, 'data.txt'), 'kept content')
  const tools = createFsTools({ workspace: root, async observeInstructionTarget() { throw Error('classification fault') } }), exec = { session: createSession(), callId: 'real-read' }
  try {
    expect(await tools.find(tool => tool.name === 'read')!.execute({ path: 'data.txt' }, exec)).toEqual({ content: 'kept content', instruction_scope: { status: 'unavailable', reason: 'mapping-unavailable' } })
    expect(await tools.find(tool => tool.name === 'list_dir')!.execute({ path: root }, exec)).toEqual({ entries: ['data.txt'], instruction_scope: { status: 'unavailable', reason: 'mapping-unavailable' } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('an invalid page request never queues a successful instruction target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-read-page-refused-')); await writeFile(join(root, 'data.txt'), 'kept content')
  let observations = 0
  const tool = createFsTools({ workspace: root, readPolicy: { maxOutputBytes: 1024 }, async observeInstructionTarget() { observations++; return { status: 'queued' } } }).find(tool => tool.name === 'read')!
  try {
    expect(await tool.execute({ path: 'data.txt', digest: 'stale-digest' }, { session: createSession(), callId: 'stale-read' })).toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(observations).toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
