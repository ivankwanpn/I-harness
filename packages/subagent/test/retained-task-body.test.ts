import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskRegistry, registerSubagent, SHIPPING_REPORT_POLICY } from '../src/index.ts'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSession } from '@i-harness/core-session'
import { createMockClient } from '@i-harness/llm-mock'
import { registerExec } from '@i-harness/exec'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createResultCapture } from '../../output-retention/src/index.ts'
import { taskBodyPreview } from '../src/task/result.ts'

it('keeps a Unicode boundary after preview escaping-budget reduction', () => {
  const full = 'a' + '😀'.repeat(500)
  const preview = taskBodyPreview({ resultText: full }).resultText!
  expect(preview.isWellFormed()).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(2048)
  expect(full.startsWith(preview)).toBe(true)
})

it('retains one exact normalized both-field child body and reads encoded pages bound to its original revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retained-child-body-'))
  const store = createContextOutputService({ root, workspaceId: 'w', config: { enabled: false } })
  let captures = 0
  const results = {
    capture(task: any, body: unknown, revision: string) {
      captures++
      const scope = store.registerResultScope({ operationId: revision, sessionId: 'parent', callId: task.id, documentId: 'task-parent' }, () => true)
      return createResultCapture(body, { outcome: 'succeeded', dispatch: 'dispatched' }, { forceArtifact: true, openArtifact: () => store.beginResult(scope, 'json-utf8-v1') })
    },
    read: (_task: any, ref: any, args: any) => store.readResult({ sessionId: 'parent' }, { ref, ...args }),
  }
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const sub = registerSubagent(ctx, tools, { parentSession: createSession(), parentModel: createMockClient([]), exec: registerExec(ctx), resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), reportPolicy: SHIPPING_REPORT_POLICY, results })
  const tasks = sub.tasks
  try {
    const body = { resultText: '中文🙂"\n'.repeat(12000), error: '' }
    const task = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 1 }, agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' })
    tasks.terminalize({ taskId: task.id, outcome: 'completed', ...body })
    await tasks.retainResult(task.id)
    const retained = tasks.get(task.id) as any
    expect(retained.result?.envelope.retention.kind).toBe('artifact')
    expect(Buffer.byteLength(JSON.stringify({ resultText: retained.resultText, error: retained.error }))).toBeLessThanOrEqual(2048)
    expect(Buffer.byteLength(tasks.notifications()[0]!.text)).toBeLessThanOrEqual(2048)
    let offset = 0, encoded = ''
    for (;;) {
      const page = await (tasks as any).readResult(task.id, { offset, maxBytes: 2048, revision: retained.result.revision })
      expect(page.codec).toBe('json-utf8-v1')
      expect(page.resultRevision).toBe(retained.result.revision)
      expect(page.ref.id).toBe(retained.result.envelope.retention.ref.id)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2048)
      expect(page).not.toHaveProperty('resultText')
      expect(page.data.text).not.toContain('�')
      encoded += page.data.text
      if (page.eof) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
    expect(JSON.parse(encoded)).toEqual(body)
    const summary = (await tools.execute({ name: 'get_task_output', args: { task_ids: [task.id] } })).output as any
    expect(summary.tasks[0].resultText.length).toBeLessThan(body.resultText.length)
    expect(summary.tasks[0].full_result.args.body).toBe(true)
    const full = summary.tasks[0].full_result
    const firstPage = (await tools.execute({ name: full.tool, args: { ...full.args, max_output_bytes: 2048 } })).output as any
    expect(firstPage.codec).toBe('json-utf8-v1')
    expect(firstPage).not.toHaveProperty('resultText')
    expect(Buffer.byteLength(JSON.stringify(firstPage))).toBeLessThanOrEqual(2048)
    const unsupported = (await tools.execute({ name: 'get_task_output', args: { task_ids: [task.id], field: 'error' } })).output as any
    expect(unsupported.error.code).toBe('unsupported-selector')
    expect(unsupported.full_result.args).toMatchObject({ body: true, result_revision: retained.result.revision })
    await expect((tasks as any).readResult(task.id, { revision: 'stale' })).rejects.toThrow(/revision/)
    const other = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 2 }, agentPath: 'root/b', description: 'b', prompt: 'go', agent: 'general', delivery: 'tool' })
    tasks.terminalize({ taskId: other.id, outcome: 'completed', ...body })
    await tasks.retainResult(other.id)
    expect((tasks.get(other.id) as any).result.revision).not.toBe(retained.result.revision)
    expect(captures).toBe(2)
  } finally { await sub.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

it('fences legacy/current/future task documents and never promotes a missing retained body to durable', () => {
  const row = { id: 'task-1', parentSessionId: 'p', agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'tool' as const, status: 'completed' as const, outcome: 'completed' as const, resultText: 'literal legacy full text', timeCreated: 1 }
  const legacy = createTaskRegistry({ reportPolicy: SHIPPING_REPORT_POLICY })
  legacy.restore({ formatVersion: 1, tasks: [{ ...row }], notifications: [] })
  expect(legacy.get(row.id)).toMatchObject({ retention: 'durable', resultText: row.resultText })
  const current = createTaskRegistry({ reportPolicy: SHIPPING_REPORT_POLICY })
  current.restore({ formatVersion: 2, tasks: [{ ...row, resultText: 'preview', result: { version: 1, kind: 'pending', revision: 'original' } }], notifications: [] })
  expect(current.get(row.id)?.retention).toBe('pending')
  expect(() => createTaskRegistry().restore({ formatVersion: 3, tasks: [], notifications: [] } as any)).toThrow(/version/)
  expect(() => createTaskRegistry().restore({ formatVersion: 1, tasks: [{ ...row, result: { version: 1, kind: 'pending', revision: 'forged' } }], notifications: [] })).toThrow(/legacy/)
})
