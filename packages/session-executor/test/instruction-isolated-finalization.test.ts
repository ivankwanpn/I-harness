import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { decodeFactBatch } from '@i-harness/core-session'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createIsolatedReviewerPool } from '../../guard-approval/src/guardian/reviewer-pool.ts'
import type { GuardianReviewRecord } from '../../guard-approval/src/guardian/review-record.ts'
import { createSessionService } from '../src/index.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { rmWorkspaceSync } from './helpers.ts'

it.each(['stable', 'rules', 'policy', 'revoke', 'Stop', 'timeout', 'source-stable', 'source-policy', 'source-revoke', 'source-Stop', 'source-timeout'] as const)('arbitrates %s after physical end while original approval close is held', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-isolated-final-')), rules = join(root, 'AGENTS.md')
  await writeFile(rules, 'before')
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const environment = createProjectInstructionEnvironment(), current = environment.policy.current.bind(environment.policy)
  let epoch = '', revoked = false, commits = 0, closeAppends = 0
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), reviewed = Promise.withResolvers<GuardianReviewRecord>(), stop = new AbortController()
  const holdSource = mode.startsWith('source-'), callerStop = mode === 'Stop' || mode === 'source-Stop', timeout = mode === 'timeout' || mode === 'source-timeout'
  environment.policy.current = () => { const value = current(); return { ...value, generation: value.generation + epoch, ...(revoked ? { kind: 'unavailable' as const } : {}) } as ReturnType<typeof current> }
  const sources: Array<{ service: import('@i-harness/instructions').InstructionService; closes: number }> = [], create = environment.host.create.bind(environment.host)
  environment.host.create = scope => { const source = create(scope), close = source.close.bind(source), observed = { service: source, closes: 0 }; sources.push(observed); return { ...source, async close() { const originalClose = close(); if (holdSource) { entered.resolve(); await release.promise }; await originalClose; observed.closes++ } } }
  const answer = JSON.stringify({ outcome: 'approve', rationale: 'safe', risk_level: 'none' })
  const reviewerServer = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const mainServer = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write', function: { name: 'write', arguments: JSON.stringify({ path: join(root, 'out'), text: 'x' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`) }, async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = (url: string) => createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: url })
  const pool = createIsolatedReviewerPool(), acquire = pool.acquire.bind(pool)
  pool.acquire = key => { const lease = acquire(key); return lease && { ...lease, commit(prompt, response) { commits++; lease.commit(prompt, response) } } }
  const service = createSessionService({ workspace: root, coordinator, model: model(mainServer.baseUrl), instructionEnvironment: environment, approvalMode: 'ask-all', codeMode: { mode: 'off' }, guardian: { execution: 'isolated', model: model(reviewerServer.baseUrl), timeoutMs: timeout ? 500 : 5000, isolated: { pool, identity: () => ({ provider: 'fixture', model: 'fixture', protocol: 'http', configurationKey: 'fixture' }), permissionContext: () => 'fixture', onReview: record => { reviewed.resolve(record) } } } })
  let running: Promise<unknown> | undefined
  try {
    const assembly = await service.assemblyFor(id), append = backend.appendOwnedBatch!
    backend.appendOwnedBatch = async (...args) => {
      const facts = decodeFactBatch(args[3].bytes).events
      if (facts.some(event => event.type === 'context/action' && event.op === 'close' && assembly.session.events.some(open => open.type === 'context/action' && open.op === 'open' && open.purpose === 'approval' && open.actionId === event.actionId))) { closeAppends++; if (!holdSource) { entered.resolve(); await release.promise } }
      return append(...args)
    }
    running = service.submit(id, 'review a write', stop.signal); void running.catch(() => {})
    await entered.promise; const source = sources.at(-1)!
    expect(reviewerServer.requests).toHaveLength(1); expect(source.closes).toBe(0)
    if (mode === 'rules') { await writeFile(rules, 'after'); await vi.waitFor(() => expect(source.service.snapshot().complete).toBe(false)) }
    if (mode === 'policy' || mode === 'source-policy') epoch = ':changed'
    if (mode === 'revoke' || mode === 'source-revoke') revoked = true
    if (callerStop) stop.abort('caller Stop during original close')
    let record: GuardianReviewRecord
    if (callerStop || timeout) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { record = await Promise.race([reviewed.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('public reviewer did not respond while original close remained held')), 1500) })]) }
      finally { clearTimeout(timer) }
      expect(source.closes).toBe(0); expect(commits).toBe(0); release.resolve()
    } else { release.resolve(); record = await reviewed.promise }
    if (mode === 'stable' || mode === 'source-stable') { expect(record.reviewerOutcome).toBe('approve'); expect(commits).toBe(1) }
    else { expect(record.reviewerOutcome).not.toBe('approve'); expect(commits).toBe(0) }
    await running.catch(() => {}); await service.close().catch(() => {}); await service.close().catch(() => {})
    expect(source.closes).toBe(1); expect(closeAppends).toBe(1); expect(reviewerServer.requests).toHaveLength(1)
  } finally { release.resolve(); await running?.catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}); await reviewerServer.close(); await mainServer.close(); await environment.close(); rmWorkspaceSync(root) }
}, 15000)
