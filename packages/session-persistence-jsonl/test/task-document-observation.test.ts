import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, truncate, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { issueHeldTaskDocumentScope } from '../../session-persistence/src/coordinator/task-document-scope.ts'
import { createTaskDocumentObservation } from '../src/backend/task-document-observation.ts'

async function fixture(run: (f: { root: string; path: string; scope: ReturnType<typeof issueHeldTaskDocumentScope>; revoke(): void }) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'ih-obs-')), root = join(base, 'store')
  await mkdir(root)
  const owner = createOwnership({ lockRoot: base }, { lock: { enabled: true } })
  const claim = await owner.pinOwnership('parent'), lease = await owner.acquireLease('doc:task-parent')
  let active = true
  const admission = { assertActive() { if (!active || !lease.held) throw new Error('revoked') } }
  const scope = issueHeldTaskDocumentScope(owner, 'parent', claim, admission)
  try { await run({ root, path: join(root, 'task-parent.doc.jsonl'), scope, revoke() { active = false } }) }
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
