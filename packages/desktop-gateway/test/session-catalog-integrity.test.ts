import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createJsonlCommitCoordinator } from "@i-harness/session-persistence-jsonl/internal/commit-coordinator"
import { createDesktopHost } from "../src/host.ts"
import { createCommittedSessionCatalog } from "../src/session-catalog.ts"
import { readListedSessions } from "../src/catalog-rows.ts"
import { createJsonlDashboardSummaryCache, describeSavedSession, loadCatalogSession } from "../src/session-dashboard-summary.ts"
import { createCommitDashboardSummaryCache } from '../src/commit-dashboard-summary.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { createDurableSessionLoader, createSessionService } from '@i-harness/session-executor'
import { createSessionManagement } from '../src/session-management.ts'

it('rechecks a navigation generation after pending writes and calls the original visibility and project checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ih-commit-nav-')), writer = createJsonlCommitCoordinator(dir)
  const coordinator = asSessionCoordinator(writer), cache = createCommitDashboardSummaryCache()
  const service = createSessionService({ workspace: dir, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelPolicy: 'test-mock' })
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), enumerated = Promise.withResolvers<void>()
  const put = coordinator.putDocument.bind(coordinator)
  vi.spyOn(coordinator, 'putDocument').mockImplementation(async (key, value) => { started.resolve(); await release.promise; return put(key, value) })
  const visible = vi.fn(async (_id: string, meta: Awaited<ReturnType<typeof coordinator.profile>>['meta']) =>
    meta.workspaceId === 'workspace' && meta.title !== 'Hidden')
  const projectFor = vi.fn(async (_id: string) => 'confirmed-project')
  const list: typeof writer.list = async (...args) => { const ids = await writer.list(...args); enumerated.resolve(); return ids }
  const manager = createSessionManagement(coordinator, service, visible, { projectFor,
    navigationCatalog: () => cache.forListing(dir, { list, profile: writer.profile.bind(writer) }, () => false),
  })
  let mutation: Promise<unknown> | undefined, navigation: ReturnType<typeof manager.navigationSnapshot> | undefined
  try {
    await coordinator.create({ sessionId: 'saved', title: 'Original', workspaceId: 'workspace' })
    mutation = manager.mutate('saved', 'pin')
    await started.promise
    navigation = manager.navigationSnapshot('saved')
    await enumerated.promise
    await writer.updateMeta('saved', { title: 'Updated' })
    release.resolve()
    await mutation
    expect(await navigation).toEqual({ partial: false, entries: { saved: { pinned: true, unread: false, archived: false, projectId: 'confirmed-project' } } })
    expect(visible.mock.calls.at(-1)?.[1]).toMatchObject({ title: 'Updated', workspaceId: 'workspace' })
    expect(projectFor).toHaveBeenCalledExactlyOnceWith('saved')
    projectFor.mockRejectedValueOnce(new Error('Owner cannot be confirmed'))
    expect(await manager.navigationSnapshot()).toEqual({ partial: true, entries: {} })
    await writer.updateMeta('saved', { title: 'Hidden' })
    expect(await manager.navigationSnapshot()).toEqual({ partial: false, entries: {} })
    expect(projectFor).toHaveBeenCalledTimes(2)
  } finally {
    release.resolve()
    await Promise.allSettled([mutation, navigation])
    cache.clear(); await service.close(); await writer.close(); await rm(dir, { recursive: true, force: true })
  }
})

it('reuses the verified commit listing for display, follows changed generations, and rejects same-size corrupt bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ih-commit-display-'))
  const writer = createJsonlCommitCoordinator(dir), cache = createCommitDashboardSummaryCache()
  const profile = vi.fn(writer.profile.bind(writer)), snapshot = vi.fn(writer.snapshot.bind(writer))
  let projections = 0
  const nativeList: typeof writer.list = (partial, onlyId, visit) => writer.list(partial, onlyId, row => visit?.({
    ...row, snapshot() { projections++; return row.snapshot() },
  }))
  const source = { list: nativeList, profile, snapshot }
  async function list(afterProfile?: () => Promise<void>) {
    const catalog = cache.forListing(dir, source)
    return readListedSessions(catalog, () => async (id, meta) => {
      const change = afterProfile
      afterProfile = undefined
      await change?.()
      return catalog.summary(id, async () => describeSavedSession(await loadCatalogSession(source, id, meta), meta.title))
    })
  }
  try {
    await writer.create({ sessionId: 'saved', title: 'Alpha' })
    for (let i = 0; i < 2; i++) expect((await list()).sessions).toEqual([expect.objectContaining({ title: 'Alpha', turnCount: 0 })])
    expect(profile).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    expect(projections).toBe(1)
    const folder = join(dir, 'saved'), file = (await readdir(folder)).find(name => /^session\.v\d+\.jsonl$/.test(name))!
    const path = join(folder, file), original = await readFile(path)
    const other = join(dir, 'replacement'), replacement = createJsonlCommitCoordinator(other)
    try { await replacement.create({ sessionId: 'saved', title: 'Omega' }) } finally { await replacement.close() }
    const bytes = await readFile(join(other, 'saved', file))
    expect(bytes.length).toBe(original.length)
    const replaced = await list(async () => {
      await writeFile(path + '.replacement', bytes)
      await rename(path + '.replacement', path)
    })
    expect(replaced.sessions).toEqual([expect.objectContaining({ title: 'Omega', turnCount: 0 })])
    const changed = await list(async () => {
      await writer.updateMeta('saved', { title: 'Bravo' })
      await writer.append('saved', [{ type: 'turn/start' }, { type: 'user/message', text: 'one' }, { type: 'turn/end' }])
    })
    expect(changed.sessions).toEqual([expect.objectContaining({ title: 'Bravo', turnCount: 1 })])
    expect(profile).toHaveBeenCalled()
    expect(snapshot).toHaveBeenCalled()
    expect((await list(async () => { await writer.updateMeta('saved', { archived: true }) })).sessions).toEqual([])
    await writer.updateMeta('saved', { archived: false })
    expect((await list()).sessions[0]?.title).toBe('Bravo')
    const text = await readFile(path, 'utf8')
    expect(text).toContain('Omega')
    await writeFile(path, text.replace('Omega', 'Bogus'))
    expect(await list()).toEqual({ sessions: [], listingPartial: true })
    const legacy = createSessionCoordinator(createJsonlBackend(dir))
    try { await legacy.create({ sessionId: 'older', title: 'Legacy' }) } finally { await legacy.close() }
    expect(await list()).toMatchObject({ sessions: [{ id: 'older', title: 'Legacy', turnCount: 0 }], listingPartial: true })
    // A valid native chain copied into another session's path has no confirmed
    // summary there, even if its own digest and every event are valid.
    const misplaced = join(dir, 'misplaced')
    await mkdir(misplaced)
    await writeFile(join(misplaced, file), bytes)
    const degraded = await list()
    expect(degraded.listingPartial).toBe(true)
    const misplacedRow = degraded.sessions.find(row => row.id === 'misplaced')
    expect(misplacedRow).toMatchObject({ id: 'misplaced', title: 'Omega' })
    expect(misplacedRow).not.toHaveProperty('turnCount')
  } finally { cache.clear(); await writer.close(); await rm(dir, { recursive: true, force: true }) }
})

it.each(['rename', 'archive', 'churn'] as const)('rechecks the public catalog row when its journal changes during %s', async change => {
  const dir = await mkdtemp(join(tmpdir(), 'ih-catalog-change-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(dir))
  const cache = createJsonlDashboardSummaryCache()
  let changes = 0
  try {
    await coordinator.create({ sessionId: 'stable', title: 'Stable' })
    await coordinator.create({ sessionId: 'moving', title: 'Original' })
    const list = () => readListedSessions(coordinator, ids => {
      const read = cache.forListing(dir, ids)
      return (id, header) => read(id, header, async () => {
        const session = await loadCatalogSession(coordinator, id, header)
        if (id === 'moving' && (changes === 0 || change === 'churn')) {
          changes++
          await coordinator.updateMeta(id, change === 'archive' ? { archived: true } : { title: 'Renamed ' + changes })
        }
        return session
      })
    })
    const result = await list()
    const expected = (title: string, id: string) => expect.objectContaining({ id, title, turnCount: 0 })
    expect(result.sessions).toContainEqual(expected('Stable', 'stable'))
    const moving = result.sessions.filter(row => row.id === 'moving')
    if (change === 'rename') expect(moving).toEqual([expected('Renamed 1', 'moving')])
    if (change === 'archive') expect(moving).toEqual([])
    if (change === 'churn') {
      expect(moving).toEqual([expect.objectContaining({ id: 'moving', title: 'Renamed 2' })])
      expect(moving[0]).not.toHaveProperty('turnCount')
    }
    expect(result.listingPartial).toBe(change === 'churn' ? true : undefined)
    expect(changes).toBe(change === 'churn' ? 2 : 1)
  } finally { await coordinator.close(); cache.clear(); await rm(dir, { recursive: true, force: true }) }
})

it.each(['jsonl', 'commit-log'] as const)('omits a %s session archived between its profile and its first summary read', async store => {
  const dir = await mkdtemp(join(tmpdir(), 'ih-catalog-archive-'))
  const coordinator = store === 'jsonl' ? createSessionCoordinator(createJsonlBackend(dir)) : createJsonlCommitCoordinator(dir)
  const cache = createJsonlDashboardSummaryCache()
  try {
    await coordinator.create({ sessionId: 'moving', title: 'Original' })
    const result = await readListedSessions(coordinator, ids => {
      const saved = cache.forListing(dir, ids)
      return async (id, header) => {
        await coordinator.updateMeta(id, { archived: true })
        const load = () => loadCatalogSession(coordinator, id, header)
        return store === 'jsonl' ? saved(id, header, load) : describeSavedSession(await load(), header.title)
      }
    })
    expect(result).toEqual({ sessions: [] })
  } finally { await coordinator.close(); cache.clear(); await rm(dir, { recursive: true, force: true }) }
})

it.each(['jsonl', 'commit-log'] as const)('keeps the %s header title and turn count from the same incarnation', async store => {
  const dir = await mkdtemp(join(tmpdir(), 'ih-catalog-title-'))
  const coordinator = store === 'jsonl' ? createSessionCoordinator(createJsonlBackend(dir)) : createJsonlCommitCoordinator(dir)
  const cache = createJsonlDashboardSummaryCache()
  try {
    await coordinator.create({ sessionId: 'moving', title: 'Before' })
    let changed = false
    const list = () => readListedSessions(coordinator, ids => {
      const saved = cache.forListing(dir, ids)
      return async (id, header) => {
        if (!changed) {
          changed = true
          await coordinator.updateMeta(id, { title: 'After' })
          await coordinator.append(id, [{ type: 'turn/start' }, { type: 'user/message', text: 'first' }, { type: 'turn/end' }])
        }
        const load = () => loadCatalogSession(coordinator, id, header)
        return store === 'jsonl' ? saved(id, header, load) : describeSavedSession(await load(), header.title)
      }
    })
    expect((await list()).sessions).toEqual([expect.objectContaining({ id: 'moving', title: 'After', turnCount: 1 })])
    expect((await list()).sessions).toEqual([expect.objectContaining({ id: 'moving', title: 'After', turnCount: 1 })])
    expect(await coordinator.snapshot!('moving')).not.toHaveProperty('catalogHeader')
    const snapshot = await coordinator.snapshot!('moving', { includeCatalogHeader: true })
    expect(snapshot.catalogHeader).toMatchObject({ sessionId: 'moving', title: 'After' })
    snapshot.catalogHeader!.title = 'Local copy'
    expect((await coordinator.profile('moving')).meta.title).toBe('After')
  } finally { await coordinator.close(); cache.clear(); await rm(dir, { recursive: true, force: true }) }
})

it.each(['native', 'legacy'] as const)('uses the %s snapshot header when available and reuses the verified cache entry', async version => {
  const dir = await mkdtemp(join(tmpdir(), 'ih-catalog-profile-'))
  const writer = createSessionCoordinator(createJsonlBackend(dir)), cache = createJsonlDashboardSummaryCache()
  try {
    await writer.create({ sessionId: 'saved', title: 'Title' })
    const profile = vi.fn(writer.profile.bind(writer))
    const snapshot = vi.fn((id: string, options?: { includeCatalogHeader?: boolean }) =>
      writer.snapshot!(id, version === 'native' ? options : undefined))
    const list = () => readListedSessions(writer, ids => {
      const read = cache.forListing(dir, ids)
      return (id, meta) => read(id, meta, () => loadCatalogSession({ snapshot, profile }, id, meta))
    })
    expect((await list()).sessions).toEqual([expect.objectContaining({ id: 'saved', title: 'Title', turnCount: 0 })])
    expect((await list()).sessions).toEqual([expect.objectContaining({ id: 'saved', title: 'Title', turnCount: 0 })])
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(profile).toHaveBeenCalledTimes(version === 'native' ? 0 : 1)
  } finally { await writer.close(); cache.clear(); await rm(dir, { recursive: true, force: true }) }
})

it.each(["jsonl", "commit-log"])("preserves healthy %s rows across cold and live catalog reads", async store => {
  const root = await mkdtemp(join(tmpdir(), "ih-catalog-partial-"))
  vi.stubEnv("IH_CONFIG_DIR", root)
  const workspace = join(root, "workspace"), sessionDir = join(root, "sessions"), settingsPath = join(root, "settings.json")
  const cold = createCommittedSessionCatalog()
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    await mkdir(workspace)
    await mkdir(sessionDir)
    await writeFile(settingsPath, JSON.stringify({ sessionStore: store }))
    const writer = store === "jsonl" ? createSessionCoordinator(createJsonlBackend(sessionDir)) : createJsonlCommitCoordinator(sessionDir)
    try {
      await writer.create({ sessionId: "good", title: "Healthy" })
      await writer.create({ sessionId: "damaged", title: "Damaged" })
    } finally { await writer.close() }
    let damaged = join(sessionDir, "damaged.jsonl")
    if (store === "commit-log") {
      const dir = join(sessionDir, "damaged")
      const journal = (await readdir(dir)).find(name => /^session\.v\d+\.jsonl$/.test(name))
      expect(journal).toBeDefined()
      damaged = join(dir, journal!)
    }
    await writeFile(damaged, "invalid session header\n")
    const dashboard = { listingPartial: true, sessions: [{ id: "good", title: "Healthy" }] }
    const navigation = { partial: true, entries: { good: { pinned: false, unread: false } } }
    expect(await cold.dashboard(sessionDir)).toMatchObject(dashboard)
    expect(await cold.navigationSnapshot(sessionDir)).toEqual(navigation)
    const selected = { partial: false, entries: { good: { pinned: false, unread: false, archived: false } } }
    expect(await cold.navigationSnapshot(sessionDir, "good")).toEqual(selected)
    expect(await cold.navigation(sessionDir, "missing")).toEqual({})
    const frames: unknown[] = []
    host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: frame => frames.push(frame) })
    async function call(id: number, method: string, params = {}) {
      await host!.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      const frame = frames.find(frame => (frame as { id?: number }).id === id) as { result?: unknown; error?: unknown }
      expect(frame?.error).toBeUndefined()
      return frame.result
    }
    await call(1, "initialize")
    expect(await call(2, "session/dashboard")).toMatchObject(dashboard)
    expect(await call(3, "desktop/session/navigation/state", { includeCoverage: true })).toEqual(navigation)
    expect(await call(4, "session/list")).toMatchObject(dashboard)
    expect(await call(5, "desktop/session/navigation/state", { sessionId: "good", includeCoverage: true })).toEqual(selected)
    expect(await call(6, "desktop/session/navigation/state", { sessionId: "missing" })).toEqual({})
  } finally { await host?.close(); await cold.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
}, 30000)

it("only treats a missing JSONL directory as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-list-io-"))
  const path = join(root, "sessions")
  try {
    expect(await createJsonlBackend(path).list()).toEqual([])
    await writeFile(path, "not a directory")
    await expect(createJsonlBackend(path).list()).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("keeps an unpublished JSONL session out of a single-session navigation lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-catalog-publish-"))
  const sessionDir = join(root, "sessions")
  vi.stubEnv("IH_CONFIG_DIR", root)
  const catalog = createCommittedSessionCatalog()
  const writer = createSessionCoordinator(createJsonlBackend(sessionDir))
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ sessionStore: "jsonl" }))
    await writer.create({ sessionId: "first" })
    await writer.create({ sessionId: "second" })
    await writeFile(join(sessionDir, "first.jsonl.publishing"), "")
    expect(await catalog.navigation(sessionDir, "first")).toEqual({})
    expect(await catalog.navigation(sessionDir, "second")).toEqual({ second: { pinned: false, unread: false, archived: false } })
  } finally { await writer.close(); await catalog.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})
