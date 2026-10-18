import { controlledModel } from '../../../packages/session-executor/test/controlled-model.ts'
import { expect, it } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHeadless } from '../src/run.ts'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'

it('threads the original CLI action signal through auto-title preparation and refuses its late send after Stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-cli-title-')), config = join(root, 'config')
  await mkdir(config)
  const previous = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = config
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create(), controller = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let main = 0, titleSends = 0
  const running = runHeadless('original CLI prompt', { workspace: root, sessionId: id, coordinator, signal: controller.signal, model: controlledModel(request => ({ async *stream(request) {
    if (request.systemPrompt.includes('You produce ONLY a short session title')) {
      entered.resolve(); await release.promise
      request.signal?.throwIfAborted(); request.validateBeforeTransport?.()
      titleSends++
      yield { type: 'text/chunk', text: 'late title' }
    } else { main++; yield { type: 'text/chunk', text: 'original answer' } }
    yield { type: 'end' }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
  void running.catch(() => {})
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('CLI completed without actual title preparation') })])
    controller.abort(new Error('Stop during CLI title preparation'))
    release.resolve()
    const result = await running
    expect(result.exitCode).toBe(1)
    expect([main, titleSends]).toEqual([1, 0])
    if (!result.session) throw new Error('Actual CLI title control must retain its original Session')
    expect(result.session.events.some(event => event.type === 'session/title')).toBe(false)
  } finally {
    release.resolve(); await running.catch(() => {}); await coordinator.close().catch(() => {})
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
  }
})
