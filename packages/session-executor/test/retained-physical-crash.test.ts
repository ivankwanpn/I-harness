import { expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import type { Cut } from './helpers/retained-crash-faults.mts'
import type { Mode } from './helpers/retained-crash-fixture.mts'
import fs from 'node:fs/promises'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { readFactJournal, decodeFactBatch, type SessionEvent, type SessionEventView, type ManagedArtifactRef, type BatchKey } from '@i-harness/core-session'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../src/index.ts'
import { parseHeader } from '../../session-persistence-jsonl/src/format.ts'
import { artifactInventory, committedOperation, counters, digest, expectedBytes, fixtureTool, observeService, selectedResult } from './helpers/retained-crash-fixture.mts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const evidence = resolve(repository, '.tmp/context-r4a-physical-crash-20261021-implementation')
interface Receipt {
  nonce: string; id: string; mode: Mode; cut: Cut; kind: string
  elapsedMs: number
  counters: ReturnType<typeof counters>; fault: { factories: number; stages: number; installs: number; selectedInstalls: number; selectedObservations: number; installThrows: { sameOutcome: boolean; code?: string }[] }
  physical: { writes: number; writtenBytes: number; nativeSyncs: number; refusedRollbacks: number }
  issues: number; receipts: number; reconciles: number; observed: number; frame: string; frameDigest: string; key: BatchKey
  result: SessionEvent; ref: ManagedArtifactRef; nested?: { cellId: string; callId: string; parentCallId?: string }
  inventory: Awaited<ReturnType<typeof artifactInventory>>; operation: ReturnType<typeof committedOperation>
  outcomes?: { code?: string }[]
}

async function launch(mode: Mode, cut: Cut) {
  await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(evidence, `${mode}-${cut}-`)), id = 'retained-crash-owner', nonce = randomUUID()
  const config = join(root, 'config'); await mkdir(config); await writeFile(join(config, 'settings.json'), '{}\n')
  let requests = 0, explicit = false, errors = '', output = '', child: ChildProcess | undefined
  const unexpected: string[] = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      unexpected.push(`${request.method} ${request.url}`); response.writeHead(400).end(); return
    }
    request.resume(); request.on('end', () => {
      requests++
      if (requests > 1 && cut !== 'setup' && !explicit || requests > 2 && !explicit) {
        unexpected.push('unexpected model continuation before physical crash'); response.writeHead(409).end(); return
      }
      const delta = requests === 1 ? { tool_calls: [{ index: 0, id: 'fixture-original', type: 'function', function: {
        name: mode === 'normal' ? 'fixture_result' : 'code_exec', arguments: mode === 'normal' ? '{}' : JSON.stringify({ code: 'const value = await tools.fixture_result({}); text("guest-fulfilled");', yield_time_ms: 60000 }),
      } }] } : { content: 'new explicit input is usable' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  const endpoint = 'http://127.0.0.1:' + address.port
  child = spawn(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx',
    fileURLToPath(new URL('./helpers/crash-retained-result.mts', import.meta.url)), root, id, endpoint, cut, mode, nonce], {
    cwd: repository, windowsHide: true, env: { ...process.env, IH_CONFIG_DIR: config }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout!.on('data', chunk => { output += String(chunk) }); child.stderr!.on('data', chunk => { errors += String(chunk) })
  const messages: Receipt[] = [], waiters = new Set<() => void>()
  child.on('message', value => {
    const message = value as Receipt
    if (message.nonce !== nonce || message.id !== id || message.mode !== mode || message.cut !== cut) { unexpected.push('foreign IPC receipt'); return }
    messages.push(message); for (const notify of waiters) notify()
  })
  let closed = false
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child!.once('error', reject); child!.once('close', (code, signal) => { closed = true; resolve({ code, signal }); for (const notify of waiters) notify() })
  })
  async function message(kind: string) {
    const deadline = Date.now() + 30000
    while (true) {
      const found = messages.find(message => message.kind === kind)
      if (found) return found
      if (closed) throw new Error(`SETUP failure: child closed before ${kind}\n${output}\n${errors}`)
      if (Date.now() >= deadline) throw new Error(`SETUP/cut deadline before ${kind}\n${output}\n${errors}`)
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.min(100, deadline - Date.now()))
        function done() { clearTimeout(timer); waiters.delete(done); resolve() }
        waiters.add(done)
      })
    }
  }
  return { root, id, config, endpoint, messages, unexpected, close, message, get requests() { return requests }, admit() { explicit = true },
    async kill() { assert(!closed, 'child must remain alive at the cut'); assert(child!.kill('SIGKILL'), 'owned hard kill must succeed'); return close },
    async cleanup() {
      if (!closed) { assert(child!.kill('SIGKILL'), 'owned cleanup kill must succeed'); await close }
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
      await writeFile(join(root, 'process.json'), JSON.stringify({ messages, unexpected, output, errors, requests, close: await close }, null, 2))
    } }
}

it.each(['normal', 'code'] as const)('qualifies direct native mock+tsx and actual %s producer without a cut', async mode => {
  const fixture = await launch(mode, 'setup')
  try {
    const receipt = await fixture.message('setup')
    expect(receipt.counters).toMatchObject({ bodies: 1, getters: 1, hooks: 1, assemblies: 1, guestFulfilled: mode === 'code' ? 1 : 0 })
    expect(receipt).toMatchObject({ receipts: 1, reconciles: 0, observed: 1 })
    expect(receipt.operation.operations).toBe(mode === 'code' ? 3 : 1)
    if (mode === 'code') {
      const outputs = Object.entries(receipt.inventory.files)
        .filter(([path]) => path.endsWith('/operation.json') && !path.includes('/' + receipt.ref.id + '/'))
        .map(([path, file]) => ({ path, operation: JSON.parse(file.text!) as Receipt['operation']['selected']['operation'] }))
      const emitted = outputs.filter(output => output.operation.ref.codec === 'json-utf8-v1')
      const manifests = outputs.filter(output => output.operation.ref.codec === 'code-output-manifest-v1')
      expect(emitted).toHaveLength(1)
      expect(manifests).toHaveLength(1)
      expect(emitted[0]!.operation).toMatchObject({ phase: 'committed', owner: { sessionId: fixture.id, callId: receipt.nested!.cellId },
        ref: { encodedBytes: 17, contentDigest: digest(Buffer.from('"guest-fulfilled"')), codec: 'json-utf8-v1', completeness: 'complete' } })
      const manifest = manifests[0]!
      expect(manifest.operation).toMatchObject({ phase: 'committed', owner: { sessionId: fixture.id, callId: receipt.nested!.cellId },
        ref: { codec: 'code-output-manifest-v1', completeness: 'complete' } })
      const body = await readFile(join(receipt.inventory.location.serviceRoot, manifest.path.replace(/operation\.json$/, 'body')))
      expect(body.length).toBe(manifest.operation.ref.encodedBytes)
      expect(digest(body)).toBe(manifest.operation.ref.contentDigest)
      const records = body.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
      expect(records).toHaveLength(3)
      expect(records[0]).toEqual({ version: 1, kind: 'code-output', sessionId: fixture.id,
        cellId: receipt.nested!.cellId, sourceId: manifest.operation.owner.operationId })
      expect(records[1]).toMatchObject({ kind: 'output', ordinal: 0,
        item: { kind: 'text', retention: { kind: 'artifact', ref: emitted[0]!.operation.ref } } })
      expect(records[2]).toMatchObject({ kind: 'seal', status: 'completed', count: 1, accepted: 1, omitted: 0, truncated: false })
    }
    await fixture.message('closed'); expect(await fixture.close).toEqual({ code: 0, signal: null })
    expect(fixture.requests).toBe(2); expect(fixture.unexpected).toEqual([])
    expect((await readFile(join(fixture.root, 'effects.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
  } finally { await fixture.cleanup() }
}, 60000)

function journal(bytes: Buffer) {
  const headerBytes = bytes.indexOf(10) + 1
  assert(headerBytes > 0)
  const meta = parseHeader(bytes.subarray(0, headerBytes - 1).toString('utf8'))
  assert(meta.journal)
  const decoded = readFactJournal(bytes.subarray(headerBytes), meta.journal, meta.formatVersion, meta)
  const frames: { offset: number; bytes: Buffer; key: BatchKey }[] = []
  for (let offset = headerBytes + meta.journal.legacyBodyBytes + meta.journal.separatorBytes; offset < headerBytes + decoded.prefix.bodyBytes;) {
    const end = bytes.indexOf(10, offset) + 1
    const frame = bytes.subarray(offset, end)
    frames.push({ offset, bytes: frame, key: decodeFactBatch(frame).key }); offset = end
  }
  return { ...decoded, frames, headerBytes, validBytes: headerBytes + decoded.prefix.bodyBytes }
}

const cases = (['normal', 'code'] as const).flatMap(mode => (['before-issue', 'partial-unknown', 'complete-unknown', 'receipt-withheld', 'install'] as const).map(cut => ({ mode, cut })))
it.each(cases)('hard-kills actual $mode producer at $cut and recovers only original evidence', async ({ mode, cut }) => {
  const fixture = await launch(mode, cut)
  let coordinator: ReturnType<typeof createSessionCoordinator> | undefined, service: ReturnType<typeof createSessionService> | undefined
  let spy: { mockRestore(): void } | undefined
  const nativeFetch = globalThis.fetch
  try {
    const receipt = await fixture.message('cut')
    expect(receipt.counters).toEqual({ bodies: 1, getters: 1, hooks: 1, outerHooks: 0, assemblies: 1, guestFulfilled: 0 })
    expect(receipt.reconciles).toBe(0); expect(receipt.observed).toBe(0)
    expect(fixture.requests).toBe(1); expect(fixture.unexpected).toEqual([])
    expect(receipt.fault.factories).toBeGreaterThan(0)
    expect(receipt.ref).toMatchObject({ encodedBytes: expectedBytes.length, contentDigest: digest(expectedBytes), codec: 'json-utf8-v1', completeness: 'complete' })
    expect(receipt.operation.operations).toBe(1)
    assert(receipt.result.type === 'tool/result' || receipt.result.type === 'code/result')
    expect(receipt.operation.selected.operation.owner.callId).toBe(receipt.result.callId)
    const frame = Buffer.from(receipt.frame, 'base64')
    expect(digest(frame)).toBe(receipt.frameDigest)
    expect(decodeFactBatch(frame).key).toEqual(receipt.key)
    expect(decodeFactBatch(frame).events).toContainEqual(receipt.result)
    if (mode === 'code') {
      expect(receipt.nested).toMatchObject({ parentCallId: 'fixture-original' })
      expect(receipt.nested!.callId).not.toBe('fixture-original')
    }
    if (cut === 'before-issue') expect(receipt).toMatchObject({ issues: 0, receipts: 0, physical: { writes: 0, writtenBytes: 0 } })
    else if (cut === 'partial-unknown') expect(receipt).toMatchObject({ receipts: 0, outcome: { kind: 'unknown', key: receipt.key }, physical: { writes: 1, writtenBytes: 17, nativeSyncs: 1, refusedRollbacks: 1 } })
    else if (cut === 'complete-unknown') expect(receipt).toMatchObject({ receipts: 0, outcome: { kind: 'unknown', key: receipt.key }, physical: { writes: 1, writtenBytes: frame.length, nativeSyncs: 1, refusedRollbacks: 1 } })
    else expect(receipt).toMatchObject({ receipts: 1, outcome: { kind: 'committed', receipt: { key: receipt.key } }, physical: { writes: 1, writtenBytes: frame.length } })
    if (cut === 'install') {
      expect(receipt.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FACT_INSTALL_FAILED' })]))
      expect(receipt.fault.selectedInstalls).toBeGreaterThan(0); expect(receipt.fault.selectedObservations).toBe(0)
      expect(receipt.fault.installThrows.length).toBeGreaterThan(0)
      expect(receipt.fault.installThrows.every(row => row.sameOutcome && row.code === 'FACT_RECOVERY_REQUIRED')).toBe(true)
    } else expect(receipt.fault.selectedInstalls).toBe(0)
    const disposition = await fixture.kill()
    expect(disposition.code !== 0 || disposition.signal !== null).toBe(true)
    const sessionPath = join(fixture.root, 'sessions', fixture.id + '.jsonl')
    const before = await readFile(sessionPath), original = journal(before)
    await writeFile(join(fixture.root, 'session-before.bin'), before)
    expect(original.torn).toBe(cut === 'partial-unknown')
    const missing = cut === 'before-issue' || cut === 'partial-unknown', expectedOriginal = missing ? 0 : 1
    const physicalOriginal = (value: ReturnType<typeof journal>) => value.frames.filter(row => row.key.batchId === receipt.key.batchId)
    expect(physicalOriginal(original)).toHaveLength(expectedOriginal)
    if (!missing) expect(physicalOriginal(original)[0]!.bytes).toEqual(frame)
    if (cut === 'partial-unknown') expect(before.subarray(original.validBytes)).toEqual(frame.subarray(0, 17))
    const countOriginal = (events: readonly SessionEventView[]) => events.filter(event => {
      const selected = selectedResult([event], mode, receipt.nested)
      return selected && (selected.type === 'tool/result' || selected.type === 'code/result') && selected.envelope?.retention.kind === 'artifact'
    })
    expect(countOriginal(original.events)).toHaveLength(expectedOriginal)
    expect(original.events.filter(event => event.type === 'tool/dispatch' && event.callId === 'fixture-original')).toHaveLength(1)
    if (mode === 'code') {
      expect(original.events.filter(event => event.type === 'code/call' && event.cellId === receipt.nested!.cellId && event.callId === receipt.nested!.callId)).toHaveLength(1)
      expect(original.events.filter(event => event.type === 'code/cell' && event.cellId === receipt.nested!.cellId && event.parentCallId === 'fixture-original' && event.state === 'started')).toHaveLength(1)
    }
    const artifactBefore = await artifactInventory(fixture.root, join(fixture.root, 'sessions'))
    expect(artifactBefore).toEqual(receipt.inventory)
    expect(committedOperation(artifactBefore, receipt.ref, fixture.id)).toEqual(receipt.operation)
    const fresh = counters(), backend = createJsonlBackend(join(fixture.root, 'sessions'))
    coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
    globalThis.fetch = (async (url, init) => {
      if (String(url) !== fixture.endpoint + '/v1/chat/completions') throw new Error('Unexpected fresh-host network destination')
      return nativeFetch(url, init)
    }) as typeof fetch
    const createHost = () => {
      const host = createSessionService({ workspace: fixture.root, coordinator, contextOutputSettingsPath: join(fixture.config, 'settings.json'), approveAll: true,
        codeMode: { mode: mode === 'code' ? 'only' : 'off' }, model: createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: fixture.endpoint }), additionalTools: [fixtureTool(fixture.root, fresh)] })
      observeService(host, fresh); return host
    }
    service = createHost()
    const cold = await coordinator.snapshot!(fixture.id)
    expect(cold.session.events).toEqual(original.events)
    const nativeOpen = fs.open
    let bodyOpens = 0, metadataOpens = 0
    spy = vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).replaceAll('\\', '/').includes('/' + receipt.ref.id + '/body')) bodyOpens++
      else metadataOpens++
      return nativeOpen(...args)
    }) as typeof fs.open)
    syncBuiltinESMExports()
    const readAll = async () => {
      const chunks: Buffer[] = []
      let offset = 0
      do {
        const page = await service!.readResultPage!(fixture.id, { ref: receipt.ref, offset, maxBytes: 32768 })
        assert('data' in page && page.data.kind === 'text' && 'offset' in page, JSON.stringify(page))
        expect(page.offset).toBe(offset); expect(page.ref).toEqual(receipt.ref)
        const bytes = Buffer.from(page.data.text); expect(bytes.length).toBeLessThanOrEqual(32768); chunks.push(bytes)
        if (page.eof) { expect(page.nextOffset).toBeNull(); break }
        assert(typeof page.nextOffset === 'number' && page.nextOffset > offset); offset = page.nextOffset
      } while (true)
      const actual = Buffer.concat(chunks); expect(actual).toEqual(expectedBytes); expect(digest(actual)).toBe(receipt.ref.contentDigest)
    }
    await readAll(); expect(bodyOpens).toBeGreaterThan(0)
    await coordinator.create({ sessionId: 'unrelated-session' })
    const bodyBaseline = bodyOpens, metadataBaseline = metadataOpens
    expect(await service.readResultPage!('unrelated-session', { ref: receipt.ref })).toMatchObject({ kind: 'unavailable' })
    expect(bodyOpens).toBe(bodyBaseline); expect(metadataOpens).toBeGreaterThan(metadataBaseline)
    expect(await readFile(sessionPath)).toEqual(before)
    expect(await artifactInventory(fixture.root, join(fixture.root, 'sessions'))).toEqual(artifactBefore)
    expect(fresh).toEqual(counters()); expect(fixture.requests).toBe(1)
    await writeFile(join(fixture.root, 'cold-read.json'), JSON.stringify({ counters: fresh, bodyOpens, negativeBodyIncrement: bodyOpens - bodyBaseline, metadataOpens, requests: fixture.requests, artifactBefore, disposition }, null, 2))
    const owned = await coordinator.openManagedDocument(fixture.id)
    const after = await readFile(sessionPath), repaired = journal(after)
    await writeFile(join(fixture.root, 'session-repaired.bin'), after)
    expect(repaired.torn).toBe(false)
    expect(after.subarray(0, original.validBytes)).toEqual(before.subarray(0, original.validBytes))
    expect(countOriginal(owned.view.events)).toHaveLength(expectedOriginal)
    expect(physicalOriginal(repaired)).toHaveLength(expectedOriginal)
    if (!missing) {
      const durable = physicalOriginal(repaired)[0]!
      expect(durable.offset).toBe(physicalOriginal(original)[0]!.offset); expect(durable.bytes).toEqual(frame)
      expect(digest(durable.bytes)).toBe(receipt.frameDigest)
    }
    const recovery = owned.view.events.filter(event => event.type === 'tool/result' && event.callId === 'fixture-original' && !event.envelope)
    expect(recovery).toHaveLength(mode === 'code' || missing ? 1 : 0)
    if (recovery.length) expect(recovery[0]).toMatchObject({ type: 'tool/result', isError: true, output: { code: 'TOOL_OUTCOME_UNKNOWN', replay: false } })
    if (mode === 'code') expect(owned.view.events.filter(event => event.type === 'code/result' && event.cellId === receipt.nested!.cellId && event.callId === receipt.nested!.callId)).toHaveLength(expectedOriginal)
    expect(owned.view.events.filter(event => event.type === 'code/output')).toHaveLength(0)
    await coordinator.closeManagedDocument(fixture.id)
    const reopened = await coordinator.openManagedDocument(fixture.id)
    expect(reopened.view.events).toEqual(owned.view.events)
    expect(await readFile(sessionPath)).toEqual(after)
    await readAll()
    expect(fresh).toEqual(counters()); expect(fixture.requests).toBe(1)
    expect(await artifactInventory(fixture.root, join(fixture.root, 'sessions'))).toEqual(artifactBefore)
    fixture.admit()
    await service.submit(fixture.id, 'a new explicit human input after the physical crash', new AbortController().signal)
    expect(fixture.requests).toBe(2); expect(fixture.unexpected).toEqual([])
    expect(fresh).toEqual({ ...counters(), assemblies: 1 })
    expect((await readFile(join(fixture.root, 'effects.jsonl'), 'utf8')).trim().split('\n')).toEqual(['{"effect":"fixture_result"}'])
    const final = journal(await readFile(sessionPath))
    expect(countOriginal(final.events)).toHaveLength(expectedOriginal); expect(physicalOriginal(final)).toHaveLength(expectedOriginal)
    expect(final.events.filter(event => event.type === 'tool/result' && event.callId === 'fixture-original' && !event.envelope)).toEqual(recovery)
    expect(final.events.filter(event => event.type === 'code/output')).toHaveLength(0)
    expect(final.events.filter(event => event.type === 'assistant/message' && event.text === 'new explicit input is usable')).toHaveLength(1)
    if (mode === 'code') {
      expect(final.events.filter(event => event.type === 'code/result' && event.cellId === receipt.nested!.cellId && event.callId === receipt.nested!.callId)).toHaveLength(expectedOriginal)
      expect(final.events.filter(event => event.type === 'code/cell' && event.cellId === receipt.nested!.cellId && event.parentCallId === 'fixture-original' && event.state === 'interrupted')).toHaveLength(1)
    }
    expect(await artifactInventory(fixture.root, join(fixture.root, 'sessions'))).toEqual(artifactBefore)
    await writeFile(join(fixture.root, 'recovery.json'), JSON.stringify({ headerBytes: original.headerBytes, validPrefixBytes: original.validBytes,
      originalFrameCount: expectedOriginal, originalFrameOffsets: physicalOriginal(final).map(row => row.offset), recovery,
      appendedRecoveryEvents: repaired.events.slice(original.events.length), interruptedCells: final.events.filter(event => event.type === 'code/cell' && event.state === 'interrupted'),
      fresh, requests: fixture.requests, effectEntries: 1, operationInventory: artifactBefore, bodyOpens, metadataOpens }, null, 2))
  } finally {
    spy?.mockRestore(); syncBuiltinESMExports(); globalThis.fetch = nativeFetch
    try { await service?.close(); await coordinator?.close() } finally { await fixture.cleanup() }
  }
}, 60000)
