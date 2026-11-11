import { randomUUID } from 'node:crypto'
import { canonicalJsonData, copyConversationData, freezeJsonData, createLegacyRetentionSelection, exportConversationSeed, type SessionView } from '@i-harness/core-session'
import { verifyStoredChildBirth } from './task-birth.ts'
import { captureGenerationBudget } from '@i-harness/core-agent'
import { compileSemanticSeed, createBootstrapRequestIntent, SessionBindingObservationError, type BootstrapOutcome, type BootstrapRequest, type ManagedDocument } from '@i-harness/session-persistence'
import type { SpawnOptions } from './types.ts'
import type { RoleModelSelection } from './model-binding.ts'
import type { CommittedInitialChildInput } from './generation.ts'

type Ready = Extract<BootstrapOutcome, { kind: 'ready' | 'already-ready' }>
export interface CapturedHostChildData {
  readonly taskName: string
  readonly message: string
  readonly parentPath: string
  readonly taskId: string | undefined
  readonly agentPath: string | undefined
  readonly forkTurns: SpawnOptions['forkTurns']
  readonly role: SpawnOptions['role']
  readonly parentSessionId: string
  readonly origin: 'subagent' | 'approval-review'
  readonly delegationDepth: number
  readonly modelActionTimeoutMs: SpawnOptions['modelActionTimeoutMs']
  readonly modelActionMaxAttempts: SpawnOptions['modelActionMaxAttempts']
}
/** Request data is copied. Existing capabilities remain their original objects
 * and original method receivers; no capability object is spread or cloned. */
export interface CapturedHostChildInput {
  readonly data: CapturedHostChildData
  readonly seed: ReturnType<typeof compileSemanticSeed>
  readonly selection: { kind: 'none' } | { kind: 'all' } | { kind: 'last-turns'; count: number }
  readonly coordinator: NonNullable<SpawnOptions['childSessions']>['coordinator']
  readonly signal: SpawnOptions['signal']
  readonly generationFactory: SpawnOptions['generationFactoryFor']
  readonly sharedGeneration: SpawnOptions['sharedGeneration']
  readonly receiver: SpawnOptions
}
export function captureHostModelSelection(model: RoleModelSelection): RoleModelSelection {
  return Object.freeze({
    provider: model.provider,
    model: model.model,
    ...(model.protocol === undefined ? {} : { protocol: model.protocol }),
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
  })
}
export function captureHostChildInput(opts: SpawnOptions): CapturedHostChildInput {
  const host = opts.childSessions!
  const source = opts.parentSession
  if (!source) throw unsupported('Host child requires its captured parent observation')
  const role = opts.role
  const model = role.model
  const capturedRole = {
    name: role.name,
    description: role.description,
    systemPrompt: role.systemPrompt,
    tools: [...role.tools],
    ...(model ? { model: { provider: model.provider, model: model.model } } : {}),
    ...(role.ephemeral === undefined ? {} : { ephemeral: role.ephemeral }),
  }
  freezeJsonData(capturedRole)
  const data: CapturedHostChildData = Object.freeze({
    taskName: opts.taskName,
    message: opts.message,
    parentPath: opts.parentPath,
    taskId: opts.taskId,
    agentPath: opts.agentPath,
    forkTurns: opts.forkTurns,
    role: capturedRole,
    parentSessionId: host.parentSessionId,
    origin: host.origin ?? 'subagent',
    delegationDepth: (source.header?.delegationDepth ?? 0) + 1,
    modelActionTimeoutMs: opts.modelActionTimeoutMs,
    modelActionMaxAttempts: opts.modelActionMaxAttempts,
  })
  const selection = captureRawHistorySelection(data.forkTurns)
  if (data.origin === 'approval-review' && (selection.kind !== 'none' || !opts.sharedGeneration)) {
    throw Object.assign(new Error('Reviewer requires its original parent allowance and no inherited seed'), { code: 'GENERATION_UNSUPPORTED' })
  }
  // None does not inspect source events, format, dependency payloads, or refs.
  const observation = selection.kind === 'none' ? undefined : captureHostObservation(source)
  const exported = observation === undefined ? { kind: 'none' as const }
    : exportConversationSeed(observation, { kind: 'session', sessionId: data.parentSessionId }, selection)
  if (exported.kind === 'refused') throw unsupported('Host conversation cannot be exported atomically')
  const seed = compileSemanticSeed(exported)
  freezeJsonData(seed)
  if (selection.kind !== 'none') {
    const manifest = seed.records[0]
    const legacy = createLegacyRetentionSelection(observation!, selection)
    if (manifest?.type === 'conversation/seed-manifest' && manifest.artifacts.length > 0
      || legacy.kind !== 'selected' || !legacy.local()[Symbol.iterator]().next().done) {
      throw unsupported('Raw host birth has no original result-dependency transfer')
    }
  }
  return Object.freeze({
    data,
    seed,
    selection,
    coordinator: host.coordinator,
    signal: opts.signal,
    generationFactory: opts.generationFactoryFor,
    sharedGeneration: opts.sharedGeneration,
    receiver: opts,
  })
}

/** A standalone observation may use array positions without explicit seqs.
 * Assign those positions only on an owned data copy. Existing coordinates and
 * every context/ref event remain intact for semantic/dependency validation. */
function captureHostObservation(source: SessionView): SessionView {
  if (!source.events.some(event => event.seq === undefined)) return source
  const events = copyConversationData(source.events).map((event, index) =>
    event.seq === undefined ? { ...event, seq: index } : event)
  const observation: SessionView = {
    formatVersion: source.formatVersion,
    events,
    ...(source.header ? { header: copyConversationData(source.header) } : {}),
  }
  freezeJsonData(observation)
  return observation
}
export interface HostChildBirth {
  document: ManagedDocument
  initial?: CommittedInitialChildInput
  sessionId: string
  close(): Promise<void>
  revoke(): void
}

/** Trusted host construction uses the generic storage protocol. It does not
 * claim a prepared Task caller, Task binding ACK, or Task launch slot. */
export async function openHostChildBirth(captured: CapturedHostChildInput, start: { wall: number; monotonic: number }, declared: RoleModelSelection | undefined): Promise<HostChildBirth> {
  const { data, seed, selection, coordinator, signal } = captured
  if (!coordinator.bootstrapSemanticTarget || !coordinator.resumeSemanticTarget) throw unsupported('Atomic durable child birth unavailable')
  signal?.throwIfAborted()
  const borrowedApproval = data.origin === 'approval-review'
  const approvalSignal = borrowedApproval ? captured.sharedGeneration!.signal : undefined
  approvalSignal?.throwIfAborted()
  const origin = data.origin
  const lineage = { origin, parentSession: data.parentSessionId, delegationDepth: data.delegationDepth,
    ...(origin === 'subagent' ? {
      subagentProtocolVersion: 1 as const,
      ...(data.taskId ? { subagentTaskId: data.taskId } : {}),
      ...(data.agentPath ? { subagentAgentPath: data.agentPath } : {}),
    } : {}) }
  // A reviewer borrows the parent's real allowance; it has no independent
  // child main budget. Its one input is admitted by the existing child owner
  // after zero-seed storage birth, immediately before forChild attachment.
  const window = borrowedApproval ? undefined
    : captureGenerationBudget('main', { timeoutMs: data.modelActionTimeoutMs, maxAttempts: data.modelActionMaxAttempts }, start.wall)
  const initial = window ? { inputId: randomUUID(), text: data.message, parentSessionId: data.parentSessionId, startedAt: window.startedAt, expiresAt: window.expiresAt } : undefined
  const operationId = randomUUID()
  const targetSessionId = 'child-' + randomUUID()
  const createdAt = new Date(start.wall).toISOString()
  const model = declared === undefined
    ? { kind: 'inherit-parent' }
    : { kind: 'declared', selection: declared }
  const input = initial ?? { kind: 'parent-owned-review', text: data.message }
  const core = { kind: 'host-child-birth', version: 1, lineage, seed, input, role: data.role, model, selection }
  const project = { kind: 'unmanaged' as const }
  const intent = createBootstrapRequestIntent(core, project)
  const invocation = { version: 1, operationId, targetSessionId, createdAt, requestDigest: intent.requestDigest }
  // Capture the candidate before any await. A host-owned snapshot is inherited
  // observation data, never a grant of live source or result authority.
  const payload = freezeJsonData(JSON.parse(canonicalJsonData({
    invocation,
    target: { kind: 'new' },
    metadata: {},
    lineage,
    seed,
    ...(initial ? { initial } : {}),
  }))) as BootstrapRequest
  let bindingSettled = false
  let ready: Ready | undefined
  let closeReady: (() => Promise<void>) | undefined
  let revokeReady: (() => void) | undefined
  try {
    if (!coordinator.withSessionBindingObservation) throw unsupported('Original host binding observation unavailable')
    // This public host API accepts a captured conversation observation. Even
    // an owned view's structural index does not turn copied text into a Task
    // caller, project transfer, live source grant, or inherited result member.
    // The original host context/tools and signal still own child execution.
    // Qualify the actual new target; do not infer storage origin from headers.
    await coordinator.withSessionBindingObservation({ existingSessionIds: [], target: payload.invocation, signal: signal }, async observation => {
      const assertCurrent = () => {
        signal?.throwIfAborted()
        approvalSignal?.throwIfAborted()
        observation.assertCurrent()
        if (observation.binding(targetSessionId).kind !== 'absent') throw unsupported('Host target project binding unavailable')
      }
      const never = async (): Promise<never> => {
        throw unsupported('Unexpected host dependency transfer')
      }
      assertCurrent()
      ready = await materialize(coordinator, payload, { signal, assertCurrent, dependencies: { confirm: never, reconcile: never } })
      closeReady = originalMethod(ready.document, 'close')
      revokeReady = originalMethod(ready.document, 'revokeNewWork')
    })
    bindingSettled = true
    if (!ready || !closeReady || !revokeReady) throw unsupported('Original host birth did not complete')
    verifyStoredChildBirth({ document: ready.document, receipt: ready.receipt, payload })
    return {
      document: ready.document,
      sessionId: targetSessionId,
      close: closeReady,
      revoke: revokeReady,
      ...(initial ? { initial: {
        inputId: initial.inputId,
        outcome: { kind: 'committed' as const, receipt: ready.receipt.completion, seqs: [ready.receipt.initial!.seq] },
        start,
      } } : {}),
    }
  } catch (cause) {
    // A committed receipt is not undone by later host-scope close failure. Its
    // exact original document still belongs to this unsuccessful attachment.
    // Only a successful original observation return acknowledges all outer
    // cleanup. Otherwise its source scope and ready document stay with the
    // existing coordinator owner; never race them with document.close here.
    if (closeReady && bindingSettled) {
      try {
        await closeReady()
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Original host child cleanup incomplete', { cause })
      }
    }
    // The original observation reports cancellation as revocation, or wraps
    // the callback's exact reason as unavailable. Normalize only those genuine
    // cleanup-complete failures; aggregate cleanup debt keeps its identity.
    if (signal?.aborted && cause instanceof SessionBindingObservationError
      && (cause.reason === 'revoked' || cause.cause === signal.reason)) {
      signal.throwIfAborted()
    }
    throw cause
  }
}
function unsupported(message: string) {
  return Object.assign(new Error(message), { code: 'FACT_OWNER_UNSUPPORTED' })
}
async function materialize(coordinator: NonNullable<SpawnOptions['childSessions']>['coordinator'], payload: BootstrapRequest,
  guards: import('@i-harness/session-persistence').BootstrapGuards): Promise<Ready> {
  let outcome = await coordinator.bootstrapSemanticTarget(payload, guards)
  if (outcome.kind === 'blocked') {
    guards.signal?.throwIfAborted()
    outcome = await coordinator.resumeSemanticTarget(payload.invocation, guards, payload)
  }
  if (outcome.kind === 'ready' || outcome.kind === 'already-ready') return outcome
  guards.signal?.throwIfAborted()
  if (outcome.kind === 'not-issued' && outcome.reason === 'cancelled') {
    throw Object.assign(new Error('Atomic host child birth cancelled'), { code: 'FACT_CANCELLED', outcome })
  }
  throw Object.assign(new Error('Atomic host child birth did not complete'),
    { code: outcome.kind === 'blocked' ? 'FACT_RECOVERY_REQUIRED' : 'FACT_OWNER_UNSUPPORTED', outcome })
}

function originalMethod<T extends (...args: any[]) => any>(owner: object, name: string): T {
  for (let current: object | null = owner; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor) {
      if ('value' in descriptor && typeof descriptor.value === 'function') return descriptor.value.bind(owner) as T
      break
    }
  }
  throw new TypeError(`Original child ${name} cleanup unavailable`)
}

function captureRawHistorySelection(turns: SpawnOptions['forkTurns']): CapturedHostChildInput['selection'] {
  if (turns === undefined || turns === 'none' || turns === 0) return { kind: 'none' }
  if (turns === 'all' || turns === Infinity) return { kind: 'all' }
  if (typeof turns === 'number' && Number.isSafeInteger(turns) && turns > 0) {
    return { kind: 'last-turns', count: turns }
  }
  throw new TypeError('forkTurns must be none, all, zero, Infinity, or a positive safe integer')
}
