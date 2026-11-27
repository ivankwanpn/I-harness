// @vitest-environment jsdom
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { projectBindingDocumentKey } from '../../desktop-gateway/src/session-navigation.ts'
import { dispatchDesktopRequest, type DesktopIpcDependencies } from '../src/main/ipc.ts'
import { createDesktopSessionCatalog } from '../src/main/session-catalog.ts'
import type { DesktopBridge, DesktopEvent } from '../src/shared/bridge.ts'
import { ProjectSidebar } from '../src/renderer/shell/ProjectSidebar.tsx'

afterEach(() => vi.unstubAllEnvs())

it.each(['owners', 'sessions'] as const)('discovers a moved session through a dormant physical folder after standby retires its %s read', async mode => {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'ih-sidebar-standby-'))
  vi.stubEnv('IH_CONFIG_DIR', root)
  const sessionsRoot = join(root, 'sessions'), sourceRoot = join(sessionsRoot, 'source')
  const workspaces = await Promise.all(['destination', 'source', 'other'].map(async id => {
    const path = join(root, id); await mkdir(path); return { id, path, label: id }
  }))
  await writeFile(join(root, 'settings.json'), JSON.stringify({ sessionStore: 'jsonl' }))
  const writer = createJsonlTaskTransitionCoordinator(sourceRoot, { lock: { enabled: true, lockRoot: sourceRoot } }, taskDocumentStorageContract)
  const catalog = createDesktopSessionCatalog(sessionsRoot, resolve(import.meta.dirname, 'helpers/session-catalog-worker.mjs'))
  const oldResult = Promise.withResolvers<unknown>(), deliverOld = Promise.withResolvers<void>()
  const settled = new Set<string>(), listeners = new Set<(event: DesktopEvent) => void>()
  const routes: { kind: string; workspaceId: string; live: boolean }[] = []
  const live = new Set(['source', 'other'])
  const noWake = vi.fn(() => { throw Error('Sidebar discovery must not start a Gateway') })
  const dependencies = {
    catalog: { get: (id: string) => workspaces.find(row => row.id === id) }, sessionCatalog: catalog,
    runtimes: { get: noWake, peek: (id: string) => {
      if (!live.has(id)) return undefined
      const workspace = workspaces.find(row => row.id === id)!
      return { info: { capabilities: { 'desktop-sessions': ['1'] } }, client: {
        dashboard: () => catalog.dashboard(workspace),
        request: () => catalog.navigationSnapshot(workspace),
      } }
    } },
  } as unknown as DesktopIpcDependencies
  const bridge: DesktopBridge = {
    async request(input) {
      if (input.kind !== 'session/dashboard' && input.kind !== 'desktop/session/navigation/state') throw Error('Unexpected sidebar request')
      const wasLive = live.has(input.workspaceId)
      routes.push({ kind: input.kind, workspaceId: input.workspaceId, live: wasLive })
      const result = await dispatchDesktopRequest(input, dependencies)
      if (wasLive && input.kind === 'desktop/session/navigation/state' && input.workspaceId === 'source') {
        oldResult.resolve(result)
        await deliverOld.promise
      }
      settled.add(input.workspaceId)
      return result
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  try {
    const title = 'History moved to the logical project'
    const bind = (projectId: string) => writer.putDocument(projectBindingDocumentKey('moved'), { version: 1, projectId })
    await writer.create({ sessionId: 'moved', title })
    await bind('source')
    const projects = workspaces.map(folder => ({ id: folder.id, name: folder.label, workspaceIds: [folder.id], createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
    render(<ProjectSidebar bridge={bridge} projects={projects} workspaces={workspaces} selectedProjectId="destination" selectedWorkspaceId="destination" canCreate={false}
      onProjects={() => {}} onSelectProject={() => {}} onSelectWorkspace={() => {}} onSelectSession={() => {}} onManageSession={async () => {}} onManageArchived={() => {}} />)
    if (mode === 'sessions') fireEvent.click(screen.getByRole('button', { name: '展開專案 source' }))
    await expect(oldResult.promise).resolves.toEqual({ entries: { moved: { projectId: 'source', pinned: false, unread: false } }, partial: false })
    await waitFor(() => expect(settled.has('other')).toBe(true))
    expect(screen.queryByText(title)).toBeNull()
    await bind('destination')

    // A Gateway-owned reply has reached main. Only renderer delivery is held.
    // Main removes the live route before publishing each standby notification.
    act(() => {
      for (const workspaceId of ['source', 'other']) {
        live.delete(workspaceId)
        for (const listener of listeners) listener({ kind: 'sdk/idle', method: 'sdk/idle', workspaceId, runtimeGeneration: 0 })
      }
    })
    const group = within(screen.getByRole('button', { name: /^destination$/ }).closest('li')!)
    expect(await group.findByText(title, {}, { timeout: 4000 })).toBeTruthy()
    expect(routes.filter(row => row.workspaceId === 'other')).toHaveLength(1)
    const passiveSource = routes.filter(row => row.workspaceId === 'source' && !row.live).map(row => row.kind)
    expect(passiveSource).toEqual(mode === 'owners'
      ? ['desktop/session/navigation/state', 'session/dashboard', 'desktop/session/navigation/state']
      : ['session/dashboard', 'desktop/session/navigation/state'])
    await act(async () => { deliverOld.resolve(); await deliverOld.promise })
    expect(group.getByText(title)).toBeTruthy()
    expect(noWake).not.toHaveBeenCalled()
  } finally {
    deliverOld.resolve()
    cleanup()
    const closed = await Promise.allSettled([catalog.close(), writer.close()])
    const target = await realpath(root)
    if (dirname(target) !== parent || !basename(target).startsWith('ih-sidebar-standby-')) throw Error('Unsafe fixture cleanup')
    await rm(target, { recursive: true, force: true, maxRetries: 2 })
    const failure = closed.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}, 15000)
