import { expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { append, createSession, type ManagedArtifactRef, type ResultDependencyCatalog, type ExecFrameCursor } from '@i-harness/core-session'
import type { ResultPageQuery, ResultPageResult } from '@i-harness/context-output'
import { resolveShell } from '@i-harness/shell'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'

it('actual routed nested Gateway forks retain native catalog/member, managed and typed legacy bytes after cold source release', async () => {
  let modelCalls = 0, textEffects = 0, legacyId = '', command = ''
  const managedText = 'MANAGED_START' + 'x'.repeat(40000) + 'MANAGED_MIDDLE' + 'y'.repeat(40000)
  const model = controlledModel(async function* () {
    if (++modelCalls === 1) {
      yield { type: 'tool_call', call: { id: 'native-original', name: resolveShell().name, args: { command } } }
      yield { type: 'tool_call', call: { id: 'managed-original', name: 'managed_text', args: {} } }
    } else if (modelCalls === 3) {
      yield { type: 'tool_call', call: { id: 'cold-read', name: 'context_output_read', args: { refId: legacyId, maxBytes: 1024 } } }
      yield { type: 'tool_call', call: { id: 'cold-search', name: 'context_output_search', args: { query: 'VISIBLE', maxBytes: 1024 } } }
    } else yield { type: 'text/chunk', text: 'fixture done' }
    yield { type: 'end' }
  })
  const options = { model, shellRetention: { maxBytes: 1024 }, additionalTools: [{ name: 'managed_text', description: 'Actual retained fixture text', inputSchema: { type: 'object' }, isReadOnly: true, execute: async () => { textEffects++; return managedText } }] }
  let f = await createGatewayForkFixture(options)
  const effectPath = join(f.workspace, 'native-effects.log').replace(/\\/g, '/')
  command = `node -e "require('fs').appendFileSync('${effectPath}','once\\n');process.stdout.write('a'.repeat(40000)+'MIDDLE_STDOUT'+'b'.repeat(40000));process.stderr.write('c'.repeat(40000)+'MIDDLE_STDERR'+'d'.repeat(40000));process.exitCode=7"`
  const held = new AsyncLocalStorage<{ ids: Set<string>; active: boolean }>()
  let reentries = 0, snapshots = 0, captures = 0
  const observe = f.coordinator.withExistingSessionBindingObservation!.bind(f.coordinator)
  f.coordinator.withExistingSessionBindingObservation = (input, use) => observe(input, observation => {
    const scope = { ids: new Set(input.sessionIds), active: true }
    return held.run(scope, async () => { try { return await use(observation) } finally { scope.active = false } })
  })
  const profile = f.coordinator.profile.bind(f.coordinator), snapshot = f.coordinator.snapshot!.bind(f.coordinator)
  f.coordinator.profile = async id => { const scope = held.getStore(); if (scope?.active && scope.ids.has(id)) { reentries++; throw new Error('Held source profile recursion') } return profile(id) }
  f.coordinator.snapshot = async id => { const scope = held.getStore(); if (scope?.active && scope.ids.has(id)) { snapshots++; throw new Error('Held source snapshot fallback') } return snapshot(id) }
  const capture = f.coordinator.bootstrapSemanticTargetWithCapture!.bind(f.coordinator)
  f.coordinator.bootstrapSemanticTargetWithCapture = (input, guards, use) => capture(input, guards, async () => { captures++; return use() })
  const legacyCapture = vi.spyOn(f.runtime.contextOutput, 'capture')
  const readPage = async (sessionId: string, query: ResultPageQuery) => await f.call('session/result/read', { sessionId, ...query }) as ResultPageResult
  const textFor = async (sessionId: string, ref: ManagedArtifactRef) => {
    let offset = 0, text = ''
    for (;;) {
      const page = await readPage(sessionId, { ref, offset, maxBytes: 4096 })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      if (!('data' in page) || page.data.kind !== 'text') throw new Error('Actual retained text unavailable: ' + JSON.stringify(page))
      text += page.data.text
      if (page.eof) return text
      offset = page.nextOffset!
    }
  }
  const framesFor = async (sessionId: string, ref: ManagedArtifactRef, viaCatalog: ManagedArtifactRef) => {
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }, offsets = new Map<string, number>()
    let cursor: ExecFrameCursor | undefined
    for (;;) {
      const page = await readPage(sessionId, { ref, viaCatalog, ...(cursor ? { cursor } : {}), maxBytes: 4096 })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      if (!('frames' in page)) throw new Error('Actual native member unavailable: ' + JSON.stringify(page))
      for (const frame of page.frames) { const key = frame.channel + ':' + frame.frame; expect(frame.offset).toBe(offsets.get(key) ?? 0); const bytes = Buffer.from(frame.data, 'base64'); chunks[frame.channel].push(bytes); offsets.set(key, (offsets.get(key) ?? 0) + bytes.length) }
      if (page.eof) return { stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString() }
      if (!page.nextCursor) throw new Error('Actual native member cursor missing')
      cursor = page.nextCursor
    }
  }
  try {
    await f.runtime.contextOutput.configure({ enabled: true })
    await f.coordinator.create({ sessionId: 'creator' }); await f.projects.bind('creator', 'p')
    const foreignRoot = join(f.workspace, 'foreign'); await mkdir(foreignRoot)
    await f.projects.configure({ id: 'q', name: 'Foreign', roots: [foreignRoot], primaryRoot: foreignRoot }); await f.coordinator.create({ sessionId: 'foreign' }); await f.projects.bind('foreign', 'q')
    const publish = async (label: string, sessionId = 'creator') => {
      const ref = await f.runtime.contextOutput.capture({ sessionId, callId: label, label, text: label + ' retained text', complete: true, source: await f.runtime.sourceFor(sessionId) })
      if (!ref) throw new Error('Actual legacy publication refused')
      return ref
    }
    const visible = await publish('VISIBLE'), hidden = await publish('HIDDEN'), future = await publish('FUTURE'), foreign = await publish('FOREIGN', 'foreign')
    legacyId = visible.id
    for (const ref of [visible, hidden, future]) await f.runtime.contextOutput.grant({ sessionId: 'creator' }, [ref.id], 'source')
    const source = createSession()
    append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'selected' }); append(source, { type: 'context/result-ref', ref: visible }); append(source, { type: 'turn/end' })
    append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'hidden' }); append(source, { type: 'context/result-ref', ref: hidden }); append(source, { type: 'turn/end' })
    append(source, { type: 'rewind/point', version: 1, targetTurn: 2, anchorSeq: 4, mode: 'conversation', fileOps: [] })
    append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'current branch' }); append(source, { type: 'turn/end' })
    await f.coordinator.append('source', source.events)
    await f.call('session/prompt', { sessionId: 'source', prompt: 'Publish original managed text and native output once' })
    expect(modelCalls).toBe(2); expect(textEffects).toBe(1); expect((await readFile(effectPath, 'utf8')).trim().split(/\r?\n/)).toEqual(['once'])
    const actual = f.service.liveSession('source')!, shell = actual.events.find(event => event.type === 'tool/result' && event.callId === 'native-original'), text = actual.events.find(event => event.type === 'tool/result' && event.callId === 'managed-original')
    if (shell?.type !== 'tool/result' || !shell.envelope || shell.envelope.retention.kind !== 'inline' || text?.type !== 'tool/result' || text.envelope?.retention.kind !== 'artifact' || shell.envelope.dependencies?.kind !== 'artifact-set') throw new Error('Actual producer envelopes missing')
    expect(shell.envelope.retention.value).toMatchObject({ exitCode: 7 }); expect(shell.envelope.dependencies.count).toBe(1)
    const managed = text.envelope.retention.ref, catalogRef = shell.envelope.dependencies.ref
    const catalog = JSON.parse(await textFor('source', catalogRef)) as ResultDependencyCatalog
    expect(catalog).toMatchObject({ version: 1, kind: 'result-dependencies' }); expect(catalog.entries).toHaveLength(1)
    const member = catalog.entries[0]!.retention
    if (member.kind !== 'artifact') throw new Error('Actual canonical native member missing')
    expect(member.ref.codec).toBe('exec-frames-v1')
    const originalSourceBytes = await readFile(join(f.sessions, 'source.jsonl'))
    await f.runtime.contextOutput.configure({ enabled: false })
    const first = await f.prepare('source', 'child', 'nested-original')
    const before = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), originalTransfer = f.runtime.prepareBootstrapTransfer.bind(f.runtime)
    let paused = false
    const transfer = vi.spyOn(f.runtime, 'prepareBootstrapTransfer').mockImplementation((...args) => {
      const actual = originalTransfer(...args), confirm = actual.targetPreparation.confirm.bind(actual.targetPreparation)
      actual.targetPreparation.confirm = async (...args) => { if (!paused) { paused = true; before.resolve(); await release.promise } return confirm(...args) }
      return actual
    })
    const firstRun = f.execute(first); void firstRun.catch(() => {})
    try { await Promise.race([before.promise, firstRun.then(value => { throw new Error('Actual target confirmation did not enter: ' + JSON.stringify(value)) })]); expect(await readPage('child', { ref: managed })).toMatchObject({ kind: 'unavailable' }) }
    finally { release.resolve() }
    expect((await firstRun).kind).toBe('ready'); transfer.mockRestore()
    const second = await f.prepare('child', 'grandchild', 'nested-original-second')
    expect((await f.execute(second)).kind).toBe('ready')
    expect(captures).toBe(2); expect([modelCalls, textEffects, reentries, snapshots]).toEqual([2, 1, 0, 0])
    expect(f.service.hasAssembly('child')).toBe(false); expect(f.service.hasAssembly('grandchild')).toBe(false)
    expect(legacyCapture).toHaveBeenCalledTimes(4); expect(await readFile(join(f.sessions, 'source.jsonl'))).toEqual(originalSourceBytes)
    await expect(f.runtime.withLegacyReadObservation({ sessionId: 'grandchild' }, read => f.runtime.contextOutput.readLegacyObserved({ sessionId: 'grandchild' }, { refId: visible.id }, read))).rejects.toThrow(/disabled/)
    await f.runtime.contextOutput.configure({ enabled: true })
    const legacy = async () => f.runtime.withLegacyReadObservation({ sessionId: 'grandchild' }, async observation => {
      expect((await f.runtime.contextOutput.readLegacyObserved({ sessionId: 'grandchild' }, { refId: visible.id }, observation)).text).toBe('VISIBLE retained text')
      expect((await f.runtime.contextOutput.searchLegacyObserved({ sessionId: 'grandchild' }, { query: 'VISIBLE' }, observation)).hits.map(hit => hit.ref.id)).toEqual([visible.id])
      for (const ref of [hidden, future, foreign]) await expect(f.runtime.contextOutput.readLegacyObserved({ sessionId: 'grandchild' }, { refId: ref.id }, observation)).rejects.toThrow()
    })
    await legacy(); await expect(f.runtime.contextOutput.read({ sessionId: 'grandchild' }, { refId: visible.id })).rejects.toThrow()
    expect(await readPage('grandchild', { ref: member.ref })).toMatchObject({ kind: 'unavailable', reason: 'unauthorized' })
    for (const id of ['source', 'child', 'creator']) { await f.runtime.contextOutput.clear(id); await f.service.closeSession(id); await f.coordinator.closeManagedDocument(id); await f.coordinator.updateMeta(id, { archived: true }) }
    const root = f.root; await f.close(); f = await createGatewayForkFixture(options, root)
    await f.runtime.contextOutput.configure({ enabled: true })
    let coldSourceProfiles = 0
    const profile = f.coordinator.profile.bind(f.coordinator)
    f.coordinator.profile = async id => { if (['source', 'child', 'creator'].includes(id)) { coldSourceProfiles++; throw new Error('Cold ancestor profile forbidden') } return profile(id) }
    const coldCapture = vi.spyOn(f.runtime.contextOutput, 'capture')
    expect(JSON.parse(await textFor('grandchild', managed))).toBe(managedText)
    expect(JSON.parse(await textFor('grandchild', catalogRef))).toEqual(catalog)
    const native = await framesFor('grandchild', member.ref, catalogRef)
    expect(native.stdout).toBe('a'.repeat(40000) + 'MIDDLE_STDOUT' + 'b'.repeat(40000)); expect(native.stderr).toBe('c'.repeat(40000) + 'MIDDLE_STDERR' + 'd'.repeat(40000))
    expect(Buffer.byteLength(native.stdout)).toBe(80013); expect(Buffer.byteLength(native.stderr)).toBe(80013)
    await legacy()
    await f.call('session/prompt', { sessionId: 'grandchild', prompt: 'Read and search the retained original legacy result' })
    const toolResults = f.service.liveSession('grandchild')!.events.filter(event => event.type === 'tool/result')
    expect(JSON.stringify(toolResults.filter(event => event.callId === 'cold-read' || event.callId === 'cold-search'))).toContain('VISIBLE')
    const beforeRetry = modelCalls
    expect((await f.execute(second, 'retry')).kind).toBe('adopted')
    expect(modelCalls).toBe(beforeRetry); expect(coldSourceProfiles).toBe(0); expect(coldCapture).not.toHaveBeenCalled()
    expect((await readFile(effectPath, 'utf8')).trim().split(/\r?\n/)).toEqual(['once']); expect(textEffects).toBe(1)
    await writeFile(join(root, 'nested-receipts.json'), JSON.stringify({ root, first, second, captures, modelCalls, textEffects, reentries, snapshots, coldSourceProfiles, nativeBytes: { stdout: Buffer.byteLength(native.stdout), stderr: Buffer.byteLength(native.stderr) }, legacyResults: f.runtime.contextOutput.status().results }, null, 2))
    console.info(JSON.stringify({ control: 'actual Gateway nested retained results', root, captures, modelCalls, textEffects, reentries, snapshots, coldSourceProfiles, nativeBytes: { stdout: 80013, stderr: 80013 } }))
  } finally { await f.close() }
}, 30000)
