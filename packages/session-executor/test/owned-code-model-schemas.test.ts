import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import type { LLMRequest } from '@i-harness/llm-seam'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { acquireAssemblyResultStore } from '../src/lifecycle/result-store.ts'
import { createSessionService } from '../src/service.ts'
import { controlledModel } from './controlled-model.ts'

it.each(['off', 'mixed', 'only'] as const)('uses owned Code %s schemas without a host default surface', async mode => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'code-model-schemas-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'main' })
  const requests: LLMRequest[] = []
  const model = controlledModel(async function* (request) {
    requests.push(request)
    yield { type: 'text/chunk', text: 'observed' }
    yield { type: 'end' }
  })
  let contextWindow = 16000
  const service = createSessionService({
    workspace: root, coordinator,
    modelBindingFor: async () => ({ status: 'ready', binding: {
      providerId: 'fixture', modelId: 'schemas', label: 'Schemas', protocol: 'openai-chat',
      model, contextWindow, maxOutputTokens: 128,
    } }),
    managedRuntime: {
      systemPrompt: 'system',
      tools: [{ name: 'visible_probe', description: 'Direct tool control', inputSchema: { type: 'object' }, isReadOnly: true, async execute() { return 'probe' } }],
      ownedCode: {
        config: { mode },
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
          if (!lease.service || !lease.sourceFor) throw new Error('Original Code output owner unavailable')
          return { service: lease.service, sourceFor: lease.sourceFor }
        },
      },
    },
  })
  try {
    await service.submit('main', 'inspect first model surface', new AbortController().signal)
    contextWindow = 32000
    await service.submit('main', 'inspect rebound model surface', new AbortController().signal)
    expect(requests).toHaveLength(2)
    const names = requests.map(request => request.tools.map(tool => tool.name))
    expect(names[1]).toEqual(names[0])
    for (const visible of names) {
      if (mode === 'only') expect(visible).toEqual(['code_exec', 'code_status', 'code_wait'])
      else {
        expect(visible).toContain('visible_probe')
        for (const name of ['code_exec', 'code_status', 'code_wait']) {
          if (mode === 'mixed') expect(visible).toContain(name)
          else expect(visible).not.toContain(name)
        }
      }
    }
  } finally {
    await service.close()
    await coordinator.close()
  }
}, 30000)
