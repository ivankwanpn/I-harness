import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { SettingsStore } from '@i-harness/settings'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createInstructionEnvironment, createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'

it.each((['committed', 'absent'] as const).flatMap(disposition => [false, true].map(stop => ({ disposition, stop }))))('same real SessionService settles original $disposition before next main (Stop=$stop)', async ({ disposition, stop }) => {
  const root = await mkdtemp(join(tmpdir(), 'ih-runtime-resubmit-')), workspace = join(root, 'workspace'), profile = join(root, 'profile')
  await mkdir(workspace); await mkdir(profile); await writeFile(join(workspace, 'AGENTS.md'), 'FIRST_RUNTIME_SOURCE')
  const settingsPath = join(profile, 'settings.json'), saved = new SettingsStore({ path: settingsPath })
  await saved.load(); await saved.set({ instructions: { enabled: true, maxBytes: 24000, globalSources: [] } })
  let ready = false, key: BatchKey | undefined, originalIssues = 0, views = 0, absentWrites = 0
  const publications: { batchId: string; text: string }[] = []
  const managementEntered = Promise.withResolvers<void>(), managementRelease = Promise.withResolvers<void>()
  let holdManagement = false
  const backend = createJsonlBackend(join(root, 'sessions'), {
    wrapOwnedBatch: append => async (...args) => {
      const records = decodeFactBatch(args[3].bytes).events.filter(event => event.type === 'runtime/context')
      if (records.length) publications.push({ batchId: args[3].key.batchId, text: JSON.stringify(records) })
      if (!key && records.length) {
        key = args[3].key; originalIssues++
        if (disposition === 'committed') expect((await append(...args)).kind).toBe('committed')
        else {
          const probe = await open(join(root, 'sessions', args[0] + '.jsonl'), 'r+')
          const prototype = Object.getPrototypeOf(probe), write = prototype.write
          await probe.close()
          prototype.write = function(this: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number) {
            if (bytes === args[3].bytes) { absentWrites++; return write.call(this, bytes, offset, 0, position) }
            return write.call(this, bytes, offset, length, position)
          }
          try { expect((await append(...args)).kind).toBe('absent') }
          finally { prototype.write = write }
        }
        return { kind: 'unknown', key }
      }
      return append(...args)
    },
    wrapOwnedReconcile: reconcile => async (...args) => {
      if (key?.batchId === args[3].key.batchId) {
        if (!ready) return { kind: 'unknown', key: args[3].key }
        if (holdManagement) { managementEntered.resolve(); await managementRelease.promise }
      }
      return reconcile(...args)
    },
  })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const environment = createInstructionEnvironment({ settingsPath }), create = environment.host.create.bind(environment.host)
  environment.host.create = scope => { views++; return create(scope) }
  const bodies: string[] = [], server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; bodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const service = createSessionService({ workspace, coordinator, instructionEnvironment: environment, model: createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: `http://127.0.0.1:${address.port}` }), contextWindow: 100000, codeMode: { mode: 'off' } })
  const errorData = (error: unknown): unknown => error instanceof Error ? { name: error.name, message: error.message, code: (error as { code?: string }).code, stack: error.stack, ...(error.cause ? { cause: errorData(error.cause) } : {}), ...(error instanceof AggregateError ? { errors: error.errors.map(errorData) } : {}) } : error
  let primary: unknown
  try {
    await expect(service.submit(id, 'original human request', new AbortController().signal)).rejects.toThrow()
    expect([originalIssues, bodies.length, views]).toEqual([1, 0, 1])
    expect(absentWrites).toBe(disposition === 'absent' ? 1 : 0)
    for (let attempt = 0; attempt < 2; attempt++) {
      await saved.set({ instructions: { enabled: true, maxBytes: 24000 + attempt, globalSources: [] } })
      await expect(service.submit(id, `still unknown explicit request ${attempt}`, new AbortController().signal)).rejects.toThrow()
      expect([originalIssues, bodies.length, views, publications.length]).toEqual([1, 0, 1, 1])
    }
    const generation = environment.policy.current().generation
    await writeFile(join(workspace, 'AGENTS.md'), 'SECOND_RUNTIME_SOURCE')
    await saved.set({ instructions: { enabled: true, maxBytes: 24000, globalSources: [] } })
    await vi.waitFor(() => expect(environment.policy.current().generation).not.toBe(generation))
    await environment.policy.ready()
    holdManagement = stop
    ready = true
    // No test-side render/reconcile/close/reopen or substitute owner before
    // this real next submit crosses the shipping S2 recovery gate.
    const caller = new AbortController(), reason = Error('actual caller Stop during original publication management')
    const submitting = service.submit(id, 'next genuine human request', caller.signal)
    void submitting.catch(() => {})
    if (stop) { await managementEntered.promise; caller.abort(reason); holdManagement = false; managementRelease.resolve() }
    const result = await submitting.then(() => ({ kind: 'completed' as const }), error => ({ kind: 'failed' as const, error }))
    if (stop) {
      expect(result).toMatchObject({ kind: 'failed', error: { name: 'AbortError', code: 20 } }); expect(bodies).toEqual([])
      if (result.kind === 'failed') expect(result.error).toBeInstanceOf(DOMException)
      expect((await backend.read(id)).events.some(event => event.type === 'agent/input/admitted' && event.text === 'next genuine human request')).toBe(false)
      await service.submit(id, 'later genuine request after Stop', new AbortController().signal)
    }
    if (result.kind === 'failed' && !stop) console.log('original-publication-next-submit', JSON.stringify({ disposition, key, originalIssues, views, sends: bodies.length, error: errorData(result.error) }))
    if (!stop) expect(result).toMatchObject({ kind: 'completed' })
    expect(originalIssues).toBe(1); expect(bodies).toHaveLength(1)
    expect(bodies[0]!.split('SECOND_RUNTIME_SOURCE')).toHaveLength(2)
    expect(bodies[0]).not.toContain('FIRST_RUNTIME_SOURCE')
    expect(views).toBeLessThanOrEqual(2)
    expect(publications).toHaveLength(2)
    expect(publications[0]!.batchId).toBe(key!.batchId); expect(publications[1]!.batchId).not.toBe(key!.batchId)
    expect(publications[0]!.text).toContain('FIRST_RUNTIME_SOURCE'); expect(publications[1]!.text).toContain('SECOND_RUNTIME_SOURCE')
  } catch (error) { primary = error; throw error }
  finally {
    holdManagement = false; managementRelease.resolve()
    ready = true
    const cleanup = await service.close().then(() => undefined, error => error)
    if (cleanup !== undefined) console.log('original-publication-cleanup-held', JSON.stringify({ disposition, root, error: errorData(cleanup) }))
    else { await environment.close(); await coordinator.close(); rmWorkspaceSync(root) }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    if (primary === undefined && cleanup !== undefined) throw cleanup
  }
})
