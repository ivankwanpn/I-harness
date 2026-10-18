import { expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, projectConversation, Inbox } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgent } from "../src/index.ts"
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { decodeFactBatch } from '@i-harness/core-session'
import { registerCodeMode } from '../../code-mode/src/register.ts'
import { createMockClient } from '@i-harness/llm-mock'
import { observeModelClient } from '@i-harness/llm-seam'
import { localTestGeneration } from './fixtures/generation.ts'

it('uses the actual managed input, acceptance and dispatch receipts before exactly one tool effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-agent-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  await document.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'u', text: 'request', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture.input' } })
  const ctx = createContext(), tools = createToolRegistry(ctx), frames: string[][] = []
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { frames.push(decodeFactBatch(args[3].bytes).events.map(event => event.type)); return actual(...args) }
  let effects = 0
  tools.register({ name: 'write', description: 'write', inputSchema: { type: 'object' }, execute: async (_args, exec) => {
    const facts = (await backend.read(id)).events
    expect(facts.some(event => event.type === 'model/exchange-accepted')).toBe(true)
    expect(facts.some(event => event.type === 'tool/dispatch')).toBe(true)
    expect(exec.callEventSeq).toBe(facts.find(event => event.type === 'tool/call')?.seq)
    effects++; return { content: 'done' }
  } })
  try {
    const model = createMockClient([{ role: 'assistant', toolCalls: [{ id: 'c', name: 'write', args: {} }] }, { role: 'assistant', text: 'done' }])
    const agent = createAgent(ctx, { session: document.view, factOwner: document, generationFactory: localTestGeneration(document, id, model), tools, sessionId: id, systemPrompt: '', model })
    expect((await agent.run('request', undefined, undefined, 'u')).finalText).toBe('done')
    expect(effects).toBe(1)
    expect(frames.filter(frame => frame.includes('model/exchange-accepted'))).toEqual([
      ['assistant/message', 'model/exchange-accepted', 'context/action'], ['assistant/message', 'model/exchange-accepted', 'context/action'],
    ])
    expect((await backend.read(id)).events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
  } finally { await coordinator.close().catch(() => {}) }
})

it('rechecks the actual action recovery latch before model preparation after a pre-step source failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-prepare-fence-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx), action = document.beginAction()
  const source = action.registerSettlementSource(async () => { throw new Error('Retained source outcome') })
  action.finish()
  let preparations = 0, transports = 0
  ctx.on('agent/pre-step', () => { source.requireRecovery() })
  const model = {
    async prepare() { preparations++; throw new Error('Preparation must be fenced') },
    async *stream() { transports++; yield { type: 'end' as const } },
  }
  const agent = createAgent(ctx, { session: document.view, factOwner: document, generationFactory: localTestGeneration(document, id, model), sessionId: id, tools, systemPrompt: '', model })
  try {
    await expect(agent.run('received task')).rejects.toThrow()
    expect(preparations).toBe(0)
    expect(transports).toBe(0)
    expect((await backend.read(id)).events.at(-1)?.type).toBe('turn/end')
  } finally { await coordinator.close().catch(() => {}) }
})

it('preserves the actual outer Agent tool result when a completed Code Mode store is unknown and later reconciled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-parent-code-outcome-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let bodies = 0, nestedFinalizations = 0, outerFinalizations = 0, sends = 0, key: import('@i-harness/core-session').BatchKey | undefined
  tools.register({ name: 'probe', description: '', inputSchema: {}, execute: async () => { bodies++; return 7 } })
  ctx.on('tools/post-execute', event => { if ((event as { name: string }).name === 'probe') nestedFinalizations++; else if ((event as { name: string }).name === 'code_exec') outerFinalizations++ })
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const outcome = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/store')) { key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  const model = observeModelClient(createMockClient([{ role: 'assistant', toolCalls: [{ id: 'outer', name: 'code_exec', args: { code: 'store("key", await tools.probe({})); text("actual output")', yield_time_ms: 5000 } }] }]), { start() { sends++ }, finish() {} })
  const agent = createAgent(ctx, { session: document.view, factOwner: document, generationFactory: localTestGeneration(document, id, model), tools, sessionId: id, systemPrompt: '', model })
  try {
    await mount.ready!()
    await expect(agent.run('execute the original cell')).rejects.toThrow()
    expect([bodies, nestedFinalizations, sends]).toEqual([1, 1, 1])
    expect(key).toBeDefined()
    await mount.cancel('human Stop after computed completion')
    await document.reconcile(key!)
    document.revokeNewWork()
    await document.close()
    const results = (await backend.read(id)).events.filter(event => event.type === 'tool/result').filter(event => event.name === 'code_exec')
    expect(results).toEqual([expect.objectContaining({ callId: 'outer', output: expect.objectContaining({ status: 'completed', text: 'actual output' }) })])
    expect(results[0]!.output).not.toHaveProperty('code', 'TOOL_FAILED')
    expect([bodies, nestedFinalizations, outerFinalizations, sends]).toEqual([1, 1, 1, 1])
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it("rejects a response without explicit end before tool preparation", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const body = vi.fn(async () => "ok")
  tools.register({ name: "write", description: "write", inputSchema: { type: "object" }, execute: body })
  const agent = createAgent(ctx, { session, tools, systemPrompt: "", model: { async *stream() { yield { type: "tool_call", call: { id: "c", name: "write", args: {} } } } } })
  await expect(agent.run("request")).rejects.toMatchObject({ code: "MODEL_RESPONSE_INCOMPLETE" })
  expect(body).not.toHaveBeenCalled()
  expect(session.events.some(event => event.type === "model/exchange-accepted")).toBe(false)
})
it("retains recorded admission provenance and rejects conflicting per-call descriptors", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const human = { kind: "human", authority: "request", scope: "turn", producer: "desktop.input" } as const
  const inbox = new Inbox(session)
  inbox.admit({ inputId: "u", text: "request", delivery: "queue", intent: "user", provenance: human })
  expect(inbox.pending()[0]?.provenance).toEqual(human)
  const agent = createAgent(ctx, { session, tools, systemPrompt: "", model: { async *stream() { yield { type: "end" } } } })
  await expect(agent.run("request", undefined, undefined, "u", { provenance: { ...human, producer: "other" } })).rejects.toThrow("provenance conflicts")
  await agent.run("request", undefined, undefined, "u")
  expect(projectConversation(session).items.find(item => item.kind === "input")?.provenance).toMatchObject(human)
})
it("flushes acceptance and dispatch before effects, including tool-only assistant", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const checkpoints: string[][] = []
  let effects = 0
  tools.register({ name: "write", description: "write", inputSchema: { type: "object" }, execute: async () => {
    expect(checkpoints.at(-1)).toContain("model/exchange-accepted")
    expect(checkpoints.at(-1)).toContain("tool/dispatch")
    effects++; return "ok"
  } })
  const agent = createAgent(ctx, { session, tools, systemPrompt: "", flush: async () => { checkpoints.push(session.events.map(event => event.type)) }, model: { async *stream() { if (!effects) yield { type: "tool_call", call: { id: "c", name: "write", args: {} } }; else yield { type: "text/chunk", text: "done" }; yield { type: "end" } } } })
  expect(session.events).toEqual([])
  await agent.run("request")
  expect(session.events[0]?.type).toBe("conversation/semantics")
  expect(session.events.filter(event => event.type === "model/exchange-accepted")).toHaveLength(2)
  expect(session.events.find(event => event.type === "assistant/message")).toMatchObject({ text: "" })
  expect(projectConversation(session).items.find(item => item.kind === "input")?.provenance).toMatchObject({ kind: "unknown", producer: "agent.run" })
})
it("acceptance flush rejection prevents preparation and approval", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const body = vi.fn(async () => "ok"), prepare = vi.spyOn(tools, "prepare")
  tools.register({ name: "write", description: "write", inputSchema: { type: "object" }, execute: body })
  const agent = createAgent(ctx, { session, tools, systemPrompt: "", flush: async () => { if (session.events.some(event => event.type === "model/exchange-accepted")) throw new Error("save failed") }, model: { async *stream() { yield { type: "tool_call", call: { id: "c", name: "write", args: {} } }; yield { type: "end" } } } })
  await expect(agent.run("request")).rejects.toThrow("save failed")
  expect(prepare).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled()
  expect(session.events.some(event => event.type === "model/exchange-accepted")).toBe(true)
  expect(session.events.some(event => event.type === "step/failed")).toBe(false)
})
it.each([false, true])("retry before acceptance retains one logical action and changes physical attempts (content=%s)", async content => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const agent = createAgent(ctx, { session, tools, systemPrompt: "", model: { async *stream() {
    if (content) yield { type: "text/chunk", text: "discard me" }
    yield { type: "retry", retry: { requestId: "request", phase: "waiting", attempt: 1, delayMs: 0, code: "SERVER", ...(content ? { discardOutput: true as const } : {}) } }
    yield { type: "retry", retry: { requestId: "request", phase: "attempting", attempt: 1, delayMs: 0, code: "SERVER" } }
    yield { type: "retry", retry: { requestId: "request", phase: "recovered", attempt: 1, delayMs: 0, code: "SERVER" } }
    yield { type: "text/chunk", text: "accepted" }; yield { type: "end" }
  } } })
  await agent.run("request")
  const starts = session.events.filter(event => event.type === "step/start")
  expect(starts).toHaveLength(2)
  expect(starts[0]!.actionId).toBe(starts[1]!.actionId)
  expect(starts[0]!.attemptId).not.toBe(starts[1]!.attemptId)
  expect(session.events.filter(event => event.type === "model/exchange-accepted")).toEqual([expect.objectContaining({ stepStartSeq: starts[1]!.seq, actionId: starts[1]!.actionId, attemptId: starts[1]!.attemptId })])
  expect(JSON.stringify(projectConversation(session).items.flatMap(item => item.messages))).not.toContain("discard me")
})
it.each(["text", "call", "conflicting-end"])("rejects %s after completion before accepting or preparing tools", async trailing => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const prepare = vi.spyOn(tools, "prepare")
  const agent = createAgent(ctx, { session, tools, systemPrompt: "", model: { async *stream() {
    yield { type: "end" }
    if (trailing === "text") yield { type: "text/chunk", text: "late" }
    else if (trailing === "call") yield { type: "tool_call", call: { name: "write", args: {} } }
    else yield { type: "end", truncated: true }
  } } })
  await expect(agent.run("request")).rejects.toMatchObject({ code: "MODEL_RESPONSE_INCOMPLETE" })
  expect(session.events.some(event => event.type === "model/exchange-accepted")).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
})
it("keeps an accepted fact when a stop hook throws", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  ctx.on("agent/stop", () => { throw new Error("stop failed") })
  const agent = createAgent(ctx, { session, tools, systemPrompt: "", model: { async *stream() { yield { type: "text/chunk", text: "accepted" }; yield { type: "end" }; yield { type: "usage", usage: { inputTokens: 4 } } } } })
  await expect(agent.run("request")).rejects.toThrow("stop failed")
  expect(session.events.filter(event => event.type === "model/exchange-accepted")).toHaveLength(1)
  expect(session.events.some(event => event.type === "step/failed")).toBe(false)
  expect(projectConversation(session).items.find(item => item.exchange)?.exchange?.acceptance).toBe("explicit")
})
