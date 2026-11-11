import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { registerExec } from '@i-harness/exec'
import { registerApprovalAnswerer } from '@i-harness/interaction'
import { createContextOutputService } from '@i-harness/context-output'
import { SHIPPING_REPORT_POLICY } from '@i-harness/subagent'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { acquireAssemblyResultStore } from '../src/lifecycle/result-store.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { createUnmanagedTaskChildHost } from '../src/lifecycle/task-child-host.ts'
import { createTaskResultRetention } from '../src/lifecycle/task-result-retention.ts'
import { createSessionService } from '../src/service.ts'

// Reuse the normal owned Code/Workflow and owned Task service compositions.
// Only the loopback model responses are controlled; Task admission stays real.
it('runs original Task spawn and followup through the mode-only Code broker without replay', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'owned-code-task-'))
  const backend = createJsonlBackend(join(root, 'sessions'))
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'parent' })
  const wire = (delta: unknown, finishReason: string) => 'data: ' + JSON.stringify({
    choices: [{ delta, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 2 },
  }) + '\n\ndata: [DONE]\n\n'
  const call = (code: string, id: string) => ({ tool_calls: [{ index: 0, id,
    function: { name: 'code_exec', arguments: JSON.stringify({ code, yield_time_ms: 60000 }) },
  }] })
  const childServer = await createLoopbackProvider('/v1/chat/completions', [
    async response => { response.end(wire({ content: 'original child result' }, 'stop')) },
    async response => { response.end(wire({ content: 'original followup result' }, 'stop')) },
  ])
  const child = createOpenAICompatibleClient({ apiKey: 'loopback', model: 'child', baseUrl: childServer.baseUrl })
  const server = await createLoopbackProvider('/v1/chat/completions', [
    async response => { response.end(wire(call('text(await tools.spawn_agent({message:"first",task_name:"probe",background:false}))', 'spawn-code'), 'tool_calls')) },
    async response => { response.end(wire({ content: 'spawn observed' }, 'stop')) },
    async response => { response.end(wire(call('text(await tools.followup_task({target:"root/probe",message:"second"}));text(await tools.wait_agent({target:"root/probe"}))', 'followup-code'), 'tool_calls')) },
    async response => { response.end(wire({ content: 'followup observed' }, 'stop')) },
  ])
  const taskOutput = createContextOutputService({ root: join(root, 'task-output'), workspaceId: 'code-task-fixture' })
  const service = createSessionService({
    workspace: root, coordinator, contextWindow: 32000, maxOutputTokens: 128,
    model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'parent', baseUrl: server.baseUrl }),
    resultReadScopeFor: async () => () => ({ revision: 'p', projectId: 'p', scope: { id: 'p', roots: [root] } }),
    managedRuntime: {
      systemPrompt: 'system', tools: [],
      mountRegistry({ ctx }) { registerApprovalAnswerer(ctx, async () => ({ approved: true })) },
      ownedCode: {
        config: { mode: 'only' },
        async acquireOutput(sessionId, retain) {
          let lease: Awaited<ReturnType<typeof acquireAssemblyResultStore>> | undefined
          let pending: ReturnType<typeof acquireAssemblyResultStore> | undefined
          retain(async () => {
            if (!lease && pending) {
              try { lease = await pending }
              catch (error) { await (error as { retryCleanup?: () => Promise<void> })?.retryCleanup?.(); return }
            }
            await lease?.release()
          })
          pending = acquireAssemblyResultStore({ workspace: root, coordinator, sessionId, projectContext: () => ({ id: 'p', roots: [root] }) })
          lease = await pending
          if (!lease.service || !lease.sourceFor) throw new Error('Original Code result owner unavailable')
          return { service: lease.service, sourceFor: lease.sourceFor }
        },
      },
      ownedTask: {
        async options(original) {
          const exec = registerExec(original.ctx)
          original.retain(() => exec.dispose())
          original.retain(() => taskOutput.close())
          return {
            parentModel: child, exec, resolveModel: async () => ({ status: 'unconfigured' as const, reason: 'unused' }),
            prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }),
            generationFactoryFor: (owner, id, selected) => (action, deps) => createGenerationLifecycle(owner.view, id, action, { enabled: false, selectedClient: selected }, deps),
            reportPolicy: SHIPPING_REPORT_POLICY, results: createTaskResultRetention(taskOutput, undefined, 'parent'),
            persist: { coordinator, stateId: 'parent', parentSessionId: 'parent' },
          }
        },
      },
    },
  })
  try {
    await service.submit('parent', 'spawn through Code', new AbortController().signal)
    expect(childServer.requests).toHaveLength(1)
    expect(JSON.stringify(server.requests[1]!.body)).toContain('original child result')
    await service.submit('parent', 'follow up through Code', new AbortController().signal)
    expect(childServer.requests).toHaveLength(2)
    expect(server.requests).toHaveLength(4)
    for (const request of server.requests) {
      const tools = request.body.tools as Array<{ function: { name: string } }>
      expect(tools.map(tool => tool.function.name)).toEqual(['code_exec', 'code_status', 'code_wait'])
    }
    await service.close()
    const ids = await coordinator.list()
    expect(ids).toHaveLength(2)
    const childId = ids.find(id => id !== 'parent')!
    const parentEvents = (await backend.read('parent')).events
    const childEvents = (await backend.read(childId)).events
    expect(parentEvents.filter(event => event.type === 'tool/call' && event.name !== 'code_exec')).toEqual([])
    for (const name of ['spawn_agent', 'followup_task', 'wait_agent']) {
      expect(parentEvents.filter(event => event.type === 'code/call' && event.name === name)).toHaveLength(1)
    }
    expect(parentEvents.filter(event => event.type === 'subagent/start')).toHaveLength(1)
    expect(childEvents.filter(event => event.type === 'turn/end')).toHaveLength(2)
    expect(childEvents.filter(event => event.type === 'assistant/message').map(event => event.text)).toEqual(['original child result', 'original followup result'])
    expect(childServer.requests).toHaveLength(2)
  } finally {
    await service.close()
    await coordinator.close()
    await server.close()
    await childServer.close()
  }
}, 180000)
