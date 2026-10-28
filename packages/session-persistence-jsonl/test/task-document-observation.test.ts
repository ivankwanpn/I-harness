import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, truncate, open, rm, rename, lstat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { issueHeldTaskDocumentScope } from '../../session-persistence/src/coordinator/task-document-scope.ts'
import { createTaskDocumentObservation } from '../src/backend/task-document-observation.ts'

async function fixture(run: (f: { root: string; path: string; scope: ReturnType<typeof issueHeldTaskDocumentScope>; revoke(): void; releaseLease(): Promise<void> }) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'ih-obs-')), root = join(base, 'store')
  await mkdir(root)
  const owner = createOwnership({ lockRoot: base }, { lock: { enabled: true } })
  const claim = await owner.pinOwnership('parent'), lease = await owner.acquireLease('doc:task-parent')
  let active = true
  const admission = { assertActive() { if (!active || !lease.held) throw new Error('revoked') } }
  const scope = issueHeldTaskDocumentScope(owner, 'parent', claim, admission)
  try { await run({ root, path: join(root, 'task-parent.doc.jsonl'), scope, revoke() { active = false }, releaseLease: async () => { await lease.release() } }) }
  finally { await lease.release(); await claim.release(); await rm(base, { recursive: true, force: true }) }
}

it('retains one detached observation for literal v1 and v2 bytes', async () => {
  for (const raw of [' { "version" : 1, "tasks": [] }\n', '{\n "tasks": [], "version": 2\n}\n']) await fixture(async ({ root, path, scope }) => {
    await writeFile(path, raw)
    const session = createTaskDocumentObservation(root, path, scope)
    const first = await session.observe()
    expect(first.kind).toBe('present')
    if (first.kind === 'present') { expect(first.value).toEqual(JSON.parse(raw)); expect(Object.isFrozen(first.value)).toBe(true) }
    await writeFile(path, '{"changed":true}')
    expect(await session.observe()).toBe(first)
    await session.settleResources()
  })
})

it('distinguishes missing file from missing root and rejects malformed and oversized files', async () => fixture(async ({ root, path, scope }) => {
  expect(await createTaskDocumentObservation(root, path, scope).observe()).toEqual({ kind: 'absent' })
  await expect(createTaskDocumentObservation(join(root, 'missing'), join(root, 'missing', 'task-parent.doc.jsonl'), scope).observe()).rejects.toThrow()
  await writeFile(path, '{')
  await expect(createTaskDocumentObservation(root, path, scope).observe()).rejects.toThrow()
  await truncate(path, 64 * 1024 * 1024 + 1)
  await expect(createTaskDocumentObservation(root, path, scope).observe()).rejects.toThrow(/large/i)
}))

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

it('refuses the waiting observation after actual lease release during original close', async () => fixture(async ({ root, path, scope, releaseLease }) => {
  await writeFile(path, '{}')
  const closing = gate(), finish = gate()
  let closes = 0
  const session = createTaskDocumentObservation(root, path, scope, async (p, flags) => {
    const handle = await open(p, flags), close = handle.close
    handle.close = async function () {
      closes++
      closing.release()
      await finish.promise
      await Reflect.apply(close, handle, [])
    }
    return handle
  })
  const pending = session.observe()
  const disposition = pending.then(value => ({ ok: true, value }), cause => ({ ok: false, cause }))
  await closing.promise
  await releaseLease()
  expect(() => scope.assertActive()).toThrow(/revoked/)
  finish.release()
  expect(await disposition).toMatchObject({ ok: false, cause: expect.any(Error) })
  await session.settleResources()
  expect(closes).toBe(1)
}))

it('allows concurrent sibling churn while the original file is unchanged', async () => fixture(async ({ root, path, scope }) => {
  await writeFile(path, '{"version":1}')
  const reading = gate(), finish = gate()
  const session = createTaskDocumentObservation(root, path, scope, async (p, flags) => {
    const handle = await open(p, flags), read = handle.read
    handle.read = (async function (...args: Parameters<typeof read>) {
      reading.release()
      await finish.promise
      return Reflect.apply(read, handle, args)
    }) as typeof read
    return handle
  })
  const pending = session.observe()
  await reading.promise
  const before = await lstat(root)
  await writeFile(join(root, 'unrelated.doc.jsonl'), '{}')
  await rm(join(root, 'unrelated.doc.jsonl'))
  // Make the metadata change deterministic even on coarse timestamp filesystems.
  await utimes(root, before.atime, new Date(before.mtimeMs + 2000))
  expect((await lstat(root)).mtimeMs).not.toBe(before.mtimeMs)
  finish.release()
  expect(await pending).toMatchObject({ kind: 'present', value: { version: 1 } })
  await session.settleResources()
}))

it('still refuses replacement of the original root before open even with the same file', async () => fixture(async ({ root, path, scope }) => {
  await writeFile(path, '{}')
  const reading = gate(), finish = gate()
  const session = createTaskDocumentObservation(root, path, scope, async (p, flags) => {
    reading.release()
    await finish.promise
    return open(p, flags)
  })
  const pending = session.observe()
  const disposition = pending.then(() => undefined, cause => cause)
  await reading.promise
  await rename(root, `${root}-original`)
  await mkdir(root)
  await rename(join(`${root}-original`, 'task-parent.doc.jsonl'), path)
  finish.release()
  expect(await disposition).toBeInstanceOf(Error)
  await session.settleResources()
}))

it('retains falsey body and close causes through original cleanup retry without rereading', async () => fixture(async ({ root, path, scope }) => {
  await writeFile(path, '{}')
  let opens = 0, reads = 0, closes = 0
  const session = createTaskDocumentObservation(root, path, scope, async (p, flags) => {
    opens++
    const handle = await open(p, flags), close = handle.close
    handle.read = (async () => { reads++; throw false }) as typeof handle.read
    handle.close = async function () {
      expect(this).toBe(handle)
      if (++closes <= 2) {
        handle.close = async () => { throw new Error('Replacement close must not run') }
        throw 0
      }
      await Reflect.apply(close, handle, [])
    }
    return handle
  })
  const failure = await session.observe().then(() => undefined, cause => cause)
  await expect(session.settleResources()).rejects.toBe(0)
  await session.settleResources()
  expect(await session.observe().then(() => undefined, cause => cause)).toBe(failure)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toEqual([false, 0])
  expect({ opens, reads, closes }).toEqual({ opens: 1, reads: 1, closes: 3 })
  await session.settleResources()
  expect(closes).toBe(3)
}))

it.each([undefined, null, false, 0])('retains literal body rejection %s when close succeeds', async cause => fixture(async ({ root, path, scope }) => {
  await writeFile(path, '{}')
  const session = createTaskDocumentObservation(root, path, scope, async (p, flags) => {
    const handle = await open(p, flags)
    handle.read = (async () => { throw cause }) as typeof handle.read
    return handle
  })
  await expect(session.observe()).rejects.toBe(cause)
  await session.settleResources()
  await expect(session.observe()).rejects.toBe(cause)
}))

it('refuses foreign scope, copied receivers and revoked scope', async () => fixture(async ({ root, path, scope, revoke }) => {
  expect(() => createTaskDocumentObservation(root, path, { ...scope } as typeof scope)).toThrow()
  const session = createTaskDocumentObservation(root, path, scope)
  await expect(session.observe.call({})).rejects.toThrow()
  revoke()
  await expect(session.observe()).rejects.toThrow()
}))

it('retains a failed original close until explicit settlement', async () => fixture(async ({ root, path, scope }) => {
  await writeFile(path, '{}')
  let closes = 0
  const session = createTaskDocumentObservation(root, path, scope, async (p, flags) => {
    const handle = await open(p, flags)
    const close = handle.close
    handle.close = async function () { if (++closes === 1) throw false; return Reflect.apply(close, handle, []) }
    return handle
  })
  await expect(session.observe()).rejects.toBe(false)
  expect(closes).toBe(1)
  await session.settleResources()
  expect(closes).toBe(2)
}))

it('does not treat a failed close on an invalidated handle as a later successful close', async () => fixture(async ({ root, path, scope }) => {
  await writeFile(path, '{}')
  let closes = 0
  const session = createTaskDocumentObservation(root, path, scope, async (p, flags) => {
    const handle = await open(p, flags), close = handle.close
    handle.close = async function () { closes++; await Reflect.apply(close, handle, []); throw 0 }
    return handle
  })
  await expect(session.observe()).rejects.toBe(0)
  await expect(session.settleResources()).rejects.toBe(0)
  expect(closes).toBe(1)
}))
