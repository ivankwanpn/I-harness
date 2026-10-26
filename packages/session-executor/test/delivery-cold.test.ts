import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readDeliveries } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService, createDurableSessionLoader } from '../src/index.ts'
import { produceFormat12RetainedResult } from './helpers/format12-retained-runtime.ts'
import { controlledModel } from './controlled-model.ts'

const cuts = ['before-first-receipt', 'end-landed-unknown', 'end-never-issued', 'end-absent-issued', 'end-torn', 'end-conflicted', 'receipt-landed-unknown', 'receipt-before-source-ack', 'scheduled-before-claim', 'claim-landed-unknown', 'close-before-issue', 'close-landed-unknown', 'close-confirmed'] as const
it.each(cuts)('cold original source qualifies from actual physical proof at %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-d1a-cold-')), config = join(root, 'config'), nonce = randomUUID()
  await mkdir(config)
  const requests: { model: string; messages: unknown }[] = [], delivery = Promise.withResolvers<void>()
  let parentCount = 0, childCount = 0, released = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const data = JSON.parse(body); requests.push(data)
      if (data.model === 'child') childCount++
      const first = data.model === 'parent' && ++parentCount === 1
      const delta = first ? { tool_calls: [{ index: 0, id: 'cold-original-spawn', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'original', agent_type: 'probe', message: 'return original', fork_turns: 'none' }) } }] }
        : { content: data.model === 'child' ? 'original child result' : 'parent completed' }
      if (data.model === 'parent' && JSON.stringify(data.messages).includes('<task_result>')) delivery.resolve()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server address unavailable')
  const endpoint = 'http://127.0.0.1:' + address.port
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/delivery-crash.mts', import.meta.url)), root, endpoint, nonce, mode], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, env: { ...process.env, IH_CONFIG_DIR: config }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = '', stderr = '', cut: any, recoveryError: unknown, retainedRead: unknown
  child.stdout!.on('data', value => { stdout += String(value) }); child.stderr!.on('data', value => { stderr += String(value) })
  child.on('message', value => { cut = value })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { released = true; resolve({ code, signal }) }) })
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const output = createContextOutputService({ root: join(root, 'results'), workspaceId: 'd1a-crash', config: { enabled: false } })
  let service: ReturnType<typeof createSessionService> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const exit = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Original cut not reached\n' + stderr)), 15000) })]); clearTimeout(timer)
    expect(exit).toEqual({ code: 0, signal: null })
    expect(cut).toMatchObject({ nonce, kind: mode })
    if (mode === 'scheduled-before-claim') {
      expect(cut.taskDocument.notifications).toEqual([expect.objectContaining({ status: 'delivered', timeDelivered: expect.any(Number) })])
      expect(cut.taskDocument.notifications[0]).not.toHaveProperty('timeWoken')
    }
    const raw = await readFile(join(root, 'sessions', 'parent.jsonl'))
    expect(createHash('sha256').update(raw).digest('hex')).toBe(cut.journalSha256)
    expect(raw.toString('base64')).toBe(cut.journalBase64)
    const missing = ['end-never-issued', 'end-absent-issued', 'end-torn', 'end-conflicted'].includes(mode)
    if (mode === 'end-never-issued') expect(cut.issuedEnd).toBe(0)
    else expect(cut.issuedEnd).toBe(1)
    if (mode === 'end-absent-issued') expect(cut).toMatchObject({ originalWriteAttempts: 1, observedOutcome: { kind: 'absent', key: cut.key } })
    expect(childCount).toBe(1)
    const beforeRequests = parentCount
    const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'parent', baseUrl: endpoint })
    service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutput: output,
      model, modelPolicy: 'test-mock', codeMode: { mode: 'off' }, sandbox: 'danger-full-access', contextWindow: 100000, approveAll: true })
    const published = await service.assemblyFor('parent').catch(error => { recoveryError = String(error); return undefined })
    if (mode === 'end-conflicted') {
      expect(published).toBeUndefined()
      expect(recoveryError).toBeDefined()
      expect(parentCount).toBe(beforeRequests)
      expect(childCount).toBe(1)
      expect(await readFile(join(root, 'sessions', 'parent.jsonl'))).toEqual(raw)
      return
    }
    expect(published).toBeDefined()
    const consumed = mode === 'claim-landed-unknown', fenced = ['close-landed-unknown', 'close-confirmed'].includes(mode)
    if (!missing && !consumed && !fenced) {
      await Promise.race([delivery.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cold published source never reached parent request')), 5000) })]); clearTimeout(timer)
    }
    await published!.drainParentNotifications?.()
    await published!.managedDocument?.settleFinishedActions()
    const events = (await backend.read('parent')).events
    expect(events.filter(e => e.type === 'subagent/end')).toHaveLength(missing ? 0 : 1)
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(missing ? 0 : 1)
    expect(events.filter(e => e.type === 'agent/input/admitted' && e.provenance?.producer === 'session.delivery.subagent')).toHaveLength(missing ? 0 : 1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(missing || fenced ? 0 : 1)
    expect(events.filter(e => e.type === 'agent/input/admitted' && e.intent === 'user')).toHaveLength(1)
    expect(childCount).toBe(1)
    expect(published!.session).toBe((await coordinator.openManagedDocument('parent')).view)
    if (missing || consumed || fenced) expect(parentCount).toBe(beforeRequests)
    else expect(parentCount).toBe(beforeRequests + 1)
    if (fenced) expect(readDeliveries(published!.session).activeGeneration()).toBeUndefined()
    if (mode === 'close-before-issue') {
      // The vanished synchronous fence has no durable close claim.
      expect(events.filter(e => e.type === 'agent/delivery-generation' && e.op === 'close')).toHaveLength(0)
    }
    const original = cut.taskDocument.tasks.find((task: any) => task.id === 'task-1')
    const restored = (await coordinator.getDocument('task-parent') as import('@i-harness/subagent').TaskProtocolDocument).tasks.find(task => task.id === 'task-1')!
    expect(restored.result?.revision).toBe(original.result.revision)
    expect(restored.result?.kind).toBe('retained')
    if (restored.result?.kind === 'retained') expect(restored.result.envelope.retention).toEqual(original.result.envelope.retention)
    if (missing) {
      // Qualification is derived live state; the saved completed observation
      // remains intact instead of gaining a new TaskDoc trust certificate.
      expect(published!.tasks()).toContainEqual(expect.objectContaining({ id: 'task-1', status: 'failed', summary: 'recovery required' }))
    }
    // Read the actual retained body, using the unchanged original revision/ref.
    // Default get_task_output presentation is not byte-read evidence.
    const ref = original.result.envelope.retention.ref
    let response: Awaited<ReturnType<NonNullable<typeof published>['tools']['execute']>> | undefined, readError: unknown
    try { response = await published!.tools.execute({ name: 'get_task_output', args: { task_ids: ['task-1'], body: true, result_revision: original.result.revision, ref_id: ref.id, ref_revision: ref.revision, offset_bytes: 0, max_output_bytes: 4096 } }) }
    catch (error) { readError = error; retainedRead = { error: String(error) } }
    if (readError) {
      expect(missing).toBe(true)
      expect(String(readError)).toMatch(/recovery.required|unavailable/i)
    } else {
      retainedRead = response!.output
      const page = response!.output as { data?: { kind: string; text: string }; resultRevision: string; ref: unknown; eof: boolean }
      if (page.data?.kind === 'text') {
        expect(page.resultRevision).toBe(original.result.revision); expect(page.ref).toEqual(ref); expect(page.eof).toBe(true)
        const bytes = Buffer.from(page.data.text)
        expect(bytes).toEqual(Buffer.from(JSON.stringify({ resultText: 'original child result' })))
        await writeFile(join(root, 'retained-readback.json'), bytes)
      } else {
        expect(missing).toBe(true)
        expect(JSON.stringify(response!.output)).toMatch(/recovery.required|unavailable/i)
      }
    }
    const afterRead = (await backend.read('parent')).events
    expect(afterRead.filter(e => e.type === 'subagent/end')).toHaveLength(missing ? 0 : 1)
    expect(afterRead.filter(e => e.type === 'agent/delivery-received')).toHaveLength(missing ? 0 : 1)
    expect(afterRead.filter(e => e.type === 'agent/input/admitted' && e.intent === 'user')).toHaveLength(1)
    expect(childCount).toBe(1)
  } finally {
    clearTimeout(timer)
    if (!released) { child.kill(); await exited }
    const cleanup: unknown[] = []
    for (const close of [() => service?.close(), () => coordinator.close(), () => output.close()]) try { await close() } catch (e) { cleanup.push(String(e)) }
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (process.env.IH_DELIVERY_EVIDENCE_ROOT) {
      await mkdir(process.env.IH_DELIVERY_EVIDENCE_ROOT, { recursive: true })
      await writeFile(join(process.env.IH_DELIVERY_EVIDENCE_ROOT, 'cold-' + mode + '.json'), JSON.stringify({ root, nonce, mode, cut, cutFile: await readFile(join(root, 'cut.json'), 'utf8').catch(() => undefined), stdout, stderr, cleanup, recoveryError, retainedRead, exit: await exited, requests, childCount, parentCount }, null, 2))
    }
    expect(cleanup).toEqual([])
  }
}, 25000)

it('genuine original format12 retained task remains fully readable in its same root without automatic delivery authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih3-o02-'))
  let produced: Awaited<ReturnType<typeof produceFormat12RetainedResult>> | undefined
  let service: ReturnType<typeof createSessionService> | undefined, coordinator: ReturnType<typeof createSessionCoordinator> | undefined
  let requests = 0, failure: unknown
  const cleanup: string[] = [], pages: { offset: number; nextOffset: number | null; eof: boolean; bytes: number }[] = []
  try {
    produced = await produceFormat12RetainedResult({ root, dependencyRoot: fileURLToPath(new URL('../../../', import.meta.url)), runtimeParent: join(tmpdir(), 'ih3-o02rt-' + randomUUID().slice(0, 8)) })
    const id = produced.sessionId, backend = createJsonlBackend(join(root, 'sessions'))
    const before = await readFile(join(root, 'sessions', id + '.jsonl')), newline = before.indexOf(10)
    expect(JSON.parse(before.subarray(0, newline).toString()).formatVersion).toBe(12)
    coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
    service = createSessionService({ workspace: root, coordinator, contextOutputSettingsPath: join(root, 'settings.json'), instructionSettingsPath: join(root, 'settings.json'),
      model: controlledModel(async function* () { requests++; yield { type: 'end' } }), modelPolicy: 'test-mock', contextWindow: 1000000, codeMode: { mode: 'off' }, sandbox: 'danger-full-access', approveAll: true })
    const assembly = await service.assemblyFor(id)
    await assembly.drainParentNotifications?.()
    expect(requests).toBe(0)
    expect(assembly.session.events.some(e => e.type.startsWith('agent/delivery-'))).toBe(false)
    expect(assembly.inbox.pending()).toEqual([])
    const parts: string[] = []
    let offset = 0
    for (;;) {
      const response = await assembly.tools.execute({ name: 'get_task_output', args: { task_ids: [produced.taskId], body: true, result_revision: produced.resultRevision, ref_id: produced.ref.id, ref_revision: produced.ref.revision, offset_bytes: offset, max_output_bytes: 4096 } })
      const page = response.output as { data?: { kind: string; text: string }; offset: number; nextOffset: number | null; eof: boolean; resultRevision: string; ref: unknown }
      expect(page.data?.kind).toBe('text')
      expect(page.resultRevision).toBe(produced.resultRevision); expect(page.ref).toEqual(produced.ref)
      expect(page.offset).toBe(offset)
      parts.push(page.data!.text); pages.push({ offset: page.offset, nextOffset: page.nextOffset, eof: page.eof, bytes: Buffer.byteLength(page.data!.text) })
      if (page.eof) break
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset!
    }
    const readback = Buffer.from(parts.join(''))
    expect(pages.length).toBeGreaterThan(1)
    expect(readback).toEqual(produced.expectedBody)
    expect(createHash('sha256').update(readback).digest('hex')).toBe('21779f96fe93d10ccd48e47f8fc2418d75389ea354b2b6dee8d2193a94986f84')
    await writeFile(join(root, 'current-readback.json'), readback)
    const taskDoc = await coordinator.getDocument('task-' + id) as import('@i-harness/subagent').TaskProtocolDocument
    expect(taskDoc.tasks.find(task => task.id === produced!.taskId)?.result).toMatchObject({ kind: 'retained', revision: produced.resultRevision, envelope: { retention: { kind: 'artifact', ref: produced.ref } } })
    expect(JSON.stringify(taskDoc)).not.toMatch(/generationId|sourceSeq|terminalSeq|receiverClaim/)
    expect(requests).toBe(0)
    expect(assembly.session.events.filter(e => e.type === 'subagent/end')).toHaveLength(1)
    expect(assembly.session.events.filter(e => e.type === 'agent/delivery-received' || e.type === 'agent/input/admitted' && e.intent === 'system')).toHaveLength(0)
    const after = await readFile(join(root, 'sessions', id + '.jsonl')), afterNewline = after.indexOf(10)
    expect(JSON.parse(after.subarray(0, afterNewline).toString()).formatVersion).toBe(13)
    expect(after.subarray(afterNewline + 1, afterNewline + 1 + before.length - newline - 1)).toEqual(before.subarray(newline + 1))
  } catch (error) { failure = error; throw error }
  finally {
    for (const close of [() => service?.close(), () => coordinator?.close()]) try { await close() } catch (error) { cleanup.push(String(error)) }
    if (process.env.IH_DELIVERY_EVIDENCE_ROOT) {
      await mkdir(process.env.IH_DELIVERY_EVIDENCE_ROOT, { recursive: true })
      await writeFile(join(process.env.IH_DELIVERY_EVIDENCE_ROOT, 'genuine12-current-read.json'), JSON.stringify({ root, runtimeRoot: produced?.runtimeRoot, sessionId: produced?.sessionId, taskId: produced?.taskId, revision: produced?.resultRevision, ref: produced?.ref, originalObservation: produced?.observation, originalProcess: produced?.process, postCloseOriginal: produced?.postCloseVerification, pages, requests, cleanup, failure: String(failure) }, null, 2))
    }
    expect(cleanup).toEqual([])
  }
}, 60000)
