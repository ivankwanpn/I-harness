import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { acquireAssemblyResultStore } from '../../session-executor/src/lifecycle/result-store.ts'
import { HarnessClient } from '../src/client.ts'
import { createExecFrameCapture } from '../../output-retention/src/result/exec-frames.ts'
import { committedFactSeqs } from '@i-harness/core-session'
import type { ChildProcess } from 'node:child_process'

it('reads original cold native frames viaCatalog through the real CLI and refuses an unconfirmed saved project', async () => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if (evidenceRoot && existsSync(join(evidenceRoot, 'evidence-seal.json'))) throw new Error('CLI evidence root is sealed; select a fresh IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT')
  if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true })
  const root = await mkdtemp(join(evidenceRoot ?? tmpdir(), 'result-cli-')), store = join(root, 'sessions'), config = join(root, 'config'), workspace = join(root, 'workspace')
  await mkdir(config); await mkdir(workspace); const settings = join(config, 'settings.json'); await writeFile(settings, '{}')
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(store), { lock: { enabled: true } }, taskDocumentStorageContract), refs: Record<string, any> = {}
  for (const id of ['unbound', 'bound']) {
    await coordinator.create({ sessionId: id }); await coordinator.flush(id)
    if (id === 'bound') await coordinator.putDocument('desktop-session-project-' + createHash('sha256').update(id).digest('hex'), { version: 1, projectId: 'p' })
    const lease = await acquireAssemblyResultStore({ workspace, coordinator, sessionId: id, contextOutputSettingsPath: settings, ...(id === 'bound' ? { projectContext: () => ({ id: 'p', roots: [workspace] }) } : {}) })
    const owner = lease.service!, scope = owner.registerResultScope({ operationId: id, sessionId: id, callId: 'c', source: await lease.sourceFor!(id) }, () => true)
    const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from(id + ' bytes'))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Original fixture refused')
    refs[id] = saved.ref; await lease.release()
  }
  // Cold transport/storage-owner control. The genuine native producer and
  // child-to-parent observer are qualified separately in session-executor.
  const lease = await acquireAssemblyResultStore({ workspace, coordinator, sessionId: 'unbound', contextOutputSettingsPath: settings })
  const owner = lease.service!, capturedSource = await lease.sourceFor!('unbound')
  const nativeScope = owner.registerResultScope({ operationId: 'cli-native-frame', sessionId: 'unbound', callId: 'cold-native', source: capturedSource }, () => true)
  const capture = createExecFrameCapture({ sourceId: 'cli-host-frame-source', openArtifact: () => owner.beginResult(nativeScope, 'exec-frames-v1') })
  const expectedStdout = Buffer.concat([Buffer.from([0, 255, 127]), Buffer.from('😀'), Buffer.alloc(12000, 97)]), expectedStderr = Buffer.from('CLI-end')
  await capture.write({ channel: 'stdout', frame: 0, offset: 0, end: true, bytes: expectedStdout })
  await capture.write({ channel: 'stderr', frame: 1, offset: 0, end: true, bytes: expectedStderr }); capture.complete('complete')
  const native = await capture.settle()
  if (native.kind !== 'ready' || native.dependency.retention.kind !== 'artifact') throw new Error('Original host-owned native frame fixture refused')
  const frame = native.dependency.retention.ref
  const catalogScope = owner.registerResultDependencyScope({ operationId: 'cli-native-catalog', sessionId: 'unbound', callId: 'cold-observe', source: capturedSource }, () => true, [native.dependency])
  const catalogSink = await owner.beginResult(catalogScope, 'json-utf8-v1')
  await catalogSink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries: [native.dependency] })))
  const catalog = await catalogSink.finish('complete'); if (catalog.kind !== 'committed') throw new Error('Original CLI catalog fixture refused')
  expect(await owner.settleResultDependencyMembership(catalogScope, catalog.ref)).toBe('ready')
  const unrelatedScope = owner.registerResultScope({ operationId: 'cli-unrelated-json', sessionId: 'unbound', callId: 'data-only', source: capturedSource }, () => true)
  const unrelatedSink = await owner.beginResult(unrelatedScope, 'json-utf8-v1'); await unrelatedSink.write(Buffer.from(JSON.stringify({ ref: frame, entries: [native.dependency] })))
  const unrelated = await unrelatedSink.finish('complete'); if (unrelated.kind !== 'committed') throw new Error('Original unrelated JSON fixture refused')
  const document = await coordinator.openManagedDocument('unbound'), action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  committedFactSeqs(await source.delivery.record({ type: 'subagent/end', version: 1, taskId: 'cli-cold-member', outcome: 'completed', resultRevision: 'cli-cold-member-v1', envelope: {
    version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, media: [], preview: '', retention: { kind: 'inline', value: 'cold-cli', encodedBytes: 10 }, dependencies: { kind: 'artifact-set', ref: catalog.ref, count: 1 },
  } }))
  committedFactSeqs(await source.delivery.record({ type: 'subagent/end', version: 1, taskId: 'cli-visible-data-only', outcome: 'completed', resultRevision: 'cli-visible-data-v1', envelope: {
    version: 1, execution: { outcome: 'succeeded', dispatch: 'not-dispatched' }, media: [], preview: '', retention: { kind: 'artifact', ref: unrelated.ref },
  } }))
  await source.close(); action.finish(); await document.close(); await lease.release()
  await coordinator.close()
  const repo = resolve(import.meta.dirname, '../../..'), loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href
  const client = HarnessClient.spawn({ command: process.execPath, args: ['--import', loader, join(repo, 'apps/cli/src/index.ts'), 'sdk', '--session-dir', store], cwd: workspace, env: { IH_CONFIG_DIR: config } })
  // Observe the original spawned handle without replacing transport/process
  // ownership or adding a production test-only accessor.
  const child = Reflect.get(client, 'child') as ChildProcess
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, signal) => done({ code, signal })))
  const pages: unknown[] = []
  try {
    const before = await Promise.all(['unbound', 'bound'].map(id => readFile(join(store, id + '.jsonl'))))
    expect((await client.initialize()).capabilities['session-result-read']).toEqual(['1', '2'])
    expect(await client.readResultPage('unbound', { ref: refs.unbound })).toMatchObject({ ref: refs.unbound, eof: true, data: { text: 'unbound bytes' } })
    expect(await client.readResultPage('bound', { ref: refs.bound })).toMatchObject({ kind: 'unavailable' })
    const stdout: Buffer[] = [], stderr: Buffer[] = [], endedFrames = new Set<number>(); let cursor: { recordOffset: number; sliceOffset: number } | undefined, previousFrame = -1
    for (;;) {
      const page = await client.readResultPage('unbound', { ref: frame, viaCatalog: catalog.ref, cursor, maxBytes: 4096 })
      if ('kind' in page || !('frames' in page)) throw new Error('Actual CLI witnessed native read refused: ' + JSON.stringify(page))
      expect(page.ref).toEqual(frame); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      pages.push(page)
      for (const part of page.frames) {
        expect([0, 1]).toContain(part.frame); expect(part.frame).toBeGreaterThanOrEqual(previousFrame)
        expect(endedFrames.has(part.frame)).toBe(false); previousFrame = part.frame
        expect(part.channel).toBe(part.frame === 0 ? 'stdout' : 'stderr')
        const parts = part.channel === 'stdout' ? stdout : stderr
        expect(part.offset).toBe(parts.reduce((sum, bytes) => sum + bytes.length, 0)); parts.push(Buffer.from(part.data, 'base64'))
        if (part.end) endedFrames.add(part.frame)
      }
      if (page.eof) break
      expect(page.nextCursor).not.toEqual(cursor); cursor = page.nextCursor!
    }
    expect(pages.length).toBeGreaterThan(1)
    expect([...endedFrames]).toEqual([0, 1])
    expect(Buffer.concat(stdout)).toEqual(expectedStdout); expect(Buffer.concat(stderr)).toEqual(expectedStderr)
    await expect(client.readResultPage('unbound', { ref: frame, viaCatalog: { ...catalog.ref, codec: 'text-utf8-v1' } })).rejects.toMatchObject({ code: -32602 })
    expect(await client.readResultPage('unbound', { ref: unrelated.ref })).toMatchObject({ ref: unrelated.ref, eof: true })
    expect(await client.readResultPage('unbound', { ref: frame, viaCatalog: unrelated.ref })).toMatchObject({ kind: 'unavailable' })
    expect(await Promise.all(['unbound', 'bound'].map(id => readFile(join(store, id + '.jsonl'))))).toEqual(before)
    expect(await readFile(settings, 'utf8')).toBe('{}')
    if (evidenceRoot) await writeFile(join(root, 'cli-witness-receipt.json'), JSON.stringify({ boundary: 'actual HarnessClient.spawn CLI cold transport plus original storage-owner scopes; not native-producer/full-Agent qualification', root, pid: child.pid, frame, catalog: catalog.ref, unrelated: unrelated.ref, capturedSource, catalogOperationId: catalogScope.operationId, pages, expectedStdoutSha256: createHash('sha256').update(expectedStdout).digest('hex'), expectedStderrSha256: createHash('sha256').update(expectedStderr).digest('hex'), sessionBytesUnchanged: true, malformedRpcCode: -32602, unrelatedWitnessDenied: true }, null, 2))
  } finally {
    await client.close()
    const nativeExit = await exited
    if (evidenceRoot) await writeFile(join(root, 'cleanup.json'), JSON.stringify({ originalCliProcess: child.pid, nativeExit, closed: true }))
    else await rm(root, { recursive: true, force: true })
    expect(nativeExit).toEqual({ code: 0, signal: null })
  }
}, 20000)
