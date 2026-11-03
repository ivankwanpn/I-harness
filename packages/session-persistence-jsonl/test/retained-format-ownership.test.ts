import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append, createSession, fromJSONL, readGenerationActions, toJSONL, type ResultEnvelope, type SessionEvent } from '@i-harness/core-session'
import { createSessionCoordinator, SessionFormatUnsupportedError, type PersistenceBackend } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { format8Fixture } from '../../core-session/test/fixtures/format8-journal.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function store(raw: string) {
  const root = await mkdtemp(join(tmpdir(), 'ih-owned-retained-format-')); roots.push(root)
  const path = join(root, 'legacy.jsonl')
  await writeFile(path, raw)
  return { root, path, backend: createJsonlBackend(root) }
}
const headerOf = (raw: string) => JSON.parse(raw.slice(0, raw.indexOf('\n')))
const bodyOf = (raw: string) => raw.slice(raw.indexOf('\n') + 1)
function withVersion(raw: string, formatVersion: number) {
  return JSON.stringify({ ...headerOf(raw), formatVersion }) + raw.slice(raw.indexOf('\n'))
}
function mutationCalls(backend: PersistenceBackend) {
  // Spies count before delegating to the real original owners, including the
  // journal read that may truncate a torn tail and the managed append path.
  return {
    repair: vi.spyOn(backend, 'repair'), upgrade: vi.spyOn(backend, 'upgradeSessionFormat'),
    replace: vi.spyOn(backend, 'replaceEvents'), append: vi.spyOn(backend, 'append'),
    journalRead: vi.spyOn(backend, 'readJournalPrefix'), ownedAppend: vi.spyOn(backend, 'appendOwnedBatch'),
    reconcile: vi.spyOn(backend, 'reconcileOwnedBatch'),
  }
}
function noMutations(calls: ReturnType<typeof mutationCalls>) {
  expect(Object.fromEntries(Object.entries(calls).map(([key, spy]) => [key, spy.mock.calls.length])))
    .toEqual({ repair: 0, upgrade: 0, replace: 0, append: 0, journalRead: 0, ownedAppend: 0, reconcile: 0 })
}
function forbidExecution() {
  const fetch = vi.fn(() => { throw new Error('owned open does not authorize model execution') })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
function predecessor(version: 8 | 9 | 10) {
  const original = format8Fixture()
  // A separate literal predecessor fixture keeps the original literal8 fixture
  // intact and adds a historical unknown result with no retained envelope.
  const session = fromJSONL(original.raw)
  session.formatVersion = version
  append(session, { type: 'tool/call', callId: 'old-unknown', name: 'write', args: {} })
  append(session, { type: 'tool/result', callId: 'old-unknown', name: 'write', isError: true, output: { code: 'TOOL_OUTCOME_UNKNOWN', replay: false } })
  const raw = toJSONL(session)
  return JSON.stringify({ ...original.header, ...headerOf(raw), formatVersion: version }) + raw.slice(raw.indexOf('\n'))
}

it('upgrades nonempty10 through coordinator metadata while refusing future/downgrade barriers without byte changes', async () => {
  const raw = predecessor(10), {path,backend} = await store(raw)
  const coordinator = createSessionCoordinator(backend,{lock:{enabled:true}})
  try {
    await coordinator.updateMeta('legacy',{title:'continued metadata'})
    const changed = await readFile(path,'utf8')
    expect(headerOf(changed)).toMatchObject({formatVersion:CURRENT_FORMAT_VERSION,title:'continued metadata'})
    expect(headerOf(changed).semanticSeed).toBeUndefined()
    expect(bodyOf(changed)).toBe(bodyOf(raw))
    for(const [expected,target] of [[CURRENT_FORMAT_VERSION,10],[CURRENT_FORMAT_VERSION+1,CURRENT_FORMAT_VERSION],[10,CURRENT_FORMAT_VERSION+1]]) {
      await expect(backend.upgradeSessionFormat!('legacy',expected!,target!)).rejects.toThrow()
      expect(await readFile(path,'utf8')).toBe(changed)
    }
  } finally { await coordinator.close() }
})

describe.each([8, 9, 10] as const)('literal predecessor%s owned migration', version => {
  it.each(['owned', 'direct', 'coordinator'])('preserves the body, reservation and unknown result through one append and fresh reopen (barrier=%s)', async barrier => {
    const raw = predecessor(version), original = fromJSONL(raw), header = headerOf(raw), body = bodyOf(raw)
    expect(header.formatVersion).toBe(version)
    expect(original.formatVersion).toBe(CURRENT_FORMAT_VERSION)
    const { root, path, backend } = await store(raw), fetch = forbidExecution()
    const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
    let afterAppend = ''
    try {
      await coordinator.snapshot!('legacy')
      expect(await readFile(path, 'utf8')).toBe(raw)
      if (barrier === 'direct') expect((await backend.upgradeSessionFormat!('legacy', version, CURRENT_FORMAT_VERSION)).formatVersion).toBe(CURRENT_FORMAT_VERSION)
      if (barrier === 'coordinator') expect(await coordinator.ensureWritableFormat!('legacy')).toEqual({ formatVersion: CURRENT_FORMAT_VERSION })
      const document = await coordinator.openManagedDocument('legacy')
      expect(coordinator.ownerOf('legacy')).toBe(true)
      const opened = await readFile(path, 'utf8')
      expect(headerOf(opened)).toEqual({ ...header, formatVersion: CURRENT_FORMAT_VERSION })
      expect(bodyOf(opened)).toBe(body)
      expect(document.view.events).toEqual(original.events)
      expect(readGenerationActions(document.view.events)[0]!.attempts).toMatchObject([{ reservation: { attemptId: 'old-attempt' }, rebinds: 0 }])
      expect(readGenerationActions(document.view.events)[0]!.attempts[0]!.disposition).toBeUndefined()
      expect(await document.metadata.admit({ type: 'session/title', title: 'owned continuation', messageSeqs: [], source: 'fallback' }))
        .toMatchObject({ kind: 'committed', seqs: [original.events.length] })
      afterAppend = await readFile(path, 'utf8')
      expect(bodyOf(afterAppend).startsWith(body)).toBe(true)
    } finally { await coordinator.close() }
    expect(coordinator.ownerOf('legacy')).toBe(false)
    const freshBackend = createJsonlBackend(root), fresh = createSessionCoordinator(freshBackend, { lock: { enabled: true } })
    try {
      const reopened = await fresh.openManagedDocument('legacy')
      expect(reopened.view.events.slice(0, original.events.length)).toEqual(original.events)
      expect(reopened.view.events).toHaveLength(original.events.length + 1)
      expect(reopened.view.events.at(-1)).toMatchObject({ type: 'session/title', title: 'owned continuation' })
      expect(readGenerationActions(reopened.view.events)).toEqual(readGenerationActions(original.events))
      const unknown = reopened.view.events.find(event => event.type === 'tool/result')!
      expect(unknown).toEqual({ type: 'tool/result', callId: 'old-unknown', name: 'write', isError: true, output: { code: 'TOOL_OUTCOME_UNKNOWN', replay: false }, seq: 8 })
      expect(unknown).not.toHaveProperty('envelope')
      expect(reopened.view.events.some(event => event.type === 'tool/dispatch' || event.type === 'subagent/start' || event.type === 'subagent/end')).toBe(false)
      expect(headerOf(await readFile(path, 'utf8'))).toEqual({ ...header, formatVersion: CURRENT_FORMAT_VERSION })
      expect(headerOf(afterAppend)).not.toHaveProperty('subagentProtocolVersion')
      expect(await readFile(path, 'utf8')).toBe(afterAppend)
      expect(fetch).not.toHaveBeenCalled()
    } finally { await fresh.close() }
  })
})

const ref = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 500, contentDigest: 'c'.repeat(64), completeness: 'source-limited' } as const
const envelope: ResultEnvelope = {
  version: 1, execution: { outcome: 'failed', dispatch: 'dispatched' }, preview: 'original retained preview',
  media: [{ mediaType: 'image/png', dataBase64: 'aGVsbG8=', name: 'original-media' }],
  retention: { kind: 'artifact', ref }, dependencies: { kind: 'artifact-set', ref, count: 1 },
}
const slots: readonly { name: string; events: SessionEvent[] }[] = [
  { name: 'ordinary tool/result', events: [{ type: 'tool/call', callId: 'tool', name: 'read', args: {} }, { type: 'tool/result', callId: 'tool', name: 'read', envelope }] },
  { name: 'nested code/result', events: [{ type: 'code/call', cellId: 'cell', callId: 'nested', name: 'read', args: {} }, { type: 'code/result', cellId: 'cell', callId: 'nested', name: 'read', envelope }] },
  { name: 'emitted code/output', events: [{ type: 'code/output', cellId: 'cell', envelope }] },
  { name: 'subagent/end envelope and revision', events: [{ type: 'subagent/end', version: 1, taskId: 'child', outcome: 'error', resultRevision: 'original-child-revision', resultText: 'original child preview', error: 'original child error', envelope }] },
  { name: 'job/status retained result', events: [{ type: 'job/status', version: 1, job: { jobId: 'job', kind: 'subagent', label: 'original job', status: 'completed', outputAvailable: true, result: { version: 1, kind: 'retained', revision: 'original-job-revision', envelope } } }] },
]
function currentFixture(events: readonly SessionEvent[]) {
  const session = createSession()
  for (const event of events) append(session, event)
  const framed = toJSONL(session)
  const raw = JSON.stringify({ ...headerOf(framed), sessionId: 'legacy', createdAt: 'synthetic-owned-current' }) + framed.slice(framed.indexOf('\n'))
  // Every negative starts as a fully validated, framed current11 fixture.
  expect(fromJSONL(raw)).toMatchObject({ formatVersion: CURRENT_FORMAT_VERSION, events: session.events })
  return raw
}

describe.each(slots)('$name version ownership', ({ events }) => {
  it('keeps current11 retained facts through an actual owned append, close and fresh reopen', async () => {
    const raw = currentFixture(events), original = fromJSONL(raw)
    const { root, path, backend } = await store(raw), fetch = forbidExecution()
    const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
    let committed = ''
    try {
      const document = await coordinator.openManagedDocument('legacy')
      expect(document.view.events).toEqual(original.events)
      expect(await readFile(path, 'utf8')).toBe(raw)
      expect(await document.metadata.admit({ type: 'session/title', title: 'retained continuation', messageSeqs: [], source: 'fallback' }))
        .toMatchObject({ kind: 'committed', seqs: [original.events.length] })
      committed = await readFile(path, 'utf8')
      expect(bodyOf(committed).startsWith(bodyOf(raw))).toBe(true)
    } finally { await coordinator.close() }
    expect(coordinator.ownerOf('legacy')).toBe(false)
    const fresh = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    try {
      const reopened = await fresh.openManagedDocument('legacy')
      expect(reopened.view.events.slice(0, original.events.length)).toEqual(original.events)
      expect(reopened.view.events).toHaveLength(original.events.length + 1)
      expect(reopened.view.events.at(-1)).toMatchObject({ type: 'session/title', title: 'retained continuation' })
      expect(await readFile(path, 'utf8')).toBe(committed)
      expect(fetch).not.toHaveBeenCalled()
    } finally { await fresh.close() }
  })
  it.each([8, 9, CURRENT_FORMAT_VERSION+1])('refuses header%s before any source mutation while preserving every body byte', async version => {
    const current = currentFixture(events), wrong = withVersion(current, version)
    expect(wrong).not.toBe(current)
    expect(bodyOf(wrong)).toBe(bodyOf(current))
    const { path, backend } = await store(wrong), calls = mutationCalls(backend), fetch = forbidExecution()
    const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
    try {
      const error = await coordinator.openManagedDocument('legacy').then(() => undefined, error => error)
      if (version === CURRENT_FORMAT_VERSION+1) {
        expect(error).toBeInstanceOf(SessionFormatUnsupportedError)
        expect(error.message).toMatch(new RegExp(`format version ${version}.*newer`, 'i'))
      } else {
        expect(error).toBeInstanceOf(TypeError)
        expect(error.message).toMatch(/^Invalid (result envelope|retained job result) or session format$/)
      }
      noMutations(calls)
      expect(await readFile(path, 'utf8')).toBe(wrong)
      expect(coordinator.ownerOf('legacy')).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    } finally { await coordinator.close() }
    noMutations(calls)
    expect(await readFile(path, 'utf8')).toBe(wrong)
  })
})
