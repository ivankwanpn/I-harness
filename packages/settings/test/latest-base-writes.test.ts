import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { LayeredSettingsStore, SettingsStore } from '../src/index.ts'

const failures = vi.hoisted(() => ({ rename: false }))
vi.mock('node:fs/promises', async load => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (failures.rename) throw Object.assign(new Error('Fixture write failure'), { code: 'EIO' })
    return actual.rename(...args)
  } }
})
const roots: string[] = []
const layers: LayeredSettingsStore[] = []
afterEach(async () => {
  failures.rename = false
  await Promise.all(layers.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(async root => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-settings-latest-base-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-settings-latest-base-'))
  roots.push(root)
  const path = join(root, 'settings.json')
  await writeFile(path, JSON.stringify({ autoTitle: true, extension: { retained: true }, _revision: { onboarding: 4 } }))
  return { path, root }
}
function layered(path: string) {
  const store = new LayeredSettingsStore({ files: [path], watchIntervalMs: false })
  layers.push(store)
  return store
}
const waitPolicy = { firstResponseSeconds: 60, progressSeconds: 60 }

it('preserves an acknowledged patch when another already-loaded store writes an unrelated setting', async () => {
  const { path } = await fixture()
  const first = new SettingsStore({ path }), second = new SettingsStore({ path })
  await Promise.all([first.load(), second.load()])
  await first.set({ autoTitle: false })
  expect((await second.set({ modelWait: waitPolicy })).autoTitle).toBe(false)
  const raw = JSON.parse(await readFile(path, 'utf8'))
  expect(raw).toMatchObject({ autoTitle: false, modelWait: waitPolicy, extension: { retained: true }, _revision: { onboarding: 4 } })
})

it('checks a single-store section guard against the latest saved revision', async () => {
  const { path } = await fixture()
  const first = new SettingsStore({ path }), stale = new SettingsStore({ path })
  await Promise.all([first.load(), stale.load()])
  const before = stale.get()
  await first.set({ onboarding: { welcomeNoticeVersion: 'accepted' } })
  await expect(stale.set({ onboarding: { welcomeNoticeVersion: 'stale' } }, { section: 'onboarding', expectedRevision: 4 }))
    .rejects.toMatchObject({ code: 'settings-section-conflict', expected: 4, actual: 5 })
  expect(stale.get()).toEqual(before)
  expect(JSON.parse(await readFile(path, 'utf8')).onboarding.welcomeNoticeVersion).toBe('accepted')
})

it('retains the latest canonical provider plane and its section revision during an unrelated stale-store write', async () => {
  const { path } = await fixture()
  const first = new SettingsStore({ path }), stale = new SettingsStore({ path })
  await Promise.all([first.load(), stale.load()])
  const provider = { displayName: 'Fixture', baseURL: 'https://fixture.invalid', protocol: 'openai-completions' as const, apiKeyEnv: 'FIXTURE_KEY' }
  await first.set({ llm: { ...first.get().llm, providers: { fixture: provider } } })
  await stale.set({ modelWait: waitPolicy })
  const raw = JSON.parse(await readFile(path, 'utf8'))
  expect(raw.llm.providers.fixture).toEqual(provider)
  expect(raw._revision).toEqual({ onboarding: 4, llm: 1 })
  expect(raw.extension).toEqual({ retained: true })
})

it.each(['single', 'layered'] as const)('retains the %s last-good view and saved bytes after a failed rebased write', async kind => {
  const { path } = await fixture()
  const first = new SettingsStore({ path })
  const stale = kind === 'single' ? new SettingsStore({ path }) : layered(path)
  await Promise.all([first.load(), stale.load()])
  const before = stale.get()
  await first.set({ autoTitle: false })
  const saved = await readFile(path, 'utf8')
  failures.rename = true
  await expect(stale.set({ modelWait: waitPolicy })).rejects.toThrow('Fixture write failure')
  expect(stale.get()).toEqual(before)
  expect(await readFile(path, 'utf8')).toBe(saved)
})

it('refuses an unreadable ordinary mutation while explicit reset can repair a malformed document', async () => {
  const { path } = await fixture()
  const store = new SettingsStore({ path })
  await store.load()
  const before = store.get()
  await writeFile(path, '{ malformed document')
  await expect(store.set({ autoTitle: false })).rejects.toThrow('invalid settings')
  expect(store.get()).toEqual(before)
  expect(await readFile(path, 'utf8')).toBe('{ malformed document')
  expect((await store.reset()).autoTitle).toBe(true)
})

it('checks a layered section guard against the current master document', async () => {
  const { path } = await fixture()
  const first = layered(path), stale = layered(path)
  await Promise.all([first.load(), stale.load()])
  await first.set({ onboarding: { welcomeNoticeVersion: 'accepted' } })
  await expect(stale.set({ onboarding: { welcomeNoticeVersion: 'stale' } }, { section: 'onboarding', expectedRevision: 4 }))
    .rejects.toMatchObject({ code: 'settings-section-conflict', expected: 4, actual: 5 })
  expect(stale.getSectionRevision('onboarding')).toBe(4)
})

it('includes changed lower-layer instruction revisions when checking a layered guard', async () => {
  const { path, root } = await fixture()
  const high = join(root, 'project.json')
  await writeFile(high, '{}')
  const store = new LayeredSettingsStore({ files: [path, high], watchIntervalMs: false })
  layers.push(store)
  await store.load()
  const lower = new SettingsStore({ path })
  await lower.set({ instructions: store.get().instructions })
  await expect(store.set({ instructions: store.get().instructions }, { section: 'instructions', expectedRevision: 0 }))
    .rejects.toMatchObject({ code: 'settings-section-conflict', expected: 0, actual: 1 })
  expect(await readFile(high, 'utf8')).toBe('{}')
})

it.each(['single', 'layered'] as const)('refuses invalid saved instructions before an unrelated %s mutation', async kind => {
  const { path } = await fixture()
  await writeFile(path, JSON.stringify({ instructions: { enabled: true, maxBytes: 24000 } }))
  const store = kind === 'single' ? new SettingsStore({ path }) : layered(path)
  await store.load()
  const before = store.get()
  const invalid = JSON.stringify({ instructions: { enabled: 'invalid', maxBytes: 0 } })
  await writeFile(path, invalid)
  await expect(store.set({ autoTitle: false })).rejects.toThrow('instructions')
  expect(store.get()).toEqual(before)
  expect(await readFile(path, 'utf8')).toBe(invalid)
})

it('preserves an untouched lower policy extension when a valid master overrides it', async () => {
  const { path, root } = await fixture()
  const lower = JSON.stringify({ instructions: { enabled: 'future-value', futurePolicy: { retained: true } }, extension: { lower: true } })
  await writeFile(path, lower)
  const master = join(root, 'project.json')
  await writeFile(master, JSON.stringify({ instructions: { enabled: false, maxBytes: 12000 }, extension: { master: true } }))
  const store = new LayeredSettingsStore({ files: [path, master], watchIntervalMs: false })
  layers.push(store)
  await store.load()
  expect((await store.set({ autoTitle: false })).instructions).toMatchObject({ enabled: false, maxBytes: 12000 })
  expect(await readFile(path, 'utf8')).toBe(lower)
  expect(JSON.parse(await readFile(master, 'utf8'))).toMatchObject({ autoTitle: false, instructions: { enabled: false, maxBytes: 12000 }, extension: { master: true } })
})

it('allows a validated whole-policy replacement to repair the layered master', async () => {
  const { path } = await fixture()
  await writeFile(path, JSON.stringify({ instructions: { enabled: 'invalid' }, extension: { retained: true } }))
  const store = layered(path)
  await store.load()
  await store.set({ instructions: { enabled: true, maxBytes: 24000 } })
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ instructions: { enabled: true, maxBytes: 24000 }, extension: { retained: true } })
})
