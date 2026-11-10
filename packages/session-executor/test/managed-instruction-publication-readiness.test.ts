import { expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { InstructionService } from '@i-harness/instructions'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createSessionService } from '../src/service.ts'
import { createInstructionEnvironment, createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { controlledModel } from './controlled-model.ts'
import { createOwnedMetadataFold } from '../src/lifecycle/owned-metadata-fold.ts'

it.each([
  ['legacy', 'dirty'], ['managed', 'dirty'],
  ['legacy', 'authority'], ['managed', 'authority'],
  ['legacy', 'content'], ['managed', 'content'],
  ['legacy', 'perpetual'], ['managed', 'perpetual'],
  ['legacy', 'policy'], ['managed', 'policy'],
] as const)('handles original publication changes before model issue: %s / %s', async (mode, change) => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!
  const root = await mkdtemp(join(evidenceRoot, 'instruction-publish-ready-'))
  await writeFile(join(root, 'AGENTS.md'), 'CURRENT_INSTRUCTION_BODY')
  const settingsPath = join(root, 'settings.json')
  if (change === 'policy') await writeFile(settingsPath, JSON.stringify({ instructions: { enabled: true, maxBytes: 24000 } }))
  const environment = change === 'policy' ? createInstructionEnvironment({ settingsPath }) : createProjectInstructionEnvironment()
  const views: InstructionService[] = [], bodies: string[] = []
  let preparations = 0
  const create = environment.host.create.bind(environment.host)
  environment.host.create = scope => {
    const view = create(scope), prepare = view.prepare.bind(view)
    const observed: InstructionService = { ...view, async prepare(targets) {
      const snapshot = await prepare(targets)
      preparations++
      if (change === 'perpetual') view.invalidate([join(root, 'AGENTS.md')])
      return snapshot
    } }
    views.push(observed); return observed
  }
  let invalidated = false, requests = 0
  let authority = { kind: 'unbound' as const, revision: '1', workspaceRoot: root }
  const backend = createJsonlBackend(root, {
    wrapOwnedBatch(original) {
      return async (...args) => {
        const outcome = await original(...args)
        if (!invalidated && outcome.kind === 'committed' && Buffer.from(args[3].bytes).includes(Buffer.from('"type":"runtime/context"'))) {
          invalidated = true
          if (change === 'authority') authority = { ...authority, revision: '2' }
          else if (change === 'policy') {
            const changed = Promise.withResolvers<void>(), generation = environment.policy.current().generation
            const off = environment.policy.subscribe(() => { if (environment.policy.current().generation !== generation) changed.resolve() })
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await writeFile(settingsPath, JSON.stringify({ instructions: { enabled: false, maxBytes: 24000 } }))
              await Promise.race([changed.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Original policy watcher did not revoke its generation')), 5000) })])
            } finally { off(); clearTimeout(timer) }
          } else {
            if (change === 'content') await writeFile(join(root, 'AGENTS.md'), 'UPDATED_INSTRUCTION_BODY')
            views.at(-1)!.invalidate([join(root, 'AGENTS.md')])
          }
        }
        return outcome
      }
    },
  })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true }, ...mode === 'managed' ? { originalExecutionFoldFactory: createOwnedMetadataFold } : {} }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'main' })
  const service = createSessionService({ workspace: root, coordinator,
    ...mode === 'legacy' ? { instructionEnvironment: environment, executionAuthorityFor: async () => () => authority } : {},
    managedRuntime: { systemPrompt: 'system', tools: [], ...mode === 'managed' ? {
      async acquireInstructions() { return { environment, cwd: root, authority: () => authority, available: () => true } },
    } : {} }, contextWindow: 32000, maxOutputTokens: 128,
    model: controlledModel(async function* (request) { requests++; bodies.push(JSON.stringify(request)); yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' } }),
  })
  try {
    const turn = service.submit('main', 'normal managed request', new AbortController().signal)
    const refused = change === 'authority' || change === 'policy' || change === 'perpetual'
    if (refused) await expect(turn).rejects.toMatchObject({ code: 'CONTEXT_INPUT_STALE' })
    else await turn
    expect(invalidated).toBe(true)
    expect(requests).toBe(refused ? 0 : 1)
    if (change === 'content') { expect(bodies[0]).toContain('UPDATED_INSTRUCTION_BODY'); expect(bodies[0]).not.toContain('CURRENT_INSTRUCTION_BODY') }
    if (change === 'perpetual') expect(preparations).toBe(4)
    await service.closeSession('main')
    const events = (await backend.read('main')).events
    expect(events.filter(event => event.type === 'runtime/context')).toHaveLength(change === 'content' ? 2 : 1)
  } finally {
    await service.close(); await coordinator.close(); await environment.close()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
