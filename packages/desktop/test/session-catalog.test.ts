import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '../../session-persistence/src/commit/facade.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createDesktopSessionCatalog } from '../src/main/session-catalog.ts'
import { dispatchDesktopRequest, type DesktopIpcDependencies } from '../src/main/ipc.ts'
import { AttachmentDraftStore } from '../src/main/attachment-draft-store.ts'
import { navigationDocumentKey, projectBindingDocumentKey } from '../../desktop-gateway/src/session-navigation.ts'
import { createJsonlDashboardSummaryCache } from '../../desktop-gateway/src/session-dashboard-summary.ts'

const roots: string[] = []
async function heldWorkspaceCatalog(phase: 'root' | 'generation' = 'root') {
  const root = await mkdtemp(join(tmpdir(), 'ih-desktop-catalog-')); roots.push(root)
  vi.stubEnv('IH_CONFIG_DIR', root)
  const sessions = join(root, 'sessions'), held = join(root, 'read-started'), release = join(root, 'release')
  await mkdir(join(sessions, 'a'), {recursive:true}); await mkdir(join(sessions, 'b'))
  let target = join(sessions,'a')
  if (phase === 'generation') {
    await writeFile(join(root,'settings.json'), JSON.stringify({sessionStore:'commit-log'}))
    const writer = createJsonlCommitCoordinator(target)
    try { await writer.create({sessionId:'held-session'}) } finally { await writer.close() }
    const directory = join(target,'held-session')
    const generation = (await readdir(directory)).find(name => /^session\.v\d+\.jsonl$/.test(name))
    if (!generation) throw Error('Missing real commit-log generation')
    target = join(directory,generation)
  }
  vi.stubEnv('IH_TEST_CATALOG_PATH', target)
  vi.stubEnv('IH_TEST_CATALOG_OPERATION', phase === 'generation' ? 'readFile' : 'stat')
  const wrapper = new URL('./helpers/held-session-catalog-worker.mjs', import.meta.url)
  const workspace = (id:string) => ({id,path:root,label:id})
  return { catalog:createDesktopSessionCatalog(sessions, wrapper), workspace, held, sessions, release:()=>writeFile(release,'ok') }
}
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
  const sessionCatalog = createDesktopSessionCatalog(sessionsRoot, new URL('./helpers/session-catalog-worker.mjs', import.meta.url))
  const get = vi.fn(async () => { throw Error('Cold navigation must not launch execution') })
  const liveDashboard = vi.fn(async () => ({ active: true, sessions: [{ id: 'live', live: true, active: true }] }))
  let live = false
  const dependencies = {
    catalog: { get: (id: string) => workspaces.find(workspace => workspace.id === id) },
    runtimes: { get, peek: () => live ? { client: { dashboard: liveDashboard } } : undefined }, sessionCatalog,
    drafts: new AttachmentDraftStore(join(root, 'drafts.json')), notifications: {},
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
      const scope = { workspaceId: workspace.id, identity: 'conversation' }
      const draft = { prompt: 'keep this real edit', references: [], images: [], texts: [], contextRefs: [] }
      await dispatchDesktopRequest({ kind: 'desktop/draft/save', scope, expectedRevision: null, draft }, dependencies)
      expect(await dispatchDesktopRequest({ kind: 'desktop/draft/load', scope }, dependencies)).toMatchObject({ draft })
      await expect(dispatchDesktopRequest({ kind: 'desktop/draft/load', scope: { ...scope, identity: 'hidden' } }, dependencies)).rejects.toThrow('Draft conversation unavailable')
      expect(await dispatchDesktopRequest({ kind: 'desktop/notifications/target', workspaceId: workspace.id, sessionId: 'conversation' }, dependencies)).toEqual({ workspaceId: workspace.id, sessionId: 'conversation', projectId: 'project' })
      await expect(dispatchDesktopRequest({ kind: 'desktop/notifications/target', workspaceId: workspace.id, sessionId: 'archived' }, dependencies)).rejects.toThrow('已封存')
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
    await expect(sessionCatalog.navigationSnapshot(workspaces[0]!)).resolves.toMatchObject({ partial: true })
    expect(await sessionCatalog.navigation(workspaces[0]!)).not.toHaveProperty('conversation')
  } finally { await sessionCatalog.close(); await Promise.all(writers.map(writer => writer.close())) }
  await expect(sessionCatalog.navigation(workspaces[0]!)).rejects.toThrow('closed')
  expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))).toEqual({ sessionStore: kind })
}, 30000)

it('shares a JSONL listing summary for an unchanged file, then reads its newer committed title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-desktop-catalog-')); roots.push(root)
  const cache = createJsonlDashboardSummaryCache()
  const file = join(root, 'session.jsonl')
  await writeFile(file, 'original')
  let name = 'First committed title'
  const load = vi.fn(async () => ({ formatVersion: 1, events: [
    { type: 'session/title', source: 'user', title: name, messageSeqs: [] },
    { type: 'turn/end' },
  ] } as const))
  const summary = () => cache.forListing(root, ['session'])('session', {sessionId:'session',createdAt:'original',title:'Header title'}, load)
  await expect(Promise.all([summary(), summary()])).resolves.toEqual([
    { title: name, turnCount: 1 }, { title: name, turnCount: 1 },
  ])
  await expect(summary()).resolves.toMatchObject({ title: name })
  expect(load).toHaveBeenCalledOnce()
  name = 'New committed title'
  await writeFile(file, 'updated file')
  await expect(summary()).resolves.toEqual({ title: name, turnCount: 1 })
  expect(load).toHaveBeenCalledTimes(2)
})

it('keeps complete per-session summaries across a 513-session scan and forgets removed sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-desktop-catalog-')); roots.push(root)
  const ids = Array.from({ length: 513 }, (_, index) => String(index))
  await Promise.all(ids.map(id => writeFile(join(root, id + '.jsonl'), 'revision')))
  const cache = createJsonlDashboardSummaryCache()
  const load = vi.fn(async () => ({ formatVersion: 1, events: [{ type: 'turn/end' }] } as const))
  async function scan() {
    const read = cache.forListing(root, ids)
    for (const id of ids) await read(id, {sessionId:id,createdAt:'original'}, load)
  }
  await scan()
  await scan()
  expect(load).toHaveBeenCalledTimes(513)
  cache.forListing(root, ids.slice(1))
  await cache.forListing(root, ids)(ids[0]!, {sessionId:ids[0]!,createdAt:'original'}, load)
  expect(load).toHaveBeenCalledTimes(514)
}, 30000)

it('joins an already starting workspace dashboard and falls back to committed data if it fails', async () => {
  const workspace = { id: 'one', path: 'D:/one', label: 'One' }
  const startup = Promise.withResolvers<unknown>()
  const liveDashboard = vi.fn(async () => ({ sessions: [{ id: 'live', live: true }] }))
  const diskDashboard = vi.fn(async () => ({ sessions: [{ id: 'saved', live: false }] }))
  const get = vi.fn()
  const pendingRuntime = vi.fn(() => startup.promise)
  const dependencies = {
    catalog: { get: () => workspace }, runtimes: { get, peek: () => undefined, pendingRuntime },
    sessionCatalog: { dashboard: diskDashboard },
  } as unknown as DesktopIpcDependencies
  const request = () => dispatchDesktopRequest({ kind: 'session/dashboard', workspaceId: workspace.id }, dependencies)
  const pending = request()
  expect(diskDashboard).not.toHaveBeenCalled()
  startup.resolve({ client: { dashboard: liveDashboard } })
  await expect(pending).resolves.toMatchObject({ sessions: [{ id: 'live' }] })
  expect(diskDashboard).not.toHaveBeenCalled()
  pendingRuntime.mockImplementation(() => Promise.reject(new Error('Gateway failed')))
  await expect(request()).resolves.toMatchObject({ sessions: [{ id: 'saved' }] })
  expect(get).not.toHaveBeenCalled()
})

it('returns saved opening rows before startup and uses the live owner for the next request', async () => {
  const startup = Promise.withResolvers<unknown>()
  const disk = { sessions: [{ id: 'saved', live: false }] }
  const live = { sessions: [{ id: 'saved', live: true, running: true }], active: true }
  const dashboard = vi.fn(async () => live)
  const readSaved = vi.fn(async () => disk)
  const dependencies = {
    catalog: { get: () => ({ id: 'one' }) },
    runtimes: { peek: () => undefined, pendingRuntime: () => startup.promise },
    sessionCatalog: { dashboard: readSaved },
  } as unknown as DesktopIpcDependencies
  const request = { kind: 'session/dashboard', workspaceId: 'one' } as const
  await expect(dispatchDesktopRequest({ ...request, opening: true }, dependencies)).resolves.toEqual({ ...disk, committedOnly: true })
  expect(dashboard).not.toHaveBeenCalled()
  startup.resolve({ client: { dashboard } })
  await expect(dispatchDesktopRequest(request, dependencies)).resolves.toEqual(live)
  expect(dashboard).toHaveBeenCalledOnce()
  expect(readSaved).toHaveBeenCalledOnce()
})

it('uses a ready Gateway if the saved opening scan is still pending', async () => {
  const disk = Promise.withResolvers<unknown>()
  const result = { sessions: [], active: true }
  const dependencies = {
    catalog: { get: () => ({ id: 'one' }) },
    runtimes: { peek: () => undefined, pendingRuntime: () => Promise.resolve({ client: { dashboard: async () => result } }) },
    sessionCatalog: { dashboard: () => disk.promise },
  } as unknown as DesktopIpcDependencies
  await expect(dispatchDesktopRequest({ kind: 'session/dashboard', workspaceId: 'one', opening: true }, dependencies)).resolves.toEqual(result)
  disk.reject(Error('Late saved read failed'))
})

it('releases an obsolete opening scan before another workspace dashboard or quit', async () => {
  const {catalog,workspace,held,release} = await heldWorkspaceCatalog()
  const startup = Promise.withResolvers<unknown>()
  const dependencies = { catalog:{get:workspace}, runtimes:{peek:()=>undefined,pendingRuntime:(id:string)=>id==='a'?startup.promise:undefined},
    sessionCatalog:catalog } as unknown as DesktopIpcDependencies
  try {
    const opening=dispatchDesktopRequest({kind:'session/dashboard',workspaceId:'a',opening:true},dependencies)
    await vi.waitFor(async()=>expect(await readFile(held,'utf8')).toBe('read\n'), {timeout:15000})
    startup.resolve({client:{dashboard:async()=>({sessions:[],active:true})}})
    await expect(opening).resolves.toMatchObject({active:true})
    let done=false
    const next = dispatchDesktopRequest({kind:'session/dashboard',workspaceId:'b'},dependencies).then(()=>{done=true})
    await vi.waitFor(()=>expect(done).toBe(true),{timeout:2500})
    await next
    let closed=false
    const closing=catalog.close().then(()=>{closed=true})
    await vi.waitFor(()=>expect(closed).toBe(true),{timeout:2500})
    await closing
  } finally { await release(); await catalog.close() }
},30000)

it('does not cancel a shared scan while another dashboard reader still needs it', async () => {
  const {catalog,workspace,held,release} = await heldWorkspaceCatalog()
  const preview = new AbortController()
  try {
    const active = catalog.dashboard(workspace('a'))
    const speculative = catalog.dashboard(workspace('a'),preview.signal)
    await vi.waitFor(async()=>expect(await readFile(held,'utf8')).toBe('read\n'),{timeout:15000})
    await catalog.navigation(workspace('b')) // independent requests reached the worker
    preview.abort()
    await expect(speculative).rejects.toMatchObject({name:'AbortError'})
    const closing=catalog.close()
    await release()
    expect((await active).sessions).toEqual([])
    await closing
    expect(await readFile(held,'utf8')).toBe('read\n')
  } finally { await release(); await catalog.close() }
},30000)

it('waits for an acquired commit-log snapshot lease and releases it on cancellation before closing', async () => {
  const {catalog,workspace,held,sessions,release} = await heldWorkspaceCatalog('generation')
  const {acquireCommitSnapshotLease} = await import('../../session-commit-log/src/lease.ts')
  const exclusive = () => acquireCommitSnapshotLease('held-session',{lockRoot:join(sessions,'a'),retryMs:5,deadlineMs:100},'exclusive')
  try {
    const preview = new AbortController()
    const pending = catalog.dashboard(workspace('a'),preview.signal)
    await vi.waitFor(async()=>expect(await readFile(held,'utf8')).toContain('read'),{timeout:15000})
    const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'})
    let closed=false
    const close=catalog.close().then(()=>{closed=true})
    await rejected
    await expect(exclusive()).rejects.toThrow()
    expect(closed).toBe(false)
    await release(); await close
    const receipt=await exclusive()
    await receipt.release()
  } finally { await release(); await catalog.close() }
},30000)

it('rejects interrupted queries, reopens a fresh reader and drains work admitted before close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-desktop-catalog-')); roots.push(root)
  const entry = join(root, 'reader.mjs')
  await writeFile(entry, `
    import { parentPort } from 'node:worker_threads'
    parentPort.on('message', ({ id, request }) => {
      if (request.method === 'navigation') process.exit(17)
      parentPort.postMessage({ id, value: { sessions: [] } })
      if (request.method === 'close') parentPort.close()
    })
  `)
  const catalog = createDesktopSessionCatalog(root, entry)
  const workspace = { id: 'cold', path: root, label: 'Cold' }
  try {
    const interrupted = await Promise.allSettled([catalog.navigation(workspace), catalog.navigation(workspace)])
    for (const result of interrupted) expect(result).toMatchObject({ status: 'rejected', reason: Error('Session catalog worker exited (17)') })
    const admitted = catalog.dashboard(workspace)
    const closing = catalog.close()
    expect(catalog.close()).toBe(closing)
    await expect(catalog.dashboard(workspace)).rejects.toThrow('closed')
    await expect(admitted).resolves.toEqual({ sessions: [] })
    await closing
  } finally { await catalog.close() }
})
