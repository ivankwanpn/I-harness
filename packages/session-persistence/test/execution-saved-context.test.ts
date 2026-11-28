import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { contextUsageAnchorId, encodeFactBatch, readFactJournal, type JournalMetadata, type RequestBudgetSnapshot, type RequestBudgetSnapshotV2, type SessionEvent } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { acquireManagedExecution } from '../src/execution-internal.ts'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'
import type { ColdArchiveHistoryReader } from '../src/archive-read-internal.ts'
import type { SessionCoordinator } from '../src/coordinator/types.ts'
import { observeManagedConstruction } from './helpers/managed-installation.ts'

const probe = vi.hoisted(() => ({
  full: 0, windows: [] as number[][],
  blockCold: undefined as undefined | (() => Promise<void>), blockWriter: undefined as undefined | (() => Promise<void>),
}))
vi.mock('../src/archive-read-internal.ts', async load => {
  const original = await load<typeof import('../src/archive-read-internal.ts')>()
  return { ...original, associateColdArchiveHistoryReader(backend: object, reader: ColdArchiveHistoryReader) {
    original.associateColdArchiveHistoryReader(backend, {
      ...reader,
      async readFullForHistoryPage(id) {
        probe.full++
        const result = await reader.readFullForHistoryPage!(id)
        await probe.blockCold?.()
        return result
      },
      readWindow(id, evidence, ordinals) {
        probe.windows.push([...ordinals])
        return reader.readWindow(id, evidence, ordinals)
      },
    })
  } }
})
vi.mock('../../session-persistence-jsonl/src/backend/process-read.ts', async load => {
  const original = await load<typeof import('../../session-persistence-jsonl/src/backend/process-read.ts')>()
  return { ...original, createJsonlProcessReadCapability(...args: Parameters<typeof original.createJsonlProcessReadCapability>) {
    const capability = original.createJsonlProcessReadCapability(...args)
    return { ...capability, openTaskHistory(...input: Parameters<typeof capability.openTaskHistory>) {
      const history = capability.openTaskHistory(...input)
      return { observe: history.observe.bind(history), hasDebt: history.hasDebt.bind(history),
        retryResources: history.retryResources.bind(history), settleResources: history.settleResources.bind(history),
        async observeClean() { await probe.blockWriter?.(); return history.observeClean() },
      }
    } }
  } }
})

const coordinators: SessionCoordinator[] = []
afterEach(async () => {
  probe.full = 0
  probe.windows = []
  probe.blockCold = undefined
  probe.blockWriter = undefined
  for (const coordinator of coordinators.splice(0)) await coordinator.close()
})

const sessionId = 'owner'
const binding = { providerId: 'provider-a', modelId: 'model-a', protocol: 'responses' }
const other = { providerId: 'provider-b', modelId: 'model-b', protocol: 'responses' }
const digest = 'a'.repeat(64)
const coreBudget = { ownerSessionId: sessionId, ...binding, bindingFingerprint: digest, bindingRevision: 0, projectionRevision: 0,
  neutralFingerprint: digest, identityCoverage: 'partial' as const, recoveryRequired: false, fullByProvider: false }
const v2Budget: RequestBudgetSnapshotV2 = { ...coreBudget, version: 2, purpose: 'main', estimate: {kind:'unknown',reason:'unconfigured'},
  disposition: 'compatibility', dimensions: [{dimension:'context',state:'unchecked'}], pressure: {kind:'unavailable',reason:'unconfigured'},
  components: {kind:'estimated',source:'projected-heuristic',user:10,assistant:0,tool:0,system:0,schema:0,reasoning:0},
  output: {capSupport:'unknown',minimumCap:1}, freshness:'awaiting-projection',
  requestContext: {version:1,semanticRevision:digest,protectionRevision:digest,branchId:digest,contextEpoch:digest,surfaceRevision:digest} }
const v1Budget: RequestBudgetSnapshot = { ...coreBudget, version: 1, estimatedInputTokens:10,admissionInputTokens:10,
  estimateSource:'neutral-only',coverage:'neutral-only',confidence:'estimated',roleTokens:{user:10,assistant:0,tool:0},
  systemTokens:0,schemaTokens:0,reasoningTokens:0,outputReserve:0,capSupport:'unknown',safetyMargin:0,admission:'unavailable' }

async function fixture(commit = false) {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'saved-context-'))
  const coordinator = commit
    ? asSessionCoordinator(createCommitCoordinator({ root }))
    : composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  coordinators.push(coordinator)
  const box = commit ? v1Budget : v2Budget
  const recovery = { type:'context/recovery',version:1,ownerSessionId:sessionId,logicalStepSeq:0,
    bindingFingerprint:digest,rejectedInputFingerprint:digest,state:'required' } as const
  const budget: SessionEvent = box.version === 1 ? { type:'context/budget',version:1,snapshot:box } : { type:'context/budget',version:2,snapshot:box }
  await coordinator.create({ sessionId })
  await coordinator.append(sessionId,[budget,{...recovery,...binding,recoveryId:'original-lane'},{...recovery,...other,recoveryId:'other-lane'}])
  await coordinator.releaseOwnership(sessionId)
  return { root, coordinator }
}

function hold() {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  return { ...entered, release: release.resolve, async block() { entered.resolve(); await release.promise } }
}

it('shares the original cold decode of a page and a saved context read', async () => {
  const { root, coordinator } = await fixture()
  const path = join(root, 'owner.jsonl'), original = await readFile(path)
  const cold = hold()
  probe.blockCold = cold.block
  const page = coordinator.readHistoryPage!(sessionId, {afterSeq:0,limit:3})
  await cold.promise
  const saved = coordinator.readSavedContext!(sessionId)
  try {
    await new Promise(setImmediate)
    cold.release()
    const [window, facts] = await Promise.all([page,saved])
    expect(window?.events).toHaveLength(3)
    expect(facts).toMatchObject({budget:v2Budget,recovery:{recoveryId:'original-lane'}})
    expect(probe.full).toBe(1)
    expect(coordinator.hasLiveOwnership!(sessionId)).toBe(false)
    expect(await readFile(path)).toEqual(original)
  } finally { cold.release(); await Promise.allSettled([page,saved]) }
})

it('uses only owned context ordinals from a sealed page and rejects the old proof after the file changes', async () => {
  const { coordinator } = await fixture()
  const next = {...v2Budget, bindingRevision: 1}
  await coordinator.append(sessionId, [{type:'user/message',text:'outside context observations'},
    {type:'context/budget',version:2,snapshot:next}])
  const page = await coordinator.readHistoryPage!(sessionId,{afterSeq:3,limit:1})
  expect(page?.events).toHaveLength(1)
  await expect(coordinator.readSavedContext!(sessionId,other)).resolves.toMatchObject({budget:next,recovery:{recoveryId:'other-lane'}})
  await expect(coordinator.readSavedContext!(sessionId)).resolves.toMatchObject({recovery:{recoveryId:'original-lane'}})
  expect(probe.full).toBe(1)
  expect(probe.windows).toEqual([[1,2,4],[1,2,4]])
  const changed = {...next,...other,bindingRevision:2}
  await coordinator.append(sessionId,[{type:'context/budget',version:2,snapshot:changed}])
  await expect(coordinator.readSavedContext!(sessionId)).resolves.toMatchObject({budget:changed,recovery:{recoveryId:'other-lane'}})
  expect(probe.full).toBe(2)
})

it('refuses an invalid replacement of a previously indexed context history', async () => {
  const { root, coordinator } = await fixture()
  await coordinator.readHistoryPage!(sessionId, {afterSeq:0,limit:1})
  const path = join(root, 'owner.jsonl'), original = await readFile(path), end = original.indexOf(10)
  const header = JSON.parse(original.subarray(0, end).toString('utf8')) as { sessionId: string; journal: JournalMetadata; formatVersion: number }
  const { prefix } = readFactJournal(original.subarray(end + 1), header.journal, header.formatVersion, header)
  const invalid = { type:'context/budget', version:2, snapshot:{}, seq:prefix.eventCount } as SessionEvent
  const frame = encodeFactBatch('invalid-saved-context', prefix.prefixDigest, [invalid])
  await appendFile(path,frame.bytes)
  await expect(coordinator.readSavedContext!(sessionId)).rejects.toThrow('unsupported conversation history')
  expect(probe.full).toBe(2)
})

it('still reads a late recovery after the cold page exceeds its recovery index limit', async () => {
  const { coordinator } = await fixture()
  const late = { ...other, modelId: 'late-model' }
  const recovery = { type: 'context/recovery', version: 1, ownerSessionId: sessionId, logicalStepSeq: 0,
    bindingFingerprint: digest, rejectedInputFingerprint: digest, state: 'required' } as const
  await coordinator.append(sessionId, [
    ...Array.from({ length: 255 }, (_, i) => ({ ...recovery, ...other, recoveryId: `prior-${i}` })),
    { ...recovery, ...late, recoveryId: 'after-limit' },
  ])
  await coordinator.readHistoryPage!(sessionId, { afterSeq: 0, limit: 1 })
  await expect(coordinator.readSavedContext!(sessionId, late)).resolves.toMatchObject({
    budget: v2Budget, recovery: { recoveryId: 'after-limit', modelId: late.modelId },
  })
  expect(probe.windows).toHaveLength(0)
})

it.each(['after reservation', 'before reservation'] as const)('saved context joins or linearizes against the original attachment %s', async order => {
  const { coordinator } = await fixture()
  const stopConstruction = observeManagedConstruction(() => { throw Error('Saved context materialized a compatibility view') })
  const writer = hold(), cold = hold()
  probe.blockWriter = writer.block
  let opening: ReturnType<typeof acquireManagedExecution> | undefined
  let reading: ReturnType<NonNullable<SessionCoordinator['readSavedContext']>> | undefined
  try {
    if (order === 'before reservation') {
      probe.blockCold = cold.block
      reading = coordinator.readSavedContext!(sessionId)
      await cold.promise
    }
    opening = acquireManagedExecution(coordinator, sessionId)
    await writer.promise
    reading ??= coordinator.readSavedContext!(sessionId)
    if (order === 'before reservation') {
      cold.release()
      // The original page seal proves this committed observation before the
      // held write owner has a published document. No wait for the writer.
      await expect(reading).resolves.toMatchObject({budget:v2Budget,recovery:{recoveryId:'original-lane'}})
    }
    writer.release()
    const execution = await opening
    expect(Object.hasOwn(execution.owner,'view')).toBe(false)
    await expect(reading).resolves.toMatchObject({budget:v2Budget,recovery:{recoveryId:'original-lane'}})
    expect(probe.full).toBe(order === 'before reservation' ? 1 : 0)
    const detached = await coordinator.readSavedContext!(sessionId, other)
    expect(detached.recovery?.recoveryId).toBe('other-lane')
    ;(detached.budget as {components:{user:number}}).components.user = 0
    await expect(coordinator.readSavedContext!(sessionId)).resolves.toMatchObject({budget:v2Budget,recovery:{recoveryId:'original-lane'}})
    expect(Object.hasOwn(execution.owner,'view')).toBe(false)
    coordinator.revokeManagedDocumentNewWork(sessionId)
    await expect(coordinator.readSavedContext!(sessionId)).rejects.toThrow()
  } finally { cold.release(); writer.release(); await Promise.allSettled([opening,reading]); stopConstruction() }
})

it('preserves a legacy budget and recovery selection across cold and live commit-log reads', async () => {
  const { coordinator } = await fixture(true)
  const cold = await coordinator.readSavedContext!(sessionId)
  expect(cold).toMatchObject({budget:v1Budget,recovery:{recoveryId:'original-lane'}})
  const execution = await acquireManagedExecution(coordinator, sessionId)
  expect(Object.hasOwn(execution.owner,'view')).toBe(false)
  await expect(coordinator.readSavedContext!(sessionId)).resolves.toEqual(cold)
  await expect(coordinator.readSavedContext!(sessionId,other)).resolves.toMatchObject({recovery:{recoveryId:'other-lane'}})
  expect(Object.hasOwn(execution.owner,'view')).toBe(false)
  coordinator.revokeManagedDocumentNewWork(sessionId)
  // The retired attachment cannot supply fresh observations. A new passive
  // reader has the same access to committed budget facts as snapshot().
  expect((await coordinator.snapshot!(sessionId)).session.events).toContainEqual(expect.objectContaining({ type: 'context/budget' }))
  await expect(coordinator.readSavedContext!(sessionId)).resolves.toEqual(cold)
})

it.each(['jsonl', 'commit'] as const)('keeps auxiliary budgets out of cold and managed conversation readings (%s)', async storage => {
  const { coordinator } = await fixture(storage === 'commit')
  const conversation = { ...v2Budget, purpose: 'recovery' as const, estimate: { kind: 'estimated' as const, source: 'projected-heuristic' as const, value: 27000 } }
  const auxiliary = { ...v2Budget, purpose: 'approval' as const, estimate: { kind: 'estimated' as const, source: 'projected-heuristic' as const, value: 50 } }
  await coordinator.append(sessionId, [conversation, auxiliary].map(snapshot => ({ type: 'context/budget', version: 2, snapshot })))
  await coordinator.releaseOwnership(sessionId)
  await expect(coordinator.readSavedContext!(sessionId)).resolves.toMatchObject({ budget: conversation })
  if (storage === 'jsonl') {
    await coordinator.readHistoryPage!(sessionId, { afterSeq: 0, limit: 1 })
    await expect(coordinator.readSavedContext!(sessionId)).resolves.toMatchObject({ budget: conversation })
    expect(probe.windows.at(-1)).toEqual([1, 2, 3])
  }
  const execution = await acquireManagedExecution(coordinator, sessionId)
  expect(execution.observe().budget()).toEqual(auxiliary)
  await expect(coordinator.readSavedContext!(sessionId)).resolves.toMatchObject({ budget: conversation })
  await execution.close()
})

it.each(['jsonl', 'commit'] as const)('reads the accepted provider-input total for the same bound budget (%s)', async storage => {
  const { coordinator } = await fixture(storage === 'commit')
  const currentBinding = { ...binding, identityCoverage: 'complete', bindingConfigFingerprint: digest } as const
  await coordinator.append(sessionId, [{ type: 'user/message', text: 'question', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }])
  const initial = (await coordinator.snapshot!(sessionId)).session.events.length
  const request = { version:1,ownerSessionId:sessionId,observationLifetimeId:'live',candidateId:'candidate',sendId:'send',
    semanticId:digest,payloadId:digest,payloadKind:'http-json-body',executionEpochId:'epoch',coldCompatible:false,
    snapshot:{semanticRevision:digest,protectionRevision:digest,branchId:digest,contextEpoch:digest,surfaceRevision:digest},projectionRevision:0 } as const
  const receipt = { exchangeId:'exchange',actionId:'action',attemptId:'attempt' }
  const sample = { version:2,accepted:{acceptedSeq:initial+3,...receipt},request,bindingId:digest,shapeId:digest,pricingVersion:'projected-pricing-v2',
    normalizationVersion:'input-usage-v1',usageSemantics:'includes-cache',prefixId:digest,unitCount:1,heuristicPrefixTokens:12,
    reportedInputTokens:41,reportedOutputTokens:5000,cacheReadTokens:13,cacheCreationTokens:2 } as const
  const budget: RequestBudgetSnapshotV2 = {...v2Budget,...currentBinding,selectedSemanticId:digest,selectedPayloadId:digest}
  const completed: SessionEvent[] = [
    {type:'conversation/semantics',version:1,mode:'accepted-exchange-v1'},
    {type:'step/start',actionId:receipt.actionId,attemptId:receipt.attemptId},
    {type:'assistant/message',text:'recorded provider answer'},
    {type:'model/exchange-accepted',version:2,...receipt,request,stepStartSeq:initial+1,assistantSeq:initial+2,callSeqs:[]},
    {type:'context/usage',version:2,op:'sample',checkpoint:{...sample,anchorId:contextUsageAnchorId(sample)}},
    {type:'context/budget',version:2,snapshot:budget},
    {type:'step/end'},
    {type:'context/action',op:'open',version:1,ownerSessionId:sessionId,actionId:'title-action',purpose:'title',origin:{kind:'input',seq:initial-1},startedAt:1,trustedAt:1,expiresAt:10},
    {type:'context/budget',version:2,snapshot:{...budget,purpose:'title'}},
    {type:'context/action',op:'close',version:1,ownerSessionId:sessionId,actionId:'title-action',trustedAt:2,disposition:'completed'},
  ]
  await coordinator.append(sessionId, completed.map((event, index) => ({ ...event, seq: initial + index })))
  await coordinator.releaseOwnership(sessionId)
  if (coordinator.readHistoryPage) await coordinator.readHistoryPage(sessionId,{afterSeq:0,limit:1})
  await expect(coordinator.readSavedContext!(sessionId,currentBinding)).resolves.toMatchObject({budget,lastReportedInputTokens:41})
  await expect(coordinator.readSavedContext!(sessionId,{...currentBinding,bindingConfigFingerprint:'b'.repeat(64)})).resolves.not.toHaveProperty('lastReportedInputTokens')
  await expect(coordinator.readSavedContext!(sessionId)).resolves.not.toHaveProperty('lastReportedInputTokens')
  const execution = await acquireManagedExecution(coordinator,sessionId)
  expect(Object.hasOwn(execution.owner,'view')).toBe(false)
  expect(execution.observe().lastReportedInputTokens()).toBeUndefined()
  await expect(coordinator.readSavedContext!(sessionId,currentBinding)).resolves.toMatchObject({lastReportedInputTokens:41})
  expect(Object.hasOwn(execution.owner,'view')).toBe(false)
  const nextSeq = execution.observe().eventCount
  await execution.close()
  await coordinator.append(sessionId,[{type:'compaction/reset',removedSeqs:[],seq:nextSeq}])
  await expect(coordinator.readSavedContext!(sessionId,currentBinding)).resolves.toMatchObject({ budgetSupersededByRewrite: true })
  await expect(coordinator.readSavedContext!(sessionId,currentBinding)).resolves.not.toHaveProperty('lastReportedInputTokens')
})
