import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCommitLog, openCommitLog, type CommitLog } from '../src/store.ts'

function attempt(change: () => void) {
  try { change() } catch (error) { expect(error).toBeInstanceOf(TypeError) }
}

it('keeps an ordinary committed event independent of a caller-mutated earlier read snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-read-snapshot-review-')), options = { root, sessionId: 'ordinary' }
  const handles: CommitLog[] = []
  try {
    const writer = await createCommitLog(options, { header: { sessionId: 'ordinary' } }); handles.push(writer)
    await writer.append({ entries: [{ type: 'user/message', text: 'committed', seq: 0 }] })
    await writer.close()
    const path = join(root, 'ordinary', 'session.v15.jsonl'), original = await readFile(path)
    const first = await openCommitLog(options, 'read'); handles.push(first)
    const event = first.view().entries[0]!
    expect(event.type).toBe('user/message')
    if (event.type === 'user/message') {
      // Both immutable views and caller-owned copies are valid. Neither may
      // mutate the verified records reused by another independent reader.
      try { event.text = 'caller-only edit' } catch (error) { expect(error).toBeInstanceOf(TypeError) }
    }
    await first.close()
    const second = await openCommitLog(options, 'read'); handles.push(second)
    expect(await readFile(path)).toEqual(original)
    expect(second.view().entries).toEqual([{ type: 'user/message', text: 'committed', seq: 0 }])
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()))
    const failures = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Original log handles did not close')
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-read-snapshot-review-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('protects nested verified values and append receipts without copying the existing history on append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-read-snapshot-review-')), options = { root, sessionId: 'ordinary' }
  const handles: CommitLog[] = []
  try {
    const writer = await createCommitLog(options, { header: { sessionId: 'ordinary', nested: { value: 'header' } } }); handles.push(writer)
    const side = await writer.writeSidecar(Buffer.from('original sidecar'))
    const digest = 'a'.repeat(64)
    const appended = await writer.append({
      entries: [{ type: 'tool/call', callId: 'call', name: 'fixture', args: { nested: { value: 'argument' } }, seq: 0 }],
      ops: [
        { kind: 'meta', patch: { title: 'metadata', nested: { value: 'metadata' } } },
        { kind: 'doc', key: 'document', side },
        { kind: 'intent', id: 'intent', intent: { nested: { value: 'intent' } } },
        { kind: 'batch', id: 'batch', prefixDigest: digest },
        { kind: 'seed', parent: 'parent', cut: 0, digest },
      ],
    })
    const path = join(root, 'ordinary', 'session.v15.jsonl'), original = await readFile(path)
    const committedDigest = appended.digest, firstEntry = writer.entryAt(0), verifiedRecord = writer.records()[1]
    const view = writer.view()
    attempt(() => { (writer.header().nested as { value: string }).value = 'changed header' })
    attempt(() => { (writer.metadata().nested as { value: string }).value = 'changed metadata' })
    attempt(() => { (view.meta.nested as { value: string }).value = 'changed view metadata' })
    const call = view.entries[0]!
    if (call.type === 'tool/call') attempt(() => { (call.args as { nested: { value: string } }).nested.value = 'changed argument' })
    attempt(() => { (view.intents.get('intent')!.nested as { value: string }).value = 'changed intent' })
    attempt(() => { (view.documents.get('document') as { bytes: number }).bytes = 0 })
    attempt(() => { (view.seed as { parent: string }).parent = 'changed parent' })
    attempt(() => { (appended as { digest: string }).digest = 'b'.repeat(64) })
    attempt(() => { (appended.entries as unknown[]).push({ type: 'user/message', text: 'not committed' }) })
    for (const op of appended.ops) {
      if (op.kind === 'meta') attempt(() => { (op.patch.nested as { value: string }).value = 'changed receipt metadata' })
      if (op.kind === 'batch') attempt(() => { (op as { prefixDigest: string }).prefixDigest = 'b'.repeat(64) })
    }
    // Collection objects are detached public copies; edits cannot reach the
    // writer's maps or any verified record used by another reader.
    const documents = view.documents as Map<string, { digest: string; bytes: number }>, batches = view.batches as Map<string, string>
    documents.set('document', { digest: 'b'.repeat(64), bytes: 0 })
    batches.set('batch', 'b'.repeat(64))
    expect(await readFile(path)).toEqual(original)
    expect(await writer.readSidecar(side.digest)).toEqual(new Uint8Array(Buffer.from('original sidecar')))
    expect(writer.metadata()).toMatchObject({ title: 'metadata', nested: { value: 'metadata' } })
    expect(writer.lastBatchDigest()).toBe(digest)
    const next = await writer.append({ entries: [{ type: 'user/message', text: 'after', seq: 1 }] })
    expect(next.prev).toBe(committedDigest)
    expect(writer.entryAt(0)).toBe(firstEntry)
    expect(writer.records()[1]).toBe(verifiedRecord)
    expect(writer.view().documents.get('document')).toEqual(side)
    await writer.close()
    const reader = await openCommitLog(options, 'read'); handles.push(reader)
    expect(reader.header()).toMatchObject({ nested: { value: 'header' } })
    expect(reader.metadata()).toMatchObject({ nested: { value: 'metadata' } })
    expect(reader.entryAt(0)).toMatchObject({ args: { nested: { value: 'argument' } } })
    expect(reader.view().intents.get('intent')).toEqual({ nested: { value: 'intent' } })
    expect(reader.view().documents.get('document')).toEqual(side)
    expect(reader.view().batches.get('batch')).toBe(digest)
    expect(reader.view().seed).toEqual({ parent: 'parent', cut: 0, digest })
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()))
    const failures = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Original log handles did not close')
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-read-snapshot-review-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
