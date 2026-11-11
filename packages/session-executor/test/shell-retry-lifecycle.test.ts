import { expect, it, vi } from 'vitest'
const recoveryProbe=vi.hoisted(()=>({takes:[] as unknown[],handles:[] as object[],wrapped:new WeakSet<object>()}))
vi.mock('../../core-tools/src/registry/retained-outcome.ts',async load=>{
  const actual=await load<typeof import('../../core-tools/src/registry/retained-outcome.ts')>()
  return {...actual,retainedToolOutcome(...args:Parameters<typeof actual.retainedToolOutcome>){
    const outcome=actual.retainedToolOutcome(...args)
    if(outcome&&!recoveryProbe.wrapped.has(outcome)){
      recoveryProbe.wrapped.add(outcome);recoveryProbe.handles.push(outcome)
      const take=outcome.take
      outcome.take=async function(){const result=await take.call(this);recoveryProbe.takes.push(result);return result}
    }
    return outcome
  }}
})
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createContextOutputService } from '@i-harness/context-output'
import { subscribeManagedExecution } from '@i-harness/core-session/internal/execution'
import type { SessionEvent } from '@i-harness/core-session'
import { createRetryGuard } from '@i-harness/guard-retry'
import { createTimeoutGuard } from '@i-harness/guard-timeout'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createOwnedMetadataFold } from '../src/lifecycle/owned-metadata-fold.ts'
import { acquireAssemblyResultStore } from '../src/lifecycle/result-store.ts'
import { createSessionService } from '../src/service.ts'

it.each(['known', 'unknown', 'nested', 'second-unknown', 'failed-before-retry-body'] as const)('retries a managed Shell only after original cleanup ACK (%s)', async mode => {
  recoveryProbe.takes=[];recoveryProbe.handles=[];recoveryProbe.wrapped=new WeakSet()
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'shell-retry-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true }, originalExecutionFoldFactory: createOwnedMetadataFold }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'main' })
  const output = createContextOutputService({ root: join(root, 'results'), workspaceId: 'retry', config: { enabled: false } })
  let launches = 0, released = 0, cancelled = 0, allowCleanup = mode === 'known' || mode === 'nested' || mode === 'failed-before-retry-body'
  let revoke: (()=>void) | undefined
  const events: SessionEvent[] = []
  const native: TransportExecutionBackend = {
    async probe() { return { id: 'retry-native', availability: 'available', assurance: 'unverified', features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) {
      return { policy, async rollback() {}, async commit(check) {
        check()
        const attempt = ++launches
        if (attempt > 1) expect(released).toBe(attempt - 1)
        const done = Promise.withResolvers<void>()
        const lease = createExecutionLease({
          receipt: { executionId: 'retry-' + attempt, backendId: 'retry-native', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' },
          rootExited: done.promise.then(() => ({ exitCode: attempt === 1 ? null : 0 })),
          waitTreeEmpty: () => done.promise, settleIo: async () => {},
          async releaseResources() { if (!allowCleanup && (mode === 'unknown' || attempt === 2)) throw Error('Original native close is unknown'); released++;if(mode === 'failed-before-retry-body' && attempt === 1)revoke?.() },
          async terminate() { cancelled++; done.resolve() },
        })
        if (attempt > 1) done.resolve()
        return { ...lease, get settled() { return lease.settled }, pid: 1, io: {
          async write() {}, async endInput() {},
          output: (async function* () { yield { channel: 'stdout' as const, data: Buffer.from('attempt-' + attempt) }; await done.promise })(),
        } }
      } }
    },
  }
  const wire = (tool: boolean) => 'data: ' + JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'logical-call', type: 'function', function: { name: mode === 'nested' ? 'code_exec' : 'shell', arguments: JSON.stringify(mode === 'nested' ? { code: 'const r=await tools.shell({command:"controlled"});text(r.stdout)', yield_time_ms: 60000 } : { command: 'controlled' }) } }] } : { content: 'done' }, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n'
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(wire(true)) }, async response => { response.end(wire(false)) }])
  const service = createSessionService({ workspace: root, coordinator, resultReadScopeFor: async () => () => ({ revision: 'p', projectId: 'p', scope: { id: 'p', roots: [root] } }),
    managedRuntime: { systemPrompt: 'system', tools: [],
      ...(mode === 'nested' ? { ownedCode: { config: { mode: 'mixed' as const }, async acquireOutput() { throw Error('Shared Shell output required') } } } : {}),
      async mountRegistry(original) {
        original.ctx.mount(createRetryGuard(original.ctx, { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }))
        original.ctx.mount(createTimeoutGuard(original.ctx))
        const unsubscribe = subscribeManagedExecution(original.domain, event => events.push(event))
        original.retain(unsubscribe)
      },
      async mountDefaultSurface(original) {
        original.tools.get('shell')!.timeoutMs = 1000
        revoke=()=>{original.tools.unregister('shell')}
        return { systemPrompt: () => 'system', modelToolSchemas: () => original.tools.schemas(), modelOverheadTokens: () => 0, prepareInput: async text => text, reconcileAuthority: async () => {} }
      },
      ownedShell: { executionFor(id) { return { defaultOwner: { sessionId: id }, selectBackend: () => native, resolvePolicy: owner => compileExecutionPolicy({ mode: 'danger-full-access', owner, authority: { kind: 'unbound', revision: 'retry', workspaceRoot: root } }), validateAuthority() {} } },
        async acquireOutput(id, retain) {
          if (mode !== 'nested') { retain(() => output.close()); return { service: output } }
          let lease: Awaited<ReturnType<typeof acquireAssemblyResultStore>> | undefined
          const pending = acquireAssemblyResultStore({ workspace: root, coordinator, sessionId: id, projectContext: () => ({ id: 'p', roots: [root] }) })
          retain(async () => { lease ??= await pending; await lease.release() })
          lease = await pending
          if (!lease.service || !lease.sourceFor) throw Error('Original result owner unavailable')
          return { service: lease.service, sourceFor: lease.sourceFor }
        },
        agentShell: () => ({ id: 'controlled', label: 'controlled', command: 'controlled', dialect: 'posix' }),
      },
    }, model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl }), contextWindow: 4096, maxOutputTokens: 128,
  })
  try {
    const run = service.submit('main', 'run controlled', new AbortController().signal)
    if (mode === 'known' || mode === 'nested') {
      await run
      expect(launches).toBe(2)
      expect(released).toBe(2)
      expect(cancelled).toBe(1)
      expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
      if (mode === 'nested') {
        expect(events.filter(event => event.type === 'code/call' && event.name === 'shell')).toHaveLength(1)
        expect(events.filter(event => event.type === 'code/result' && event.name === 'shell')).toHaveLength(1)
      }
      expect(events.filter(event => event.type === 'agent/delivery-source' && event.kind === 'exec')).toHaveLength(2)
      const ends = events.filter(event => event.type === 'exec/end')
      expect(ends).toHaveLength(2)
      expect(ends.map(event => event.execution.outcome)).toEqual(['canceled', 'succeeded'])
      expect(new Set(ends.map(event => event.instanceId)).size).toBe(2)
    } else {
      await expect(run).rejects.toThrow()
      expect(launches).toBe(mode === 'second-unknown' ? 2 : 1)
      expect(released).toBe(mode === 'unknown' ? 0 : 1)
      expect(events.filter(event => event.type === 'agent/delivery-source' && event.kind === 'exec')).toHaveLength(launches)
      if(mode !== 'unknown') expect(recoveryProbe.takes).not.toEqual(expect.arrayContaining([expect.objectContaining({kind:'ready'})]))
      if(mode === 'failed-before-retry-body') {
        expect(recoveryProbe.handles).toHaveLength(0)
        const results=events.filter(event=>event.type==='tool/result')
        expect(results).toHaveLength(1)
        expect(results[0]!.envelope?.execution).toEqual({outcome:'canceled',dispatch:'dispatched'})
        expect(JSON.stringify(results[0])).not.toContain('attempt-1')
      } else if(mode === 'second-unknown') {
        for(const result of events.filter(event=>event.type==='tool/result')) {
          expect(result.envelope?.execution).toEqual({outcome:'unknown',dispatch:'dispatched'})
          expect(JSON.stringify(result)).not.toContain('attempt-1')
        }
      }
    }
  } finally {
    allowCleanup = true
    await service.close()
    await output.close()
    await coordinator.close()
    await server.close()
  }
}, 60000)
