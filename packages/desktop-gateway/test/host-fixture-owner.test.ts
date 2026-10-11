import { expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDesktopHost, type DesktopHost } from '../src/host.ts'
import { createHostFixtureOwner } from './host-fixture-owner.ts'

it('drains a real host whose creation is still pending before fixture files can be removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-host-owner-')), workspace = join(root, 'workspace'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, JSON.stringify({ sandboxMode: 'read-only' }))
  const owner = createHostFixtureOwner(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const creation = owner.own(async () => {
    started.resolve(); await release.promise
    return createDesktopHost({ workspace, settingsPath, sessionDir: join(root, 'sessions'), onWrite: () => {} })
  })
  let closing: Promise<void> | undefined
  try {
    await started.promise
    let settled = false
    closing = owner.close().then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    release.resolve()
    const host = await creation
    await closing
    await expect(host.handleLine('')).rejects.toThrow(/closing/)
    await expect(owner.own(() => createDesktopHost({ workspace, settingsPath, sessionDir: join(root, 'late-sessions'), onWrite: () => {} }))).rejects.toThrow(/closing/)
    await rm(root, { recursive: true, force: true })
  } finally {
    release.resolve(); await creation; await closing; await owner.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('waits for every remaining host close after another host reports a cleanup failure', async () => {
  const owner = createHostFixtureOwner(), release = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  const failure = new Error('Controlled host cleanup failure')
  const unavailable = async () => { throw new Error('No fixture RPC') }
  await owner.own(async (): Promise<DesktopHost> => ({ handleLine: unavailable, close: async () => { throw failure } }))
  await owner.own(async (): Promise<DesktopHost> => ({ handleLine: unavailable, close: async () => { started.resolve(); await release.promise } }))
  let settled = false
  const closing = owner.close().then(() => { settled = true; return undefined }, error => { settled = true; return error })
  try {
    await started.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    release.resolve()
    const result = await closing
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(failure)
  } finally { release.resolve(); await closing }
})
