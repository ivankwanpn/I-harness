import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { decodeFactBatch } from '@i-harness/core-session'
import { taskDocKey } from '@i-harness/subagent'
import { contextWorkspaceLocation } from '@i-harness/context-output'
import { createSessionService } from '../../src/service.ts'
import { createOpenAICompatibleClient } from '../../../llm-openai-compatible/src/index.ts'

const root = resolve(process.env.IH_FORMAT12_PRODUCER_ROOT ?? (() => { throw new Error('Fresh IH_FORMAT12_PRODUCER_ROOT required') })())
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const json = (name: string, value: unknown) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n')
function errorEvidence(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error)
  return { name: error.name, message: error.message, stack: error.stack, code: (error as any).code,
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(errorEvidence) } : {}),
    ...(error.cause ? { cause: errorEvidence(error.cause) } : {}) }
}

async function main() {
  await mkdir(root, { recursive: true })
  await json('original-process.json', { pid: process.pid, parentPid: process.ppid, node: process.version, cwd: process.cwd() })
  process.once('exit', code => writeFileSync(join(root, 'original-process-exit.json'), JSON.stringify({ pid: process.pid, code, time: new Date().toISOString() }) + '\n'))
  const nonce = randomUUID(), childPrompt = 'format12-original-child-' + nonce
  const resultText = ('original-c76-result/中文🙂/"\\/line\n').repeat(2304)
  const expectedBytes = Buffer.from(JSON.stringify({ resultText }))
  await writeFile(join(root, 'expected-body.json'), expectedBytes)
  const settings = join(root, 'settings.json')
  await json('settings.json', { contextSubsystems: { contextOutput: { enabled: false, maxDiskBytes: 16777216 } } })
  const sessions = join(root, 'sessions'), backend = createJsonlBackend(sessions)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const id = (await coordinator.create()).id
  const counters = { parentRequests: 0, childRequests: 0, spawnCalls: 0, admissionRefusals: 0 }
  const rejected: unknown[] = [], batches: unknown[] = [], cleanup: unknown[] = [], gates: unknown[] = []
  const endCommitted = Promise.withResolvers<void>()
  let endKey: unknown
  const append = backend.appendOwnedBatch!.bind(backend)
  backend.appendOwnedBatch = async (...args) => {
    const decoded = decodeFactBatch(args[3].bytes)
    if (args[0] === id && decoded.events.some(event => event.type === 'agent/input/admitted' && event.inputId.startsWith('parent-notify-'))) {
      counters.admissionRefusals++
      rejected.push({ key: args[3].key, events: decoded.events, originalBackendInvoked: false })
      return { kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' }
    }
    const outcome = await append(...args)
    batches.push({ sessionId: args[0], key: args[3].key, events: decoded.events, outcome })
    if (args[0] === id && outcome.kind === 'committed' && decoded.events.some(event => event.type === 'subagent/end')) {
      endKey = args[3].key
      gates.push({ phase: 'actual-native-end-committed', key: endKey })
      endCommitted.resolve()
    }
    return outcome
  }
  let spawned = false
  const providerRequests: unknown[] = []
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions')
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString())
      providerRequests.push({ messages: request.messages, model: request.model })
      const last = request.messages.at(-1)
      let delta: unknown
      if (last?.role === 'user' && JSON.stringify(last.content).includes(childPrompt)) {
        counters.childRequests++; delta = { content: resultText }
      } else {
        counters.parentRequests++
        if (!spawned) {
          spawned = true; counters.spawnCalls++
          delta = { tool_calls: [{ index: 0, id: 'format12-original-spawn', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ message: childPrompt, task_name: 'format12-original', background: true, fork_turns: 'none' }) } }] }
        } else delta = { content: 'parent finished original spawn' }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address(); assert(address && typeof address !== 'string')
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'format12-original', baseUrl: 'http://127.0.0.1:' + address.port })
  const service = createSessionService({ workspace: root, coordinator, contextOutputSettingsPath: settings, instructionSettingsPath: settings,
    approveAll: true, sandbox: 'danger-full-access', modelPolicy: 'required',
    sessionOperation: { assertOpen() {}, async run(targetId, operation) {
      if (targetId === id && operation.name === 'admission') {
        gates.push({ phase: 'original-notification-operation-held', operation: operation.name, targetId })
        await endCommitted.promise
        assert(endKey); gates.push({ phase: 'original-notification-operation-released', key: endKey })
      }
      return operation()
    } },
    modelBindingFor: async () => ({ status: 'ready', binding: { model, providerId: 'fixture', modelId: 'format12-original', label: 'fixture:format12-original', contextWindow: 1000000 } }),
  })
  let primary: unknown
  try {
    await service.submit(id, 'Spawn exactly one original bounded child fixture.', new AbortController().signal)
    const assembly = service.liveAssembly(id)!
    let taskDoc: any
    const deadline = Date.now() + 15000
    for (;;) {
      taskDoc = await coordinator.getDocument(taskDocKey(id))
      if (taskDoc?.tasks?.[0]?.result?.kind === 'retained' && taskDoc?.notifications?.[0]?.status === 'error' && assembly.session.events.some(event => event.type === 'subagent/end')) break
      if (Date.now() > deadline) throw new Error('Original old writer did not settle a retained end + error outbox: ' + JSON.stringify(taskDoc))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const task = taskDoc.tasks[0]
    assert.equal(taskDoc.tasks.length, 1); assert.equal(taskDoc.notifications.length, 1)
    assert.equal(task.status, 'completed'); assert.equal(task.result.envelope.retention.kind, 'artifact')
    assert.equal(task.delivery, 'parent'); assert.equal(counters.childRequests, 1); assert.equal(counters.spawnCalls, 1)
    const ends = assembly.session.events.filter(event => event.type === 'subagent/end')
    assert.equal(ends.length, 1); assert.equal(ends[0]!.taskId, task.id); assert.equal(ends[0]!.resultRevision, task.result.revision); assert.deepEqual(ends[0]!.envelope, task.result.envelope)
    const pages: any[] = [], parts: string[] = []
    let offset = 0
    for (;;) {
      const response = await assembly.tools.execute({ name: 'get_task_output', args: { task_ids: [task.id], body: true, result_revision: task.result.revision, ref_id: task.result.envelope.retention.ref.id, ref_revision: task.result.envelope.retention.ref.revision, offset_bytes: offset, max_output_bytes: 4096 } })
      const page = response.output as any
      if (page.data?.kind !== 'text') throw new Error('Original get_task_output did not return text page: ' + JSON.stringify(response))
      pages.push(page); parts.push(page.data.text)
      if (page.eof) break
      assert(page.nextOffset > offset); offset = page.nextOffset
    }
    const readback = Buffer.from(parts.join(''))
    assert(pages.length > 1); assert(readback.equals(expectedBytes))
    await writeFile(join(root, 'original-readback.json'), readback)
    await coordinator.flush(id)
    await json('original-task-document.json', taskDoc)
    await json('original-parent-events.json', assembly.session.events)
    await json('original-pages.json', pages)
    await json('original-provider-requests.json', providerRequests)
    await json('producer-observation.json', { nonce, predecessor: 'c76a56011e16057030c2fa7106d358b1eac99657', id, taskId: task.id, childSessionId: task.childSessionId, revision: task.result.revision, ref: task.result.envelope.retention.ref, expectedBytes: expectedBytes.length, expectedDigest: digest(expectedBytes), readbackDigest: digest(readback), pageCount: pages.length, counters, outbox: taskDoc.notifications, location: await contextWorkspaceLocation(root, sessions) })
  } catch (error) { primary = error; await json('primary-failure.json', { error: errorEvidence(error), counters }); throw error }
  finally {
    for (const [name, close] of [['service', () => service.close()], ['coordinator', () => coordinator.close()]] as const) {
      try { await close(); cleanup.push({ name, outcome: 'closed' }) } catch (error) { cleanup.push({ name, outcome: 'failed', error: errorEvidence(error) }) }
    }
    await json('original-native-batches.json', batches); await json('deliberately-unissued-notifications.json', rejected)
    await json('original-notification-gates.json', gates)
    await json('cleanup.json', { primary: primary ? String(primary) : null, outcomes: cleanup, counters })
    provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
    if (cleanup.some((entry: any) => entry.outcome === 'failed')) {
      await json('explicit-process-cut.json', { pid: process.pid, code: 73, reason: 'Original owner cleanup debt preserved; no notification reissue, repair, or replacement in this process', primary: primary ? errorEvidence(primary) : null })
      await new Promise<void>((resolve, reject) => process.send ? process.send({ type: 'original-process-cut', pid: process.pid, code: 73, primary: primary ? errorEvidence(primary) : null }, error => error ? reject(error) : resolve()) : resolve())
      process.exit(73)
    }
  }
}
await main()
