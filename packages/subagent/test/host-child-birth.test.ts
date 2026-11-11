import { expect, it, vi } from 'vitest'
const initialIO = vi.hoisted(() => ({ armed: false, entered: undefined as (() => void) | undefined, release: undefined as Promise<void> | undefined, writes: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args), write = handle.write.bind(handle)
    // Observe the original physical append; return the same native handle.
    handle.write = (async (...writeArgs: any[]) => {
      if (initialIO.armed && Buffer.isBuffer(writeArgs[0]) && writeArgs[0].includes(Buffer.from('agent/input/admitted'))) {
        initialIO.armed = false; initialIO.writes++; initialIO.entered?.(); await initialIO.release
      }
      return (write as any)(...writeArgs)
    }) as typeof handle.write
    return handle
  } }
})
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { taskDocumentStorageContract } from '@i-harness/session-persistence/internal/task-state'
import { createPredecessorSession } from '../../session-persistence-jsonl/test/helpers/predecessor.ts'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgentRegistry } from '@i-harness/core-agent'
import { append, copyConversationData, createSession, deriveMessages, decodeFactBatch, encodeFactBatch } from '@i-harness/core-session'
import { spawnChild, type SpawnOptions } from '../src/child.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'
import { createTaskResultRetention } from '../../session-executor/src/lifecycle/task-result-retention.ts'

// Candidate only: original full native lifecycle budgets must be measured after
// integration; no qualified timing claim is attached to this unexecuted file.
const sourceCases = [
  'all', 'none', 'legacy-parent', 'memory-parent', 'memory-parent-empty',
  'memory-parent-with-header', 'mutated-request', 'old-ref-excluded',
  'empty-with-old-ref', 'memory-parent-zero', 'memory-parent-infinity', 'memory-parent-unsequenced', 'memory-parent-referenced-unsequenced',
] as const
const cases = (['jsonl', 'commit-log'] as const).flatMap(backend => sourceCases.map(seed => ({ backend, seed })))
it.each(cases)(
  'raw public host birth is atomic on $backend with $seed', async ({ backend, seed }) => {
    const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'host-birth-'))
    const jsonl = createJsonlBackend(root, {
      wrapOwnedBatch: original => async (...args) => {
        if (initialIO.armed && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted')) {
          initialIO.armed = false
          initialIO.writes++
          initialIO.entered?.()
          await initialIO.release
        }
        return original(...args)
      },
    })
    if (seed === 'legacy-parent') {
      const legacyPath = await createPredecessorSession(jsonl, root, 'parent', 13, '2026-11-01T00:00:00.000Z')
      const header = JSON.parse((await readFile(legacyPath, 'utf8')).split('\n')[0]!)
      const events: import('@i-harness/core-session').SessionEvent[] = [{ type: 'turn/start', seq: 0 }, { type: 'user/message', text: 'inherited', seq: 1 }, { type: 'turn/end', seq: 2 }]
      const batch = encodeFactBatch('historical-parent', header.journal.legacyPrefixDigest, events)
      await writeFile(legacyPath, Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), batch.bytes]))
    }
    const coordinator = backend === 'jsonl' ? createSessionCoordinator(jsonl, { lock: { enabled: true } })
      : asSessionCoordinator(createJsonlCommitCoordinator(root, { lock: { enabled: true, lockRoot: root } }), { taskDocument: { validator: taskDocumentStorageContract, empty: taskDocumentStorageContract.empty } })
    const memorySource = seed === 'memory-parent' || seed === 'memory-parent-empty' || seed === 'memory-parent-with-header'
      || seed === 'mutated-request' || seed === 'old-ref-excluded' || seed === 'empty-with-old-ref'
      || seed === 'memory-parent-zero' || seed === 'memory-parent-infinity' || seed === 'memory-parent-unsequenced' || seed === 'memory-parent-referenced-unsequenced'
    const emptySeed = seed === 'none' || seed === 'memory-parent-empty' || seed === 'empty-with-old-ref' || seed === 'memory-parent-zero'
    if (seed !== 'legacy-parent' && !memorySource) {
      await coordinator.create({ sessionId: 'parent' })
      await coordinator.append('parent', [{ type: 'turn/start' }, { type: 'user/message', text: 'inherited' }, { type: 'turn/end' }])
    }
    const memoryParent = createSession()
    if (seed === 'memory-parent-with-header') {
      const header = { sessionId: 'parent', origin: 'subagent', delegationDepth: 1 }
      memoryParent.header = header
    }
    if (seed === 'old-ref-excluded' || seed === 'empty-with-old-ref') {
      append(memoryParent, { type: 'turn/start' })
      append(memoryParent, { type: 'user/message', text: 'older' })
      append(memoryParent, { type: 'context/result-ref', ref: {
        id: 'ctx_' + 'a'.repeat(64), workspaceId: 'w', sessionId: 'creator', callId: 'old', label: 'old',
        revision: 'b'.repeat(64), bytes: 1, originalBytes: 1, complete: true, expiresAt: 2_000_000_000_000,
      } })
      append(memoryParent, { type: 'turn/end' })
    }
    append(memoryParent, { type: 'turn/start' })
    append(memoryParent, { type: 'user/message', text: 'inherited' })
    append(memoryParent, { type: 'turn/end' })
    if (seed === 'memory-parent-unsequenced') {
      memoryParent.events.splice(0, memoryParent.events.length,
        { type: 'turn/start' }, { type: 'user/message', text: 'inherited' }, { type: 'turn/end' })
    }
    let expectedReferenced: ReturnType<typeof deriveMessages> | undefined
    if (seed === 'memory-parent-referenced-unsequenced') {
      const reference = createSession()
      const events: import('@i-harness/core-session').SessionEvent[] = [
        { type: 'turn/start' }, { type: 'user/message', text: 'older input' },
        { type: 'assistant/message', text: 'older answer' }, { type: 'turn/end' },
        { type: 'turn/start' }, { type: 'user/message', text: 'inherited' },
        { type: 'compaction/summary', text: 'earlier summary', shadowedSeqs: [0, 1, 2, 3] },
        { type: 'assistant/message', text: 'current answer' }, { type: 'turn/end' },
      ]
      for (const event of events) append(reference, copyConversationData(event))
      expectedReferenced = deriveMessages(reference)
      memoryParent.events.splice(0, memoryParent.events.length, ...events)
    }
    const parent = memorySource ? memoryParent : (await coordinator.snapshot!('parent')).session
    const originalParent = JSON.stringify(parent)
    if (memorySource) expect(await coordinator.list()).not.toContain('parent')
    const ctx = createContext(), registry = createToolRegistry(ctx)
    const table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let models = 0, inherited = 0, replacements = 0, resolutions = 0, validations = 0, unrelatedReads = 0, resultSources = 0
    ctx.on('session/inherited', async payload => {
      const { sessionId, session, parentSessionId } = payload as { sessionId: string; session: typeof parent; parentSessionId: string }
      expect(parentSessionId).toBe('parent')
      expect((await coordinator.snapshot!(sessionId)).session.events).toEqual(session.events)
      const messages = deriveMessages(session)
      expect(messages).toEqual(expectedReferenced ?? (emptySeed ? [] : [{ role: 'user', content: 'inherited' }]))
      inherited++
    })
    initialIO.armed = true; initialIO.entered = entered.resolve; initialIO.release = release.promise; initialIO.writes = 0
    const options: SpawnOptions = { generationFactoryFor: fixtureGenerationFor, taskName: 'host', message: 'initial instruction', parentPath: 'root',
      parentCtx: ctx, parentRegistry: registry, parentSession: parent, table, jobs, agents,
      childSessions: { coordinator, parentSessionId: 'parent' }, forkTurns: seed === 'memory-parent-zero' ? 0 : seed === 'memory-parent-infinity' ? Infinity : emptySeed ? 'none' : seed === 'old-ref-excluded' ? 1 : 'all',
      role: { name: 'probe', description: '', systemPrompt: 'probe', tools: [] }, resolveModel: async () => { resolutions++; return { status: 'unconfigured', reason: 'unused' } },
      modelActionTimeoutMs: 60000, modelActionMaxAttempts: 3, contextWindow: 8192, maxOutputTokens: 128,
      parentModel: controlledModel(async function* (request) {
        models++
        expect(request.systemPrompt).toContain('probe')
        expect(request.systemPrompt).not.toContain('mutated role prompt')
        expect(request.maxOutputTokens).toBe(128)
        const entry = table.get('root/host')!, stored = (await coordinator.snapshot!(entry.sessionId!)).session
        expect(stored.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
        expect(stored.events.find(event => event.type === 'agent/input/admitted')).toMatchObject({ text: 'initial instruction' })
        expect(stored.events.some(event => event.type === 'session/bootstrap')).toBe(true)
        yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' }
      }),
    }
    if (seed === 'mutated-request') {
      options.taskId = 'captured-hint'
      options.agentPath = 'root/host'
      options.results = createTaskResultRetention(undefined, async () => { resultSources++; return undefined }, 'parent')
    }
    const prototype = { validateBeforeLaunch() {
      expect(this).toBe(options)
      validations++
    } }
    Object.setPrototypeOf(options, prototype)
    Object.defineProperty(options, 'unrelatedCapability', { enumerable: true, get() {
      unrelatedReads++
      throw Error('Unrelated capability getter must not be captured')
    } })
    const spawning = spawnChild(options)
    const observed = spawning.then(value => ({ value }), error => ({ error }))
    try {
      await Promise.race([entered.promise, observed.then(result => { if ('error' in result) throw result.error; throw Error('Spawn completed before held original IO') })])
      expect({ models, inherited, entries: table.entries().size }).toEqual({ models: 0, inherited: 0, entries: 0 })
      if (seed === 'mutated-request') {
        options.message = 'changed after admission'
        options.taskName = 'redirected'
        options.taskId = 'changed-hint'
        options.agentPath = 'root/changed'
        options.role.name = 'changed role'
        options.role.systemPrompt = 'mutated role prompt'
        options.role.tools.push('unavailable-mutated-tool')
        options.role.model = { provider: 'unexpected', model: 'unexpected' }
        options.forkTurns = 'none'
        options.modelActionTimeoutMs = 1
        options.modelActionMaxAttempts = 0
        options.maxOutputTokens = 1
        options.contextWindow = 1
        options.childSessions!.parentSessionId = 'foreign-parent'
        options.childSessions!.origin = 'approval-review'
        options.parentModel = controlledModel(async function* () { replacements++; throw Error('Replacement model must not run') })
      }
      release.resolve()
      const result = await spawning, entry = table.get(result.path)!
      await entry.followupChain
      expect({ models, inherited, initialWrites: initialIO.writes }).toEqual({ models: 1, inherited: 1, initialWrites: 1 })
      expect(entry.finalText).toBe('done')
      expect(entry.roleName).toBe('probe')
      expect(JSON.stringify(parent)).toBe(originalParent)
      if (seed === 'mutated-request') {
        expect(entry.session.header).toMatchObject({ subagentTaskId: 'captured-hint', subagentAgentPath: 'root/host' })
        expect(resultSources).toBe(1)
        expect(entry.resultCapture).toBeDefined()
      } else expect(resultSources).toBe(0)
      expect({ replacements, resolutions, unrelatedReads, validations }).toEqual({ replacements: 0, resolutions: 0, unrelatedReads: 0, validations: 2 })
      const opened = entry.session.events.find(event => event.type === 'context/action' && event.op === 'open')
      if (opened?.type !== 'context/action' || opened.op !== 'open') throw Error('Original child generation missing')
      expect(opened.expiresAt - opened.startedAt).toBe(60000)
      expect(entry.session).toBe((await coordinator.openManagedDocument(result.sessionId!)).view)
    } finally {
      release.resolve(); initialIO.armed = false; await observed
      for (const entry of table.entries().values()) await entry.dispose?.()
      await coordinator.close(); await ctx.scope.unmount()
    }
  }, 20000)
