import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createResultCapture } from '../../output-retention/src/index.ts'
import { createFileBackedSessionQuery, closeSessionQueries } from '../../session-query/src/index.ts'
import { createTaskRegistry, type TaskResultStore } from '../src/index.ts'

it.each([
  ['completed', false], ['error', false], ['completed', true], ['error', true],
] as const)('searches both actual settled child previews with empty descriptor (outcome=%s, quota=%s)', async (outcome, quota) => {
  const root = await mkdtemp(join(tmpdir(), 'retained-child-search-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const store = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w', config: { enabled: false, ...(quota ? { maxDiskBytes: 1 } : {}) } })
  let captures = 0, reads = 0
  const results: TaskResultStore = {
    capture(task, body, revision, execution) {
      captures++
      const scope = store.registerResultScope({ operationId: revision, sessionId: 'parent', callId: task.id }, () => true)
      return createResultCapture(body, execution!, { forceArtifact: true, openArtifact: () => store.beginResult(scope, 'json-utf8-v1') })
    },
    read: (_task, ref, args) => { reads++; return store.readResult({ sessionId: 'parent' }, { ref, ...args }) },
  }
  try {
    await coordinator.create({ sessionId: 'parent' })
    const document = await coordinator.openManagedDocument('parent')
    const tasks = createTaskRegistry({ results })
    const task = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 1 }, agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' })
    tasks.claim(task.id)
    const body = { resultText: 'CHILD_RESULT_MARKER ' + 'result bytes '.repeat(2000) + 'ONLY_IN_CHILD_BODY', error: 'CHILD_ERROR_MARKER ' + 'error bytes '.repeat(2000) }
    tasks.terminalize({ taskId: task.id, outcome, ...body })
    await tasks.retainResult(task.id)
    if (task.result?.kind !== 'retained') throw new Error('Expected actual settled child result')
    expect(task.result.envelope.preview).toBe('')
    expect(task.result.envelope.retention.kind).toBe(quota ? 'unavailable' : 'artifact')
    expect(task.result.envelope.execution).toEqual({ outcome: outcome === 'completed' ? 'succeeded' : 'failed', dispatch: 'dispatched' })
    expect(task.resultText).toContain('CHILD_RESULT_MARKER')
    expect(task.error).toContain('CHILD_ERROR_MARKER')
    expect(Buffer.byteLength(JSON.stringify({ resultText: task.resultText, error: task.error }))).toBeLessThanOrEqual(2048)
    // Publish the original settled fields through the same managed F1 slot as
    // spawn's completion path; do not reconstruct the descriptor or its preview.
    const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
    const [seq] = committedFactSeqs(await source.delivery.record({ type: 'subagent/end', version: 1, taskId: task.id, outcome,
      envelope: task.result.envelope, resultRevision: task.result.revision, resultText: task.resultText, error: task.error }))
    await source.close(); action.finish()
    await coordinator.close()
    const file = join(root, 'parent.jsonl'), bytes = await readFile(file), before = await stat(file)
    expect(JSON.parse(bytes.toString().split('\n')[0]!).formatVersion).toBe(10)
    const query = createFileBackedSessionQuery({ storeRoot: root, dbPath: join(root, 'query.db') })
    const hits = await Promise.all(['CHILD_RESULT_MARKER', 'CHILD_ERROR_MARKER'].map(marker => query.search(marker)))
    for (const [index, marker] of ['CHILD_RESULT_MARKER', 'CHILD_ERROR_MARKER'].entries()) {
      expect(hits[index]).toEqual([expect.objectContaining({ sessionId: 'parent', seq, eventType: 'subagent/end', snippet: expect.stringContaining(marker) })])
    }
    expect(await query.search('ONLY_IN_CHILD_BODY')).toEqual([])
    if (task.result.envelope.retention.kind === 'artifact') expect(await query.search(task.result.envelope.retention.ref.id)).toEqual([])
    expect([captures, reads]).toEqual([1, 0])
    expect(await readFile(file)).toEqual(bytes)
    expect(await stat(file)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, ino: before.ino })
    if (!quota) {
      let offset = 0, encoded = ''
      for (;;) {
        const page = await tasks.readResult(task.id, { offset, maxBytes: 2048, revision: task.result.revision })
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2048)
        expect(page.resultRevision).toBe(task.result.revision)
        encoded += page.data.text
        if (page.eof) break
        expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset!
      }
      expect(JSON.parse(encoded)).toEqual(body)
      await expect(tasks.readResult(task.id, { revision: 'stale' })).rejects.toThrow(/revision/)
    } else await expect(tasks.readResult(task.id, {})).rejects.toThrow(/unavailable/)
    expect(captures).toBe(1)
  } finally { closeSessionQueries(); await coordinator.close(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
