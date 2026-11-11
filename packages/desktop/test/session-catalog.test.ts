import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '../../session-persistence/src/commit/facade.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createDesktopSessionCatalog } from '../src/main/session-catalog.ts'
import { dispatchDesktopRequest, type DesktopIpcDependencies } from '../src/main/ipc.ts'
import { navigationDocumentKey, projectBindingDocumentKey } from '../../desktop-gateway/src/session-navigation.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-desktop-catalog-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['jsonl', 'commit-log'] as const)('reads cold %s navigation and titles across workspaces without starting execution, then observes committed edits', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'ih-desktop-catalog-')); roots.push(root)
  vi.stubEnv('IH_CONFIG_DIR', root)
  await writeFile(join(root, 'settings.json'), JSON.stringify({ sessionStore: kind }))
  const sessionsRoot = join(root, 'sessions')
  const workspaces = await Promise.all(['one', 'two'].map(async id => {
    const path = join(root, id); await mkdir(path)
    return { id, path, label: id }
  }))
  const writers = workspaces.map(workspace => {
    const path = join(sessionsRoot, workspace.id)
    const lock = { enabled: true, lockRoot: path }
    return kind === 'jsonl' ? createJsonlTaskTransitionCoordinator(path, { lock }, taskDocumentStorageContract)
      : asSessionCoordinator(createJsonlCommitCoordinator(path, { lock }), { taskDocument: { validator: taskDocumentStorageContract, empty: taskDocumentStorageContract.empty } })
  })
  const sessionCatalog = createDesktopSessionCatalog(sessionsRoot)
  const get = vi.fn(async () => { throw Error('Cold navigation must not launch execution') })
  const liveDashboard = vi.fn(async () => ({ active: true, sessions: [{ id: 'live', live: true, active: true }] }))
  let live = false
  const dependencies = {
    catalog: { get: (id: string) => workspaces.find(workspace => workspace.id === id) },
    runtimes: { get, peek: () => live ? { client: { dashboard: liveDashboard } } : undefined }, sessionCatalog,
  } as unknown as DesktopIpcDependencies
  try {
    for (const writer of writers) {
      await writer.create({ sessionId: 'conversation', title: 'Old header' })
      await writer.append('conversation', [{ type: 'session/title', source: 'user', title: 'Manual committed title', messageSeqs: [] }])
      await writer.create({ sessionId: 'hidden', origin: 'subagent', parentSession: 'conversation', seedLength: 0 })
      await writer.create({ sessionId: 'archived', archived: true })
      await writer.putDocument(navigationDocumentKey('conversation'), { version: 1, pinned: true, unread: true })
      await writer.putDocument(projectBindingDocumentKey('conversation'), { version: 1, projectId: 'project' })
    }
    for (const workspace of workspaces) {
      const navigation = await dispatchDesktopRequest({ kind: 'desktop/session/navigation/state', workspaceId: workspace.id }, dependencies)
      expect(navigation).toEqual({ conversation: { pinned: true, unread: true, projectId: 'project' }, archived: { pinned: false, unread: false } })
      const dashboard = await dispatchDesktopRequest({ kind: 'session/dashboard', workspaceId: workspace.id }, dependencies)
      expect(dashboard).toMatchObject({ sessions: [{ id: 'conversation', title: 'Manual committed title', live: false }] })
    }
    expect(get).not.toHaveBeenCalled()
    const empty = { id: 'empty', path: root, label: 'Empty' }
    expect(await sessionCatalog.navigation(empty)).toEqual({})
    expect(await sessionCatalog.dashboard(empty)).toEqual({ sessions: [] })
    await expect(stat(join(sessionsRoot, 'empty'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writers[0]!.putDocument(navigationDocumentKey('conversation'), { version: 1, pinned: false, unread: false })
    await writers[0]!.updateMeta('conversation', { archived: true })
    expect(await sessionCatalog.dashboard(workspaces[0]!)).toEqual({ sessions: [] })
    expect((await sessionCatalog.navigation(workspaces[0]!)).conversation).toEqual({ pinned: false, unread: false, projectId: 'project' })
    await writers[0]!.create({ sessionId: 'deleted' })
    await writers[0]!.releaseOwnership('deleted')
    await writers[0]!.deleteOwnedSession!('deleted', { documents: [] })
    expect(await sessionCatalog.navigation(workspaces[0]!)).not.toHaveProperty('deleted')
    live = true
    expect(await dispatchDesktopRequest({ kind: 'session/dashboard', workspaceId: 'one' }, dependencies)).toMatchObject({ active: true })
    expect(liveDashboard).toHaveBeenCalledOnce()
    expect(get).not.toHaveBeenCalled()
    await expect(dispatchDesktopRequest({ kind: 'session/dashboard', workspaceId: 'foreign' }, dependencies)).rejects.toThrow('Unknown workspace')
    live = false
    await writers[0]!.putDocument(navigationDocumentKey('conversation'), { version: 1, pinned: 'invalid', unread: false })
    await expect(sessionCatalog.navigation(workspaces[0]!)).rejects.toThrow('navigation metadata is invalid')
  } finally { await sessionCatalog.close(); await Promise.all(writers.map(writer => writer.close())) }
  await expect(sessionCatalog.navigation(workspaces[0]!)).rejects.toThrow('closed')
  expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))).toEqual({ sessionStore: kind })
}, 30000)
