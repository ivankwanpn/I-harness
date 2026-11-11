import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCommitLog, type CommitLog } from '../src/store.ts'
import { acquireCommitLease, type CommitLease } from '../src/lease.ts'
import { sidecarPath } from '../src/paths.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-create-admission-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it('captures the first header and entries before waiting for its genuine native writer lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-create-admission-')); roots.push(root)
  let blocker: CommitLease | undefined = await acquireCommitLease('source', { lockRoot: root })
  let log: CommitLog | undefined
  const first = { header: { sessionId: 'source', nested: { value: 'admitted' } }, entries: [{ type: 'user/message' as const, text: 'admitted', seq: 0 }] }
  const accepted = createCommitLog({ root, sessionId: 'source', lease: { retryMs: 5, deadlineMs: 1000 } }, first)
  try {
    first.header.nested.value = 'caller edit'; first.entries[0]!.text = 'caller edit'
    await blocker.release(); blocker = undefined
    log = await accepted
    expect(log.header()).toMatchObject({ nested: { value: 'admitted' } })
    expect(log.view().entries).toEqual([{ type: 'user/message', text: 'admitted', seq: 0 }])
  } finally { await blocker?.release(); await accepted.then(opened => opened.close(), () => undefined); await log?.close() }
}, 15000)

it('keeps an opened writer bound to its admitted root and session when the caller changes its options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-create-admission-')); roots.push(root)
  const originalRoot = join(root, 'original'), options = { root: originalRoot, sessionId: 'source' }
  const writer = await createCommitLog(options, { header: { sessionId: 'source' } })
  try {
    options.root = join(root, 'retargeted'); options.sessionId = 'other'
    const side = await writer.writeSidecar(Buffer.from('admitted namespace'))
    expect(await readFile(sidecarPath(originalRoot, 'source', side.digest), 'utf8')).toBe('admitted namespace')
  } finally { await writer.close() }
}, 15000)
