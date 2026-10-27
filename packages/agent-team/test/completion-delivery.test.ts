import { controlledModel } from '../../subagent/test/generation-fixture.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../../session-executor/src/index.ts"
import type { ModelClient, LLMRequest } from "@i-harness/llm-seam"
import type { ParentInputAdmission } from "@i-harness/subagent"
import { SYSTEM_INPUT_PLUGIN, decodeFactBatch, subscribe, type SessionEvent, type SettlementFacts, type ReceivedInputSource, type BatchKey } from "@i-harness/core-session"
import { admitTeam, releaseTeam } from '../src/scheduler/admission.ts'

async function fixture(lead: ModelClient, child: ModelClient, parentNotify?: ParentInputAdmission, seed?: SessionEvent[], configure?: (coordinator: ReturnType<typeof createSessionCoordinator>, backend: ReturnType<typeof createJsonlBackend>) => void) {
  const root = await mkdtemp(join(tmpdir(), "team-completion-"))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: "lead" })
  if (seed?.length) await coordinator.append("lead", seed)
  configure?.(coordinator, backend)
  const service = createSessionService({
    workspace: root, model: lead, coordinator, sessionFor: createDurableSessionLoader(coordinator), team: {}, concurrentSessionTeams: true,
    roleSelectionFor: (role) => role === "teammate" ? { provider: "local", model: "fixture" } : undefined,
    allowSubagentModelSelection: true,
    ...(parentNotify ? { parentNotify } : {}),
    resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
    additionalTools: [{ name: "continue", description: "Continue the fixture", inputSchema: { type: "object" }, isReadOnly: true, execute: async () => ({ ok: true }) }],
  })
  const assembly = await service.assemblyFor("lead")
  const execute = (name: string, args: unknown) => assembly.tools.get(name)!.execute(args, { sessionId: "lead" })
  return { root, service, assembly, coordinator, backend, execute, close: async () => {
    try { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
    catch (error) { console.info('completion-fixture-close-failure', JSON.stringify({ root, error: boundedError(error) })); throw error }
  } }
}

async function assertColdDoesNotWake(root: string, marker: string) {
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const seen: LLMRequest[] = []
  const model: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { seen.push(request); yield { type: "text/chunk", text: "Unexpected wake" }; yield { type: "end" } })
  const service = createSessionService({ workspace: root, model, coordinator, sessionFor: createDurableSessionLoader(coordinator), team: {}, concurrentSessionTeams: true })
  try {
    const assembly = await service.assemblyFor("lead")
    await assembly.drainParentNotifications?.()
    expect(assembly.inbox.pending().some((input) => input.text.includes(marker))).toBe(false)
    expect(seen).toEqual([])
  } finally { await service.close(); await coordinator.close() }
}

function boundedError(error: unknown): unknown {
  const identities = new Map<object, number>()
  let remaining = 128
  const visit = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value !== 'object') return { type: typeof value, value }
    const previous = identities.get(value)
    if (previous !== undefined) return { cycleOrSharedReference: previous }
    if (remaining-- <= 0 || depth > 8) return { overflow: true, depth }
    const identity = identities.size + 1; identities.set(value, identity)
    if (value instanceof Error) return {
      identity, name: value.name, message: value.message, code: (value as Error & { code?: unknown }).code,
      stack: value.stack?.slice(0, 16_384), stackOverflow: (value.stack?.length ?? 0) > 16_384,
      ...(value instanceof AggregateError ? { errors: value.errors.slice(0, 16).map(error => visit(error, depth + 1)), errorsOverflow: value.errors.length > 16 } : {}),
      ...('cause' in value ? { cause: visit(value.cause, depth + 1) } : {}),
    }
    if (Array.isArray(value)) return { identity, values: value.slice(0, 16).map(item => visit(item, depth + 1)), overflow: value.length > 16 }
    const entries = Object.entries(value)
    return { identity, values: Object.fromEntries(entries.slice(0, 16).map(([key, item]) => [key, visit(item, depth + 1)])), overflow: entries.length > 16 }
  }
  return visit(error, 0)
}

async function completionEvidence(label: string, value: unknown) {
  const root = process.env.IH_STRUCTURE_EVIDENCE_ROOT
  if (!root) return
  const destination = join(root, 'task5'); await mkdir(destination, { recursive: true })
  await writeFile(join(destination, `${label}.json`), JSON.stringify(value, null, 2))
}

async function readRetainedJobBody(f: Awaited<ReturnType<typeof fixture>>, jobId: string, label: string) {
  const retained = Promise.withResolvers<void>()
  const check = () => { if (f.assembly.subagentState().agentTable.find(entry => entry.jobId === jobId)?.result?.kind === 'retained') retained.resolve() }
  const off = f.assembly.onSubagentsChanged!(check)
  try { check(); await retained.promise } finally { off() }
  const metadata = await f.execute('job_output', { job_id: jobId }) as {
    status: string; text: string; result_revision: string; result_ref: { id: string; revision: string }; result_retention: string
  }
  expect(metadata.status).toBe('completed'); expect(metadata.result_retention).toBe('artifact')
  expect(metadata.result_revision).toBeDefined(); expect(metadata.result_ref).toBeDefined()
  const pages: import('@i-harness/subagent').TaskResultPage[] = []
  let offset = 0, encodedBody = ''
  for (;;) {
    const page = await f.execute('job_output', { job_id: jobId, body: true, result_revision: metadata.result_revision,
      ref_id: metadata.result_ref.id, ref_revision: metadata.result_ref.revision, offset_bytes: offset, max_output_bytes: 4096 }) as import('@i-harness/subagent').TaskResultPage
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
    expect(page.codec).toBe('json-utf8-v1'); expect(page.resultRevision).toBe(metadata.result_revision)
    expect(page.ref).toMatchObject(metadata.result_ref); expect(page.offset).toBe(offset)
    expect(page.data.kind).toBe('text'); expect(page.data.text).not.toContain('\uFFFD')
    pages.push(page); encodedBody += page.data.text
    if (page.eof) { expect(page.nextOffset).toBeNull(); break }
    expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset!
  }
  const body = JSON.parse(encodedBody) as { resultText: string }
  expect(Object.keys(body)).toEqual(['resultText'])
  await completionEvidence(label, { root: f.root, jobId, metadata, pages, encodedBody })
  return { metadata, body }
}

function aggregateLeaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(aggregateLeaves) : [error]
}

// These controls observe the shipping service and the original native owners.
// The admission wrapper delegates exactly once and holds only its committed RETURN.
async function qualifyServiceOrder(order: 'stop-before-return' | 'ack-before-stop' | 'open-recovery') {
  const marker = `TEAM_ACK_OWNER_${order}`
  const admitted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const acknowledged = Promise.withResolvers<void>(), parentIdle = Promise.withResolvers<void>()
  const seen: LLMRequest[] = [], trace: unknown[] = []
  const batches: { sessionId: string; key: BatchKey; bytesBase64: string; batch: ReturnType<typeof decodeFactBatch>; result: unknown }[] = []
  const captures: { action: number; source?: SettlementFacts; tuple: unknown; fact: object }[] = []
  const documents = new Map<string, { document: Awaited<ReturnType<ReturnType<typeof createSessionCoordinator>['openManagedDocument']>>; closes: number }>()
  const sources: { action: number; source: SettlementFacts; closes: number; closed: number }[] = []
  const inputCaptures: { source: ReceivedInputSource; tuple: unknown; fact: object }[] = []
  const cancellationObservations: Promise<void>[] = []
  const cancellations: { receiver: object; args: [string, (string | undefined)?]; promise?: Promise<boolean>; outcome?: { kind: 'returned'; value: boolean } | { kind: 'rejected' | 'threw'; error: unknown } }[] = []
  const errorInfo = boundedError
  let overflow = 0, actions = 0, childTurns = 0, admitCalls = 0, cancelCalls = 0
  let originalInput: Parameters<Awaited<ReturnType<typeof fixture>>['assembly']['inbox']['admit']>[0] | undefined
  let actualReturn: unknown, closing: Promise<void> | undefined, serviceClosed = false
  let primaryOccurred = false, primary: unknown, cleanupOccurred = false, cleanup: unknown
  const note = (phase: string, detail?: unknown) => { if (trace.length < 256) trace.push({ ordinal: trace.length + 1, phase, detail }); else overflow++ }
  const lead: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
    seen.push(request); note('parent-model', { turn: seen.length }); yield { type: 'text/chunk', text: 'received' }; yield { type: 'end' }
  })
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
    childTurns++; note('child-model', { turn: childTurns }); yield { type: 'text/chunk', text: marker }; yield { type: 'end' }
  })
  const f = await fixture(lead, child, undefined, undefined, (coordinator, backend) => {
    const open = coordinator.openManagedDocument.bind(coordinator)
    coordinator.openManagedDocument = async (...args) => {
      const document = await open(...args)
      if (!documents.has(args[0])) {
        const row = { document, closes: 0 }; documents.set(args[0], row)
        const close = document.close.bind(document)
        document.close = async () => { row.closes++; note('document-close', { id: args[0] }); await close() }
        if (args[0] === 'lead') {
          const registerInputs = document.registerReceivedInputSource.bind(document)
          document.registerReceivedInputSource = (...inputArgs) => {
            const source = registerInputs(...inputArgs), capture = source.captureCancellation.bind(source)
            source.captureCancellation = event => {
              const fact = capture(event); inputCaptures.push({ source, tuple: event, fact }); note('original-cancellation-captured', event); return fact
            }
            return source
          }
          const begin = document.beginAction.bind(document)
          document.beginAction = (...actionArgs) => {
            const action = begin(...actionArgs), id = ++actions
            const queue = action.captureTeamTransaction.bind(action), register = action.registerSettlementSource.bind(action)
            action.captureTeamTransaction = events => { const fact = queue(events); captures.push({ action: id, tuple: events, fact }); return fact }
            action.registerSettlementSource = (...sourceArgs) => {
              const source = register(...sourceArgs), row = { action: id, source, closes: 0, closed: 0 }
              sources.push(row)
              const capture = source.delivery.capture.bind(source.delivery), close = source.close.bind(source)
              source.delivery.capture = event => {
                const fact = capture(event); captures.push({ action: id, source, tuple: event, fact })
                if (event.type === 'team/message/delivered') note('original-ack-captured', { action: id, event })
                return fact
              }
              source.close = async () => { row.closes++; await close(); row.closed++; note('source-closed', { action: id }) }
              return source
            }
            return action
          }
        }
      } else expect(documents.get(args[0])!.document).toBe(document)
      return document
    }
    const append = backend.appendOwnedBatch!
    backend.appendOwnedBatch = async (...args) => {
      const result = await append(...args)
      const batch = decodeFactBatch(args[3].bytes)
      batches.push({ sessionId: args[0], key: args[3].key, bytesBase64: Buffer.from(args[3].bytes).toString('base64'), batch, result })
      if (args[0] === 'lead') note('native-batch-return', { key: args[3].key, result, types: batch.events.map(event => event.type) })
      return result
    }
  })
  const off = subscribe(f.assembly.session, event => {
    if (event.type === 'team/message/delivered') { note('ack-installed', event); acknowledged.resolve() }
    if (event.type === 'agent/input/cancelled') note('input-cancelled', event)
  })
  const offState = f.service.onExecutionState!(state => {
    note('parent-lane', state)
    if (state.sessionId === 'lead' && !state.running && state.queued === 0 && seen.length > 0) parentIdle.resolve()
  })
  const admit = f.assembly.inbox.admit, cancel = f.assembly.inbox.cancel
  const temporary = new Error('original inbox RETURN lost after native commit')
  f.assembly.inbox.admit = async function (...args) {
    const result = await admit.apply(this, args)
    if (args[0].text.includes(marker)) {
      admitCalls++; originalInput = args[0]; actualReturn = result
      const queue = f.assembly.session.events.find(event => event.type === 'team/message/queued' && event.message.content.includes(marker))
      expect(queue?.type).toBe('team/message/queued')
      if (queue?.type !== 'team/message/queued') throw new Error('missing original queue')
      expect(args[0].text).toBe(`Team message <${queue.message.id}> from <helper>:\n${queue.message.content}`)
      expect(f.assembly.session.events.some(event => event.type === 'team/member' && event.member.id === queue.message.senderId && event.member.name === 'helper')).toBe(true)
      expect(args[0].inputId).toBe(`parent-notify-${createHash('sha256').update(args[0].text).update('Team message from helper').digest('hex')}`)
      note('inbox-admit-committed-return-held', { input: args[0], actualReturn: result, receiverIsOriginal: this === f.assembly.inbox })
      admitted.resolve()
      await release.promise
      note('inbox-admit-return-released')
      if (order === 'open-recovery') throw temporary
    }
    return result
  }
  f.assembly.inbox.cancel = function (...args) {
    cancelCalls++
    const row: (typeof cancellations)[number] = { receiver: this, args }
    cancellations.push(row)
    const identity = cancellations.length
    note('actual-inbox-cancel', { identity, receiverIsOriginal: this === f.assembly.inbox, args })
    try {
      const originalPromise = cancel.apply(this, args)
      row.promise = originalPromise
      cancellationObservations.push(originalPromise.then(value => {
        row.outcome = { kind: 'returned', value }; note('actual-inbox-cancel-returned', { identity, value })
      }, error => {
        row.outcome = { kind: 'rejected', error }; note('actual-inbox-cancel-rejected', { identity, error: errorInfo(error) })
      }))
      return originalPromise
    } catch (error) {
      row.outcome = { kind: 'threw', error }; note('actual-inbox-cancel-threw', { identity, error: errorInfo(error) }); throw error
    }
  }
  const heldTools = ['spawn_teammate', 'team_send_message', 'team_followup_task', 'team_task_create'].map(name => {
    const tool = f.assembly.tools.get(name); expect(tool, name).toBeDefined(); return tool!
  })
  try {
    await f.execute('spawn_teammate', { name: 'helper', description: 'text-only actual service qualification', prompt: 'one final', context: 'fresh' })
    await admitted.promise
    const events = f.assembly.session.events
    const queue = events.find(event => event.type === 'team/message/queued' && event.message.content.includes(marker))!
    if (queue.type !== 'team/message/queued') throw new Error('missing matching queued message')
    const messageId = queue.message.id
    const matchingAck = () => events.filter(event => event.type === 'team/message/delivered' && event.messageId === messageId)
    const inputEvents = () => events.filter(event => event.type === 'agent/input/admitted' && event.inputId === originalInput!.inputId)
    const audits = () => events.filter(event => event.type === 'subagent/inbox' && event.messageId === messageId)
    expect(audits()).toHaveLength(1); expect(inputEvents()).toHaveLength(1); expect(matchingAck()).toEqual([])
    expect(f.assembly.inbox.pending().filter(input => input.inputId === originalInput!.inputId)).toHaveLength(1)
    expect([admitCalls, childTurns, seen.length]).toEqual([1, 1, 0])
    const queueCapture = captures.find(capture => Array.isArray(capture.tuple) && capture.tuple.some(event => event.type === 'team/message/queued' && event.message.id === messageId))!
    expect(queueCapture).toBeDefined()
    const originalSources = sources.map(row => row.source)
    const actionsAtGate = actions
    if (order === 'stop-before-return') {
      note('service-close-called'); closing = f.service.close()
      expect(f.service.liveAssembly('lead')).toBeUndefined()
      expect(() => f.assembly.factOwner.beginAction()).toThrow(expect.objectContaining({ code: 'FACT_CLOSED' }))
      const refusalArgs = [
        { name: 'refused', description: 'closed roster probe', prompt: 'must not spawn', context: 'fresh' },
        { target: 'helper', message: 'closed mailbox probe' },
        { target: 'helper', message: 'closed driver probe' },
        { subject: 'closed task probe', description: 'must not create a task' },
      ]
      const refusals = await Promise.allSettled(heldTools.map((tool, index) => Promise.resolve().then(() => tool.execute(refusalArgs[index], { sessionId: 'lead' }))))
      refusals.forEach((refusal, index) => note('optional-refused', { name: heldTools[index]!.name, args: refusalArgs[index], caller: { sessionId: 'lead' }, status: refusal.status, ...(refusal.status === 'rejected' ? { error: errorInfo(refusal.reason) } : { value: refusal.value }) }))
      for (const refusal of refusals) expect(refusal).toMatchObject({ status: 'rejected', reason: { code: 'FACT_CLOSED' } })
      expect(actions).toBe(actionsAtGate); expect(matchingAck()).toEqual([]); expect(seen).toEqual([])
      release.resolve(); await closing; serviceClosed = true; note('service-close-acknowledged')
      expect(events.filter(event => event.type === 'agent/input/cancelled' && event.inputId === originalInput!.inputId)).toHaveLength(1)
      expect(cancelCalls).toBe(1)
      expect(cancellations).toHaveLength(1)
      expect(cancellations[0]!.receiver).toBe(f.assembly.inbox)
      expect(cancellations[0]!.args).toEqual([originalInput!.inputId, 'parent stopped'])
      expect(cancellations[0]!.outcome).toEqual({ kind: 'returned', value: true })
      expect(inputCaptures).toHaveLength(1)
      expect(inputCaptures[0]!.tuple).toEqual({ type: 'agent/input/cancelled', version: 1, inputId: originalInput!.inputId, reason: 'parent stopped' })
      expect(seen).toEqual([]); expect(actions).toBe(actionsAtGate)
    } else {
      release.resolve()
      if (order === 'open-recovery') {
        // First recovery joins the original attempt if its return is still unwinding.
        // A second explicit OPEN recovery may then retry the known queued attempt.
        await f.assembly.drainParentNotifications!()
        await f.assembly.drainParentNotifications!()
      }
      await acknowledged.promise; await parentIdle.promise
      expect(seen).toHaveLength(1); expect(JSON.stringify(seen[0]!.messages)).toContain(marker)
      expect(events.filter(event => event.type === 'user/message' && event.input?.inputId === originalInput!.inputId)).toHaveLength(1)
      expect(events.filter(event => event.type === 'agent/input/cancelled' && event.inputId === originalInput!.inputId)).toEqual([])
      expect(cancelCalls).toBe(0)
      note('service-close-called'); closing = f.service.close(); await closing; serviceClosed = true; note('service-close-acknowledged')
    }
    expect(matchingAck()).toEqual([expect.objectContaining({ teamId: queue.teamId, messageId, targetId: queue.message.targetId })])
    expect([audits().length, inputEvents().length, admitCalls, childTurns]).toEqual([1, 1, 1, 1])
    const originalBatches = batches.filter(batch => batch.sessionId === 'lead')
    const queueBatches = originalBatches.filter(batch => batch.batch.events.some(event => event.type === 'team/message/queued' && event.message.id === messageId))
    const auditBatches = originalBatches.filter(batch => batch.batch.events.some(event => event.type === 'subagent/inbox' && event.messageId === messageId))
    const inputBatches = originalBatches.filter(batch => batch.batch.events.some(event => event.type === 'agent/input/admitted' && event.inputId === originalInput!.inputId))
    const cancelBatches = originalBatches.filter(batch => batch.batch.events.some(event => event.type === 'agent/input/cancelled' && event.inputId === originalInput!.inputId))
    const ackBatches = originalBatches.filter(batch => batch.batch.events.some(event => event.type === 'team/message/delivered' && event.messageId === messageId))
    expect([queueBatches.length, auditBatches.length, inputBatches.length, cancelBatches.length, ackBatches.length]).toEqual([1, 1, 1, order === 'stop-before-return' ? 1 : 0, 1])
    for (const batch of [...queueBatches, ...auditBatches, ...inputBatches, ...cancelBatches, ...ackBatches]) {
      expect(batch.result).toMatchObject({ kind: 'committed', receipt: { key: batch.key, owner: { sessionId: 'lead' } } })
      expect(batch.batch.key).toEqual(batch.key)
    }
    expect(new Set([...queueBatches, ...auditBatches, ...inputBatches, ...cancelBatches, ...ackBatches].map(batch => batch.key.batchId)).size).toBe(order === 'stop-before-return' ? 5 : 4)
    const ackCaptures = captures.filter(capture => (capture.tuple as { type?: string }).type === 'team/message/delivered')
    expect(ackCaptures).toHaveLength(1)
    const teamSource = sources.find(row => row.source === ackCaptures[0]!.source)!
    expect(originalSources).toContain(teamSource.source); expect(teamSource.action).toBeLessThan(queueCapture.action)
    expect(ackCaptures[0]!.source).toBe(teamSource.source)
    expect(ackCaptures[0]!.action).toBe(teamSource.action); expect(ackCaptures[0]!.fact).not.toBe(queueCapture.fact)
    expect(ackCaptures[0]!.tuple).toEqual({ type: 'team/message/delivered', version: 1, teamId: queue.teamId, messageId, targetId: queue.message.targetId })
    expect(teamSource.closed).toBe(1); expect(() => teamSource.source.assertHeld()).toThrow(expect.objectContaining({ code: 'FACT_CLOSED' }))
    expect(f.assembly.inbox.pending()).toEqual([]); expect(f.service.queueState('lead')).toEqual({ running: false, queued: 0 })
    expect(f.assembly.subagentState().agentTable).toEqual([])
    expect(f.assembly.subagentState().roles.some(role => role.name === 'teammate')).toBe(false)
    for (const tool of heldTools) expect(f.assembly.tools.get(tool.name)).not.toBe(tool)
    for (const row of documents.values()) {
      expect(row.closes).toBeGreaterThanOrEqual(1)
      expect(() => row.document.beginAction()).toThrow(expect.objectContaining({ code: 'FACT_CLOSED' }))
    }
    // Probe the real module's released reservation without constructing another owner.
    const reservation = admitTeam({ parentSession: f.assembly.session }); expect(reservation.teamId).toBe(queue.teamId); releaseTeam(reservation.teamId)
    note('cleanup-phases-acknowledged', { source: true, children: documents.size - 1, tools: heldTools.map(tool => tool.name), reservationReleased: true })
    await f.service.close() // acknowledged phases cannot replay callbacks
    expect([admitCalls, childTurns, teamSource.closed]).toEqual([1, 1, 1])
    expect(overflow).toBe(0)
  } catch (error) { primaryOccurred = true; primary = error }
  finally {
    release.resolve()
    try { if (!closing) closing = f.service.close(); await closing; serviceClosed = true; await f.coordinator.close() }
    catch (error) { cleanupOccurred = true; cleanup = error }
    await Promise.all(cancellationObservations)
    off(); offState()
    const evidence = { order, root: f.root, marker, trace, overflow, actions, childTurns, admitCalls, cancelCalls, serviceClosed,
      originalInput, actualReturn, batches,
      captures: captures.map((capture, index) => ({ identity: index + 1, action: capture.action, tuple: capture.tuple, sourceIdentity: capture.source ? sources.findIndex(row => row.source === capture.source) + 1 : undefined })),
      sources: sources.map(({ action, closes, closed }, index) => ({ identity: index + 1, action, closes, closed })),
      documents: [...documents].map(([id, row]) => ({ id, closes: row.closes })),
      inputCaptures: inputCaptures.map((capture, index) => ({ identity: index + 1, tuple: capture.tuple })),
      cancellations: cancellations.map((row, index) => ({ identity: index + 1, receiverIsOriginal: row.receiver === f.assembly.inbox, args: row.args,
        promiseIdentity: row.promise ? cancellations.findIndex(candidate => candidate.promise === row.promise) + 1 : undefined,
        returnedOriginalPromise: row.promise !== undefined, outcome: row.outcome?.kind === 'returned' ? row.outcome : row.outcome ? { kind: row.outcome.kind, error: errorInfo(row.outcome.error) } : undefined })),
      primaryOccurred, primary: errorInfo(primary), cleanupOccurred, cleanup: errorInfo(cleanup), cleanupIsPrimary: primaryOccurred && cleanupOccurred && primary === cleanup }
    console.info('team-ack-owner-order-evidence', JSON.stringify(evidence))
    const evidenceRoot = process.env.IH_STRUCTURE_EVIDENCE_ROOT
    if (evidenceRoot) {
      const destination = join(evidenceRoot, 'task5'); await mkdir(destination, { recursive: true })
      await writeFile(join(destination, `${order}.json`), JSON.stringify(evidence, null, 2))
      for (const id of documents.keys()) await writeFile(join(destination, `${order}-${id}.jsonl`), await readFile(join(f.root, `${id}.jsonl`)))
    }
  }
  if (primaryOccurred && cleanupOccurred) throw new AggregateError([primary, cleanup], 'Qualification and original cleanup failed')
  if (primaryOccurred) throw primary
  if (cleanupOccurred) throw cleanup
}

it('team-ack-owner-order qualifies actual Stop before committed inbox RETURN, then inverse and OPEN recovery', async () => {
  await qualifyServiceOrder('stop-before-return')
  await qualifyServiceOrder('ack-before-stop')
  await qualifyServiceOrder('open-recovery')
})

it("delivers initial and followup teammate finals exactly once to an idle Lead using real service admission", async () => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { seen.push(request); yield { type: "text/chunk", text: "Lead received result" }; yield { type: "end" } })
  let childTurns = 0
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { yield { type: "text/chunk", text: ++childTurns === 1 ? "TEAMMATE_INITIAL_OK" : "TEAMMATE_FOLLOWUP_OK" }; yield { type: "end" } })
  const f = await fixture(lead, child)
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "local fixture", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(JSON.stringify(seen[0]!.messages)).toContain("TEAMMATE_INITIAL_OK")
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    expect((await f.execute("list_members", {}) as { members: { name: string; status: string }[] }).members.find((member) => member.name === "helper")?.status).toBe("idle")
    await f.execute("team_followup_task", { target: "helper", message: "followup" })
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(JSON.stringify(seen[1]!.messages)).toContain("TEAMMATE_FOLLOWUP_OK")
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    const admitted = f.assembly.session.events.filter((event) => event.type === "agent/input/admitted")
    expect(admitted.filter((event) => event.type === "agent/input/admitted" && event.text.includes("TEAMMATE_INITIAL_OK"))).toHaveLength(1)
    expect(admitted.filter((event) => event.type === "agent/input/admitted" && event.text.includes("TEAMMATE_FOLLOWUP_OK"))).toHaveLength(1)
    expect((await f.coordinator.snapshot!("lead")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(2)
    expect(f.assembly.session.events.filter((event) => event.type === "user/message" && event.text.includes("TEAMMATE_")).map((event) => event.type === "user/message" ? event.source : undefined)).toEqual([
      { kind: "plugin", plugin: SYSTEM_INPUT_PLUGIN }, { kind: "plugin", plugin: SYSTEM_INPUT_PLUGIN },
    ])
    const notices = f.assembly.session.events.filter((event) => event.type === "user/message" && event.text.includes("TEAMMATE_"))
    expect(notices.map((event) => event.type === "user/message" ? event.input?.inputId : undefined)).toEqual(admitted.map((event) => event.type === "agent/input/admitted" ? event.inputId : undefined))
    for (const event of notices) expect(event).toMatchObject({ input: { intent: "system", synthetic: { description: "Team message from helper", scope: "turn" } } })
    expect(notices.map((event) => event.type === "user/message" ? event.input?.synthetic : undefined)).toEqual([
      expect.objectContaining({ display: { kind: "team-result", title: "Team reply ended: helper", body: "TEAMMATE_INITIAL_OK" } }),
      expect.objectContaining({ display: { kind: "team-result", title: "Team reply ended: helper", body: "TEAMMATE_FOLLOWUP_OK" } }),
    ])
    const durable = (await f.coordinator.snapshot!("lead")).session.events.filter((event) => event.type === "user/message" && event.text.includes("TEAMMATE_"))
    expect(durable).toEqual(notices)
  } finally { await f.close() }
})

it("shipping teammate completion waits for strict owned retention and bounds its framed model notice", async () => {
  const output = "TEAM_BARRIER " + '中文🙂"\n'.repeat(12000)
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { yield { type: "text/chunk", text: output }; yield { type: "end" } })
  const lead: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { yield { type: "text/chunk", text: "received" }; yield { type: "end" } })
  const notices: string[] = [], notice = Promise.withResolvers<void>(), retaining = Promise.withResolvers<void>()
  const f = await fixture(lead, child, { admit: async input => { notices.push(input.text); notice.resolve() }, wake: () => {} })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const strict = f.coordinator.putDocumentStrict!.bind(f.coordinator)
  let retained = false, snapshot: unknown
  f.coordinator.putDocumentStrict = async (key, data) => {
    await strict(key, data)
    if (key === "lead" && JSON.stringify(data).includes("TEAM_BARRIER")) { snapshot = data; retained = true; retaining.resolve(); await held }
  }
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "large result", prompt: "first", context: "fresh" })
    await retaining.promise
    const job = f.assembly.subagentState().jobs.find(job => job.output.startsWith('TEAM_BARRIER'))!
    expect(job).toMatchObject({ status: 'completed' }); expect(output.startsWith(job.output)).toBe(true)
    expect(job.output.length).toBeLessThan(output.length)
    expect(notices).toHaveLength(0)
    release()
    await notice.promise; expect(notices).toHaveLength(1)
    expect(retained).toBe(true)
    expect(Buffer.byteLength(notices[0]!, "utf8")).toBeLessThanOrEqual(16384)
    expect(Buffer.byteLength(JSON.stringify(notices[0]))).toBeLessThanOrEqual(16384)
    expect(notices[0]).toContain(job.output); expect(notices[0]).toContain('[Result retention: durable]')
    const result = await readRetainedJobBody(f, job.id, 'retention-barrier-body')
    expect(result.body.resultText).toBe(output)
    expect(f.assembly.subagentState().jobs.find(row => row.id === job.id)?.status).toBe("completed")
    await completionEvidence('retention-barrier', { root: f.root, snapshot, notices, retained })
  } finally { release(); await f.close() }
})

it("shipping teammate retention failure keeps the real completed result inspectable and suppresses admission", async () => {
  let turns = 0, admissions = 0
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { turns++; yield { type: "text/chunk", text: "TEAM_RETENTION_FAILED completed effect" }; yield { type: "end" } })
  const lead: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { yield { type: "end" } })
  const f = await fixture(lead, child, { admit: async () => { admissions++ }, wake: () => {} })
  const strict = f.coordinator.putDocumentStrict!.bind(f.coordinator)
  const diskFull = new Error('team result disk full')
  f.coordinator.putDocumentStrict = async (key, data) => {
    if (key === "lead" && JSON.stringify(data).includes("TEAM_RETENTION_FAILED")) throw diskFull
    await strict(key, data)
  }
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "controlled result", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(f.assembly.subagentState().agentTable[0]).toMatchObject({ retention: "failed", retentionError: "team result disk full" }))
    expect(admissions).toBe(0); expect(turns).toBe(1)
    expect(f.assembly.subagentState().jobs[0]).toMatchObject({ status: "completed", output: "TEAM_RETENTION_FAILED completed effect" })
    const job = await f.execute("job_output", { job_id: f.assembly.subagentState().jobs[0]!.id }) as any
    expect(job).toMatchObject({ status: "completed", text: "TEAM_RETENTION_FAILED completed effect", retention: "failed", retention_error: "team result disk full" })
  } finally {
    const close = await Promise.allSettled([f.service.close()])
    expect(close[0]!.status).toBe('rejected')
    if (close[0]!.status !== 'rejected') throw new Error('missing original retention failure at close')
    const leaves = aggregateLeaves(close[0]!.reason)
    expect(leaves).toHaveLength(1); expect(leaves[0]).toBe(diskFull)
    await completionEvidence('retention-failure-close', { root: f.root, error: boundedError(close[0]!.reason), exactOriginalLeaf: leaves[0] === diskFull, turns, admissions })
    await expect(f.service.close()).resolves.toBeUndefined()
    expect([turns, admissions]).toEqual([1, 0])
    expect(f.assembly.subagentState().agentTable).toEqual([])
    await f.close()
  }
})

it.each(["R".repeat(65_536), "結果😀".repeat(8_000)])("delivers an oversized UTF-8 result summary and retains the full job output (%#)", async (output) => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { seen.push(request); yield { type: "text/chunk", text: "Lead received summary" }; yield { type: "end" } })
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { yield { type: "text/chunk", text: output }; yield { type: "end" } })
  const f = await fixture(lead, child)
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "large result", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    const notification = f.assembly.session.events.find((event) => event.type === "agent/input/admitted")
    expect(notification?.type).toBe("agent/input/admitted")
    if (notification?.type !== "agent/input/admitted") throw new Error("missing notification")
    expect(Buffer.byteLength(notification.text, "utf8")).toBeLessThanOrEqual(65_536)
    const job = f.assembly.subagentState().jobs[0]!
    expect(job.status).toBe('completed'); expect(output.startsWith(job.output)).toBe(true)
    expect(job.output.length).toBeLessThan(output.length)
    expect(notification.text).toContain(job.output); expect(notification.text).not.toContain(output)
    expect(notification.text).toContain('[Result retention: durable]')
    expect(notification.text).not.toContain("\uFFFD")
    const result = await readRetainedJobBody(f, job.id, `oversized-body-${output.startsWith('R') ? 'ascii' : 'utf8'}`)
    expect(result.body.resultText).toBe(output)
  } finally { await f.close() }
})

it("retries durable Lead messages after publishing the cold assembly and does not deliver them twice", async () => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { seen.push(request); yield { type: "text/chunk", text: "Recovered Lead message" }; yield { type: "end" } })
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { throw new Error("recovery must not start a child"); yield { type: "end" } })
  const f = await fixture(lead, child, undefined, [{ type: "team/message/queued", version: 1, seq: 0, teamId: "lead-cold", message: { id: "msg-cold", senderId: "child-old", senderName: "helper", targetId: "lead-cold", delivery: "quiet", content: "COLD_TEAM_RESULT" } }])
  try {
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(JSON.stringify(seen[0]!.messages)).toContain("COLD_TEAM_RESULT")
    await f.service.assemblyFor("lead")
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    expect(seen).toHaveLength(1)
    expect(f.assembly.session.events.filter((event) => event.type === "agent/input/admitted" && event.text.includes("COLD_TEAM_RESULT"))).toHaveLength(1)
    expect(f.assembly.session.events.find((event) => event.type === "user/message" && event.text.includes("COLD_TEAM_RESULT"))).toMatchObject({ input: { intent: "system", synthetic: { description: "Team message from helper", scope: "turn" } } })
    expect(f.assembly.session.events.find((event) => event.type === "user/message" && event.text.includes("COLD_TEAM_RESULT"))).toMatchObject({
      input: { synthetic: { display: { kind: "team-message", title: "Team message from helper", body: "COLD_TEAM_RESULT" } } },
    })
    expect(f.assembly.session.events.filter((event) => event.type === "subagent/inbox" && event.messageId === "msg-cold")).toHaveLength(1)
    expect((await f.coordinator.snapshot!("lead")).session.events.filter((event) => event.type === "team/message/delivered" && event.messageId === "msg-cold")).toHaveLength(1)
  } finally { await f.close() }
})

it("preserves an explicitly supplied parent admission adapter", async () => {
  const lead: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { throw new Error("explicit adapter owns waking"); yield { type: "end" } })
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { yield { type: "text/chunk", text: "EXPLICIT_RESULT" }; yield { type: "end" } })
  const parentNotify = { admit: vi.fn(async () => {}), wake: vi.fn() }
  const f = await fixture(lead, child, parentNotify)
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "custom adapter", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(parentNotify.admit).toHaveBeenCalledTimes(1))
    expect(parentNotify.admit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "lead", text: expect.stringContaining("EXPLICIT_RESULT") }))
    expect(parentNotify.wake).toHaveBeenCalledWith("lead")
    expect(f.assembly.inbox.pending()).toEqual([])
  } finally { await f.close() }
})

it("keeps a teammate error readable using its actual job error", async () => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { seen.push(request); yield { type: "text/chunk", text: "Lead received error" }; yield { type: "end" } })
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { throw new Error("provider disconnected"); yield { type: "end" } })
  const f = await fixture(lead, child)
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "error fixture", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    expect(f.assembly.session.events.find((event) => event.type === "user/message" && event.text.includes("provider disconnected"))).toMatchObject({
      input: { synthetic: { display: { kind: "team-result", title: "Team reply error: helper", body: "model stream error: provider disconnected" } } },
    })
    expect(JSON.stringify(seen[0]!.messages)).toContain("provider disconnected")
  } finally { await f.close() }
})

it("restores a queued result presentation without sending presentation fields to the model", async () => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { seen.push(request); yield { type: "text/chunk", text: "Received" }; yield { type: "end" } })
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { throw new Error("must not wake child"); yield { type: "end" } })
  const seed = [{ type: "team/message/queued", version: 1, seq: 0, teamId: "lead-cold", message: {
    id: "msg-result", senderId: "child-old", senderName: "helper", targetId: "lead-cold", delivery: "quiet", content: "COLD_RAW_RESULT",
    display: { kind: "team-result", title: "Team reply ended: helper", body: "Read tool failed: missing file" },
  } }] as unknown as SessionEvent[]
  const f = await fixture(lead, child, undefined, seed)
  try {
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    const notice = f.assembly.session.events.find((event) => event.type === "user/message" && event.text.includes("COLD_RAW_RESULT"))
    expect(notice).toMatchObject({ input: { synthetic: { display: { kind: "team-result", title: "Team reply ended: helper", body: "Read tool failed: missing file" } } } })
    expect(JSON.stringify(seen[0]!.messages)).toContain("COLD_RAW_RESULT")
    expect(JSON.stringify(seen[0]!.messages)).not.toContain("Read tool failed")
    await f.assembly.drainParentNotifications?.()
    expect(f.assembly.session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(1)
    expect((await f.coordinator.snapshot!("lead")).session.events.find((event) => event.type === "user/message" && event.text.includes("COLD_RAW_RESULT"))).toEqual(notice)
  } finally { await f.close() }
})

it("does not reawaken a disposed Lead when a child finishes during service close", async () => {
  let release!: () => void
  const held = new Promise<void>((done) => { release = done })
  const seen: LLMRequest[] = []
  const lead: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { seen.push(request); yield { type: "text/chunk", text: "unexpected wake" }; yield { type: "end" } })
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { await held; yield { type: "text/chunk", text: "AFTER_CLOSE" }; yield { type: "end" } })
  const f = await fixture(lead, child)
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "close fixture", prompt: "first", context: "fresh" })
    const closing = f.service.close()
    release()
    await closing
    expect(seen).toEqual([])
    expect(f.assembly.session.events.filter((event) => event.type === "agent/input/admitted")).toEqual([])
  } finally { release(); await f.close() }
})

it("feeds a busy Lead at its next step and suppresses late completions after cancellation", async () => {
  let releaseLead!: () => void
  const holdLead = new Promise<void>((done) => { releaseLead = done })
  const seen: LLMRequest[] = []
  const lead: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
    seen.push(request)
    if (seen.length === 1) { await holdLead; yield { type: "tool_call", call: { id: "next", name: "continue", args: {} } } }
    else {
      if (seen.length >= 3) await new Promise<void>((done) => { if (request.signal?.aborted) done(); else request.signal?.addEventListener("abort", () => done(), { once: true }) })
      yield { type: "text/chunk", text: "Lead received result" }
    }
    yield { type: "end" }
  })
  let releaseChild!: () => void
  const holdChild = new Promise<void>((done) => { releaseChild = done })
  let turns = 0
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { if (++turns > 1) await holdChild; yield { type: "text/chunk", text: turns === 1 ? "BUSY_RESULT_OK" : "CANCELLED_LATE_RESULT" }; yield { type: "end" } })
  const f = await fixture(lead, child)
  try {
    const run = f.service.submit("lead", "lead task", new AbortController().signal)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await f.execute("spawn_teammate", { name: "helper", description: "busy fixture", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(f.assembly.inbox.pending().some((input) => input.text.includes("BUSY_RESULT_OK"))).toBe(true))
    releaseLead(); await run
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    expect(seen).toHaveLength(2)
    expect(JSON.stringify(seen[1]!.messages)).toContain("BUSY_RESULT_OK")
    expect(f.assembly.session.events.find((event) => event.type === "user/message" && event.text === "lead task")).toEqual(expect.not.objectContaining({ source: expect.anything() }))
    const cancelled = f.service.submit("lead", "cancel this turn", new AbortController().signal)
    const cancelledResult = cancelled.catch(() => {})
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    await f.execute("team_followup_task", { target: "helper", message: "delayed followup" })
    expect(f.service.cancelRunning?.("lead").cancelled).toBe(true)
    await cancelledResult
    await f.service.submit("lead", "an already cancelled input must not resume notifications", AbortSignal.abort())
    const before = seen.length
    releaseChild()
    await vi.waitFor(() => expect(f.assembly.session.events.some((event) => event.type === "team/message/queued" && event.message.content.includes("CANCELLED_LATE_RESULT"))).toBe(true))
    expect(f.assembly.inbox.pending().some((input) => input.text.includes("CANCELLED_LATE_RESULT"))).toBe(false)
    expect(seen).toHaveLength(before)
    const late = f.assembly.session.events.find((event) => event.type === "team/message/queued" && event.message.content.includes("CANCELLED_LATE_RESULT"))
    await vi.waitFor(() => expect(f.assembly.session.events.some((event) => event.type === "team/message/delivered" && late?.type === "team/message/queued" && event.messageId === late.message.id)).toBe(true))
    await f.service.close(); await f.coordinator.close()
    await assertColdDoesNotWake(f.root, "CANCELLED_LATE_RESULT")
  } finally { releaseLead(); releaseChild(); await f.close() }
})

it("cancels an admitted notification if Stop arrives during its persistence flush and prevents restart delivery", async () => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
    seen.push(request)
    await new Promise<void>((done) => { if (request.signal?.aborted) done(); else request.signal?.addEventListener("abort", () => done(), { once: true }) })
    yield { type: "end" }
  })
  const child: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { yield { type: "text/chunk", text: "STOP_DURING_FLUSH" }; yield { type: "end" } })
  const f = await fixture(lead, child)
  let release!: () => void
  const held = new Promise<void>((done) => { release = done })
  let flushing = false
  const originalAppend = f.backend.appendOwnedBatch!
  f.backend.appendOwnedBatch = async (...args) => {
    if (!flushing && args[0] === 'lead' && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted' && event.text.includes('STOP_DURING_FLUSH'))) { flushing = true; await held }
    return originalAppend(...args)
  }
  try {
    const run = f.service.submit("lead", "active parent", new AbortController().signal).catch(() => {})
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await f.execute("spawn_teammate", { name: "helper", description: "flush fixture", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(flushing).toBe(true))
    expect(f.service.cancelRunning?.("lead").cancelled).toBe(true)
    expect(seen).toHaveLength(1)
    release()
    await run
    await vi.waitFor(() => expect(f.assembly.inbox.pending().some((input) => input.text.includes("STOP_DURING_FLUSH"))).toBe(false))
    const notification = f.assembly.session.events.find((event) => event.type === "agent/input/admitted" && event.text.includes("STOP_DURING_FLUSH"))
    expect(f.assembly.session.events.some((event) => event.type === "agent/input/cancelled" && notification?.type === "agent/input/admitted" && event.inputId === notification.inputId)).toBe(true)
    await vi.waitFor(() => expect(f.assembly.session.events.some((event) => event.type === "team/message/delivered")).toBe(true))
    expect(seen).toHaveLength(1)
    await f.service.close(); await f.coordinator.close()
    await assertColdDoesNotWake(f.root, "STOP_DURING_FLUSH")
  } finally { release(); await f.close() }
})
