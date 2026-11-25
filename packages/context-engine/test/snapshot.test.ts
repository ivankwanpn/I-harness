import { expect, it, vi } from "vitest"
import { append, createManagedSessionState, createSession, CURRENT_FORMAT_VERSION, renderConversation, type ConversationProjection, type Session, type SessionEvent } from "@i-harness/core-session"
import { captureContextPayload, captureContextSnapshot, readContextCoordinates, readManagedContextSnapshotIdentity } from "../src/index.ts"
import { contextRevision, semanticContextRevision } from "../src/snapshot/revision.ts"
import type { ModelBudgetBinding } from "@i-harness/llm-seam"

it('reuses only the original managed frontier and reads each live surface', () => {
  const session = createSession()
  append(session, { type: 'user/message', text: 'original context' })
  const managed = createManagedSessionState(session, { sessionId: 'owner' })
  const input = { ownerSessionId: 'owner', surface: { systemPrompt: 'first instructions', tools: [] } }
  expect(readManagedContextSnapshotIdentity(session, input)).toBeUndefined()
  expect(readManagedContextSnapshotIdentity(managed.view, input)).toBeUndefined()
  managed.bindOwner({})

  const first = captureContextSnapshot(managed.view, input)
  if (first.kind !== 'captured') throw new Error('Original snapshot required')
  expect(readManagedContextSnapshotIdentity(managed.view, { ...input, ownerSessionId: 'other' })).toBeUndefined()
  const updated = readManagedContextSnapshotIdentity(managed.view, { ...input, surface: { ...input.surface, systemPrompt: 'new instructions' } })
  if (updated?.kind !== 'captured') throw new Error('Original identity required')
  expect(updated.identity.coordinates).toBe(first.snapshot.coordinates)
  expect(updated.identity.surfaceRevision).not.toBe(first.snapshot.surfaceRevision)

  const stringify = JSON.stringify
  const replacement = vi.spyOn(JSON, 'stringify').mockImplementation((...args) => Reflect.apply(stringify, JSON, args))
  try {
    expect(readManagedContextSnapshotIdentity(managed.view, input)).toBeUndefined()
    const ordinary = readContextCoordinates(managed.view, input)
    if (ordinary.kind !== 'available') throw new Error('Ordinary coordinates required')
    expect(ordinary.coordinates).not.toBe(first.snapshot.coordinates)
    expect(ordinary.coordinates).toEqual(first.snapshot.coordinates)
  } finally { replacement.mockRestore() }

  const pending = managed.stage([{ type: 'plan/mode', mode: 'on', seq: 1 }])
  const before = readContextCoordinates(managed.view, input)
  if (before.kind !== 'available') throw new Error('Original coordinates required')
  expect(before.coordinates).toBe(first.snapshot.coordinates)
  pending.install()
  const after = readManagedContextSnapshotIdentity(managed.view, input)
  const expected = captureContextSnapshot(managed.view, input)
  if (after?.kind !== 'captured' || expected.kind !== 'captured') throw new Error('Installed snapshot required')
  expect(after.identity.coordinates).not.toBe(first.snapshot.coordinates)
  expect(after.identity.coordinates).toEqual(expected.snapshot.coordinates)
  expect(after.identity.coordinates.archive.eventCount).toBe(first.snapshot.coordinates.archive.eventCount + 1)
  expect(after.identity.surfaceRevision).toBe(expected.snapshot.surfaceRevision)
})

it('requires the same encoding proof for cached coordinates and a full capture', () => {
  const managed = createManagedSessionState({ formatVersion: CURRENT_FORMAT_VERSION, events: [
    { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 0 },
    { type: 'step/start', actionId: 'action', attemptId: 'attempt', seq: 1 },
    { type: 'assistant/message', text: 'complete reply', seq: 2 },
    { type: 'model/exchange-accepted', version: 1, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt',
      stepStartSeq: 1, assistantSeq: 2, callSeqs: [], seq: 3 },
    { type: 'step/end', seq: 4 },
  ] }, { sessionId: 'owner' })
  managed.bindOwner({})
  const input = { ownerSessionId: 'owner', surface: { systemPrompt: 'instructions', tools: [] } }
  const original = captureContextSnapshot(managed.view, input)
  if (original.kind !== 'captured') throw Error('Expected original snapshot')
  expect(readManagedContextSnapshotIdentity(managed.view, input)).toMatchObject({ kind: 'captured' })

  const encode = TextEncoder.prototype.encode
  try {
    TextEncoder.prototype.encode = function(value?: string) {
      if (value?.includes('model/exchange-accepted')) return new Uint8Array(4097)
      return encode.call(this, value)
    }
    const rejected = captureContextSnapshot(managed.view, input)
    expect(rejected.kind).toBe('unsupported')
    expect(readManagedContextSnapshotIdentity(managed.view, input)).toBeUndefined()
    expect(readContextCoordinates(managed.view, input)).toEqual(rejected)
  } finally { TextEncoder.prototype.encode = encode }
  const restored = readManagedContextSnapshotIdentity(managed.view, input)
  if (restored?.kind !== 'captured') throw Error('Expected restored snapshot identity')
  expect(restored.identity.coordinates).toBe(original.snapshot.coordinates)
})

it('recaptures mutable data nested in an installed shallow-frozen event', () => {
  const managed = createManagedSessionState(createSession(), { sessionId: 'owner' })
  managed.bindOwner({})
  const provenance: NonNullable<Extract<SessionEvent, { type: 'user/message' }>['provenance']> = {
    kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture',
  }
  managed.stage([{ type: 'user/message', text: 'request', seq: 0,
    input: Object.freeze({ inputId: 'user-input', intent: 'user', provenance }) }]).install()
  const input = { ownerSessionId: 'owner', surface: { systemPrompt: 'instructions', tools: [] } }
  const original = captureContextSnapshot(managed.view, input)
  if (original.kind !== 'captured') throw Error('Expected full snapshot')
  provenance.scope = 'session'

  expect(readManagedContextSnapshotIdentity(managed.view, input)).toBeUndefined()
  const current = readContextCoordinates(managed.view, input)
  const expected = captureContextSnapshot(managed.view, input)
  if (current.kind !== 'available' || expected.kind !== 'captured') throw Error('Expected current coordinates')
  expect(current.coordinates).toEqual(expected.snapshot.coordinates)
  expect(current.coordinates.semanticRevision).not.toBe(original.snapshot.coordinates.semanticRevision)
})

it('advances archive coordinates across a managed audit append and still checks current content and surface', () => {
  const session = createSession()
  append(session, { type: 'user/message', text: 'original context', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  append(session, { type: 'context/action', version: 1, op: 'open', ownerSessionId: 'owner', actionId: 'generation',
    purpose: 'main', origin: { kind: 'input', seq: 0 }, startedAt: 100, expiresAt: 3_600_100, trustedAt: 100 })
  const managed = createManagedSessionState(session, { sessionId: 'owner' })
  managed.bindOwner({})
  const input = { ownerSessionId: 'owner', surface: { systemPrompt: 'first instructions', tools: [] } }
  const first = captureContextSnapshot(managed.view, input)
  if (first.kind !== 'captured') throw new Error('Original snapshot required')

  const digest = 'a'.repeat(64)
  managed.stage([
    { type: 'context/action', version: 1, op: 'bind', executionDomain: 'physical', ownerSessionId: 'owner',
      actionId: 'generation', retry: { mode: 'normal', maxRetries: 5 }, limits: { total: 20, main: 6, recovery: 6, summary: 8 }, trustedAt: 100, seq: 2 },
    { type: 'context/attempt', version: 1, op: 'reserve', ownerSessionId: 'owner', actionId: 'generation',
      attemptId: 'physical-1', ordinal: 1, lane: 'main', cause: 'initial', incarnation: 'owner-1',
      semanticId: digest, payloadId: digest, payloadKind: 'http-json-body', trustedAt: 100, seq: 3 },
  ]).install()
  const changed = { ...input, surface: { ...input.surface, systemPrompt: 'updated instructions' } }
  const advanced = readManagedContextSnapshotIdentity(managed.view, changed)
  const expected = captureContextSnapshot(managed.view, changed)
  if (advanced?.kind !== 'captured' || expected.kind !== 'captured') throw new Error('Advanced snapshot required')
  expect(advanced.identity.coordinates).toEqual({ ...first.snapshot.coordinates, archive: { eventCount: 4, lastSeq: 3 } })
  expect(advanced.identity.coordinates).toEqual(expected.snapshot.coordinates)
  expect(advanced.identity.surfaceRevision).toBe(expected.snapshot.surfaceRevision)
  expect(advanced.identity.surfaceRevision).not.toBe(first.snapshot.surfaceRevision)

  managed.stage([{ type: 'assistant/message', text: 'different content', seq: 4 }]).install()
  const next = readManagedContextSnapshotIdentity(managed.view, changed)
  const nextFull = captureContextSnapshot(managed.view, changed)
  if (next?.kind !== 'captured' || nextFull.kind !== 'captured') throw new Error('Current snapshot required')
  expect(next.identity.coordinates).toEqual(nextFull.snapshot.coordinates)
  expect(next.identity.coordinates.semanticRevision).not.toBe(advanced.identity.coordinates.semanticRevision)
})

it('keeps the semantic v1 digest for sealed projections with Unicode and omitted optional fields', () => {
  const owner = 'owner-香港-\uD800'
  const call = { id: 'call-🐟', eventIndex: 1, seq: 1, part: 'call', addressable: true }
  const dispatch = { id: 'audit-dispatch', eventIndex: 2, seq: 2, part: 'dispatch', addressable: true }
  const provenance = { kind: 'model', authority: 'observation', scope: 'turn', evidence: [call] } as const
  const messages = [{ role: 'assistant', content: '字\n🧭\uDC00' }] as const
  const conversation = {
    version: 1, archiveEventCount: 3, items: [{ id: 'exchange-1', kind: 'exchange', sources: [call, dispatch], provenance, messages,
      exchange: { id: 'exchange-1', state: 'unresolved', acceptance: 'explicit', calls: [{ name: '讀取', callId: 'c', outcome: 'pending', call, dispatch }] } }],
    diagnostics: [],
  } satisfies ConversationProjection
  const expected = contextRevision('semantic', [owner, [{
    id: 'exchange-1', kind: 'exchange', messages, provenance, sources: [call],
    exchange: { id: 'exchange-1', acceptance: 'explicit', calls: [{ name: '讀取', callId: 'c', call }] },
  }]])

  expect(semanticContextRevision(owner, conversation)).toBe(expected)
  expect(semanticContextRevision(owner, captureContextPayload(conversation))).toBe(expected)
  call.seq = -0
  expect(() => semanticContextRevision(owner, conversation)).toThrow('CONTEXT_SNAPSHOT_UNSUPPORTED')
})

it('owns physical unit DTOs without exposing private membership or changing source events', () => {
  const session = createSession()
  append(session, { type: 'step/start' }); append(session, { type: 'user/message', text: 'H' }); append(session, { type: 'step/end' })
  const raw = JSON.stringify(session)
  const result = captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: 's', tools: [] } })
  if (result.kind !== 'captured') throw Error('capture required')
  const unit = result.snapshot.conversation.items[0]?.unit
  expect(unit).toEqual({ source: { id: '["owner",0,"step"]', eventIndex: 0, seq: 0, part: 'step', addressable: true }, state: 'closed' })
  expect(Object.keys(unit!).sort()).toEqual(['source', 'state'])
  expect(Object.isFrozen(unit)).toBe(true)
  expect(Object.isFrozen(unit?.source)).toBe(true)
  expect(renderConversation(result.snapshot.conversation)).toEqual([{ role: 'user', content: 'H' }])
  expect(JSON.stringify(session)).toBe(raw)
  expect(Object.isFrozen(session.events[0])).toBe(false)
})

it('captures positional summary order, manifest identity and unchanged operational-only semantics', () => {
  const session: Session = { formatVersion: 7, events: [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H' },
    { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E' }, { type: 'step/end', seq: 4 },
    { type: 'step/start', seq: 5 }, { type: 'assistant/message', seq: 6, text: 'tail' }, { type: 'step/end', seq: 7 },
  ] }
  const input = { ownerSessionId: 'owner', surface: { systemPrompt: 's', tools: [] } }
  const before = captureContextSnapshot(session, input)
  session.events.push({ type: 'compaction/replacement', version: 1, seq: 8, replacementId: 'r', text: 'S',
    coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }],
    insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } })
  const after = captureContextSnapshot(session, input)
  if (before.kind !== 'captured' || after.kind !== 'captured') throw Error('captured snapshot required')
  expect(renderConversation(after.snapshot.conversation).map(message => message.content)).toEqual(['H', 'S', 'tail'])
  expect(after.snapshot.coordinates.contextEpoch).not.toBe(before.snapshot.coordinates.contextEpoch)
  expect(after.snapshot.conversation.items[1]!.provenance).toMatchObject({ kind: 'summary', authority: 'derived' })
  const record = session.events[8]
  if (record?.type !== 'compaction/replacement') throw Error('replacement required')
  session.events[8] = { ...record, replacementId: 'different-manifest-id' }
  const changed = captureContextSnapshot(session, input)
  if (changed.kind !== 'captured') throw Error('captured snapshot required')
  expect(changed.snapshot.coordinates.semanticRevision).not.toBe(after.snapshot.coordinates.semanticRevision)
  append(session, { type: 'operator/run-end', version: 1, runId: 'audit', exitCode: 0, durationMs: 1, phase: 'session' })
  const audit = captureContextSnapshot(session, input)
  if (audit.kind !== 'captured') throw Error('captured snapshot required')
  expect(audit.snapshot.coordinates.semanticRevision).toBe(changed.snapshot.coordinates.semanticRevision)
  expect(audit.snapshot.coordinates.contextEpoch).toBe(changed.snapshot.coordinates.contextEpoch)
  expect(Object.isFrozen(after.snapshot.conversation.items[1]!.replacement?.coverage)).toBe(true)
})

it("owns nested model evidence and changes the surface digest when only provenance changes", () => {
  const budgetBinding: ModelBudgetBinding = { version: 1, metadata: { version: 1, modelId: "m", protocol: "gemini", identityCoverage: "partial" },
    limits: { contextTokens: { value: 1000, origin: "profile", sourceId: "profile-v1" } }, generation: { origin: "unspecified" },
    capability: { version: 1, route: "gemini", evidenceId: "adapter-budget-v1:gemini", outputParameter: "optional", packetKind: "http-json-body" } }
  const session = createSession(), surface = { systemPrompt: "p", tools: [], budgetBinding }
  const first = captureContextSnapshot(session, { ownerSessionId: "owner", surface })
  if (first.kind !== "captured") throw new Error("capture required")
  ;(budgetBinding.limits.contextTokens as { sourceId: string }).sourceId = "profile-revised-v1"
  const second = captureContextSnapshot(session, { ownerSessionId: "owner", surface })
  if (second.kind !== "captured") throw new Error("capture required")
  expect(first.snapshot.surface.budgetBinding?.limits.contextTokens).toEqual({ value: 1000, origin: "profile", sourceId: "profile-v1" })
  expect(Object.isFrozen(first.snapshot.surface.budgetBinding?.limits.contextTokens)).toBe(true)
  expect(Object.isFrozen(budgetBinding.limits.contextTokens)).toBe(false)
  expect(second.snapshot.surfaceRevision).not.toBe(first.snapshot.surfaceRevision)
})

it("publishes a detached recursively immutable request and fresh renderer copies", () => {
  const session = createSession()
  const args = { nested: { x: [1, 2] } }
  const thinking = [{ type: "thinking" as const, thinking: "reason", signature: "signature" }]
  const native = { kind: "anthropic" as const, model: "m", contentOrder: [{ kind: "text" as const, text: "answer" }] }
  const image = { mediaType: "image/png" as const, dataBase64: "aGVsbG8=" }
  append(session, { type: "user/message", text: "task", images: [image] })
  append(session, { type: "tool/call", callId: "c", name: "probe", args })
  append(session, { type: "assistant/message", text: "answer", thinkingBlocks: thinking, providerContinuation: native })
  append(session, { type: "tool/result", callId: "c", name: "probe", output: { ok: true } })
  const schema = { name: "probe", description: "probe", inputSchema: { nested: { value: 1 } } }
  const result = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [schema] } })
  expect(result.kind).toBe("captured")
  if (result.kind !== "captured") throw new Error("capture required")
  const snapshot = result.snapshot
  const before = JSON.stringify(snapshot)
  args.nested.x.push(3); thinking[0]!.signature = "changed"; native.contentOrder[0]!.text = "changed"; image.dataBase64 = "changed"; schema.inputSchema.nested.value = 2
  const rendered = renderConversation(snapshot.conversation)
  const assistant = rendered.find(message => message.role === "assistant" && message.toolCalls?.length)
  if (assistant?.role === "assistant") {
    (assistant.toolCalls![0]!.args as { nested: { x: number[] } }).nested.x.push(9)
    if (assistant.thinkingBlocks?.[0]?.type === "thinking") assistant.thinkingBlocks[0].signature = "adapter signature"
  }
  rendered[0]!.content = "adapter changed"
  expect(JSON.stringify(snapshot)).toBe(before)
  expect(Object.isFrozen(snapshot.surface.tools[0]!.inputSchema)).toBe(true)
  expect(Object.isFrozen(args)).toBe(false)
  expect(Object.isFrozen(session.events)).toBe(false)
})

it.each(["args", "output", "native", "images", "outcome"])("rejects an accessor in visible %s without invoking it", field => {
  const session = createSession()
  let reads = 0
  const value = Object.defineProperty({}, field === "outcome" ? "code" : "secret", { enumerable: true, get() { reads++; return "private" } })
  append(session, { type: "tool/call", callId: "c", name: "probe", args: field === "args" ? value : {} })
  append(session, { type: "assistant/message", text: "answer", ...(field === "native" ? { providerContinuation: value as never } : {}) })
  session.events.push({ seq: session.events.length, type: "tool/result", callId: "c", name: "probe", ...(field === "outcome" ? { isError: true } : {}), output: field === "output" || field === "outcome" ? value : field === "images" ? { images: value } : "ok" })
  const result = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [] } })
  expect(result).toMatchObject({ kind: "unsupported", code: "CONTEXT_SNAPSHOT_UNSUPPORTED", component: "conversation" })
  expect(reads).toBe(0)
  expect(JSON.stringify(result)).not.toMatch(/secret|private/)
})

it("does not inspect suppressed failed payloads or pruned raw output", () => {
  const session = createSession()
  let reads = 0
  const raw = Object.defineProperty({}, "private", { enumerable: true, get() { reads++; throw Error("executed") } })
  append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: "failed", name: "probe", args: raw }); append(session, { type: "step/failed" })
  append(session, { type: "tool/call", callId: "pruned", name: "probe", args: {} })
  append(session, { type: "tool/result", callId: "pruned", name: "probe", output: raw })
  append(session, { type: "compaction/prune", version: 1, pruned: [{ callId: "pruned", head: "head", tail: "tail", removedBytes: 20 }] })
  expect(captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [] } }).kind).toBe("captured")
  expect(reads).toBe(0)
})

it("captures and renders deeply nested JSON args without a recursive walk overflow", () => {
  const session = createSession()
  let args: unknown = { leaf: "retained" }
  for (let i = 0; i < 6000; i++) args = { child: args }
  append(session, { type: "tool/call", callId: "deep", name: "probe", args })
  append(session, { type: "tool/result", callId: "deep", name: "probe", output: "ok" })
  const result = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "s", tools: [] } })
  expect(result.kind).toBe("captured")
  if (result.kind !== "captured") throw Error("capture required")
  const rendered = renderConversation(result.snapshot.conversation)
  expect(rendered[0]?.role).toBe("assistant")
})
