import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { expect, it, onTestFinished, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { decodeFactBatch, type BatchKey } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionService, createDurableSessionLoader } from "@i-harness/session-executor"
import { createDesktopInput, desktopInputReceiptDocumentKey } from "../src/input.ts"

function fixtureCleanup(root: string, prefix: string) {
  const owners: Array<() => Promise<unknown>> = []
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    const failures: unknown[] = []
    for (const cleanup of [...owners].reverse()) {
      try { await cleanup() } catch (cause) { failures.push(cause) }
    }
    if (failures.length) throw new AggregateError(failures, 'Original input fixture cleanup incomplete')
    const target = resolve(root)
    if (dirname(target) !== resolve(tmpdir()) || !target.startsWith(join(resolve(tmpdir()), prefix))) {
      throw Error('Unexpected input fixture cleanup path')
    }
    await rm(target, { recursive: true, force: true })
  })()
  onTestFinished(close)
  return { add(cleanup: () => Promise<unknown>) { owners.push(cleanup) }, close }
}

it("admits a stable client token once with context/images across concurrent and restarted retries, rejecting changed payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-input-token-"))
  const cleanup = fixtureCleanup(root, 'ih-input-token-')
  let coordinator = createSessionCoordinator(createJsonlBackend(root))
  cleanup.add(() => coordinator.close())
  await coordinator.create({ sessionId: "s" })
  let service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
  cleanup.add(() => service.close())
  let input = createDesktopInput(coordinator, service)
  cleanup.add(() => input.close())
  const raw = { text: "draft", context: "file body", images: [{ mediaType: "image/png" as const, dataBase64: "aGVsbG8=" }], delivery: "queue" as const, clientToken: "stable-token-123456", start: false }
  try {
    const [first, retry] = await Promise.all([input.admit("s", raw), input.admit("s", raw)])
    expect(first.inputId).toBe(retry.inputId)
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(1)
    const receipt = await coordinator.getDocument(desktopInputReceiptDocumentKey("s"))
    expect(receipt).toBeUndefined()
    await input.close(); await service.close(); await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root))
    service = createSessionService({ workspace: root, coordinator, modelPolicy: "required", sessionFor: createDurableSessionLoader(coordinator) })
    input = createDesktopInput(coordinator, service)
    expect((await input.admit("s", raw)).inputId).toBe(first.inputId)
    await expect(input.admit("s", { ...raw, context: "changed" })).rejects.toThrow(/match|payload/)
    await expect(input.admit("s", { ...raw, images: [] })).rejects.toThrow(/match|payload/)
    for (const changed of [
      { mediaType: 'image/jpeg' as const }, { dataBase64: 'd29ybGQ=' },
      { attachmentId: 'att-other' }, { name: 'changed.png' }, { width: 20 }, { height: 30 },
    ]) {
      await expect(input.admit('s', { ...raw, images: [{ ...raw.images[0]!, ...changed }] })).rejects.toThrow(/match|payload/)
    }
    const explicit = { ...raw, clientToken: undefined, inputId: 'explicit-input', images: [raw.images[0]!, { ...raw.images[0]!, dataBase64: 'd29ybGQ=' }] }
    const admitted = await input.admit('s', explicit)
    expect(await input.admit('s', explicit)).toEqual(admitted)
    await expect(input.admit('s', { ...explicit, context: 'changed' })).rejects.toThrow(/match|payload/)
    await expect(input.admit('s', { ...explicit, images: [...explicit.images].reverse() })).rejects.toThrow(/match|payload/)
    const empty = { text: 'historical empty fields', delivery: 'queue' as const, inputId: 'empty-fields', start: false }
    const historical = await input.admit('s', empty)
    expect(await input.admit('s', { ...empty, context: '', images: [] })).toEqual(historical)
    await expect(input.admit('s', { ...empty, context: 'new context' })).rejects.toThrow(/match|payload/)
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(3)
  } finally { await cleanup.close() }
})

it("rejects same-token retry while its original native receipt is unknown, then reconciles and schedules that input once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-input-flush-"))
  const cleanup = fixtureCleanup(root, 'ih-input-flush-')
  let blocked = true
  let admissionKey: BatchKey | undefined
  let physicalAdmissions = 0
  const backend = createJsonlBackend(root, {
    wrapOwnedBatch: append => async (...args) => {
      const admission = decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted')
      const outcome = await append(...args)
      if (admission && outcome.kind === 'committed') {
        physicalAdmissions++
        admissionKey = args[3].key
        if (blocked) return { kind: 'unknown', key: admissionKey }
      }
      return outcome
    },
    wrapOwnedReconcile: reconcile => async (...args) => {
      if (blocked && args[3].key.batchId === admissionKey?.batchId) return { kind: 'unknown', key: args[3].key }
      return reconcile(...args)
    },
  })
  const coordinator = createSessionCoordinator(backend, { maxDelayMs: 60000, lock: { enabled: true } })
  cleanup.add(async () => { blocked = false; await coordinator.close() })
  await coordinator.create({ sessionId: "s" })
  const stream = vi.fn(async function* () { yield { type: "text/chunk" as const, text: "fixture result" }; yield { type: "end" as const } })
  const service = createSessionService({ workspace: root, coordinator, model: controlledModel(request => ({ stream } as import('@i-harness/llm-seam').ModelClient).stream(request)), sessionFor: createDurableSessionLoader(coordinator) })
  cleanup.add(() => service.close())
  const input = createDesktopInput(coordinator, service)
  cleanup.add(async () => { blocked = false; await input.close() })
  const raw = { text: "retain until durable", delivery: "queue" as const, clientToken: "flush-retry-token-123" }
  try {
    await expect(input.admit("s", raw)).rejects.toThrow()
    expect(admissionKey).toBeDefined()
    expect(physicalAdmissions).toBe(1)
    await expect(input.admit("s", raw)).rejects.toThrow()
    expect(stream).not.toHaveBeenCalled()
    blocked = false
    const document = await coordinator.openManagedDocument('s')
    expect(await document.reconcile(admissionKey!)).toMatchObject({ kind: 'committed' })
    const accepted = await input.admit("s", raw)
    expect(accepted.accepted).toBe(true)
    await input.drain()
    expect(stream).toHaveBeenCalledTimes(1)
    expect(physicalAdmissions).toBe(1)
    expect((await coordinator.snapshot!("s")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(1)
    expect(await input.admit("s", raw)).toEqual(accepted)
    await input.drain()
    expect(stream).toHaveBeenCalledTimes(1)
  } finally { blocked = false; await cleanup.close() }
})

it('acknowledges an idle steer as its original queue admission during busy and cold retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-input-steer-'))
  const cleanup = fixtureCleanup(root, 'ih-input-steer-')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let requests = 0
  const model = controlledModel(async function* () {
    requests++
    entered.resolve()
    await release.promise
    yield { type: 'text/chunk' as const, text: 'original input completed' }
    yield { type: 'end' as const }
  })
  let coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  cleanup.add(() => coordinator.close())
  await coordinator.create({ sessionId: 's' })
  let service = createSessionService({ workspace: root, coordinator, model, sessionFor: createDurableSessionLoader(coordinator) })
  cleanup.add(() => service.close())
  let input = createDesktopInput(coordinator, service)
  cleanup.add(async () => { release.resolve(); await input.close() })
  const raw = { text: 'original idle steer', context: 'same context', delivery: 'steer' as const, clientToken: 'idle-steer-token-123' }
  try {
    const admitted = await input.admit('s', raw)
    expect(admitted.delivery).toBe('queue')
    await Promise.race([
      entered.promise,
      input.drain().then(() => { throw Error('Original input ended before model entry') }),
    ])
    expect(service.queueState('s').running).toBe(true)
    expect(await input.admit('s', raw)).toEqual(admitted)
    await expect(input.admit('s', { ...raw, context: 'changed' })).rejects.toThrow(/match|payload/)
    const explicit = { text: 'actual busy steer', delivery: 'steer' as const, inputId: 'busy-steer', start: false }
    const steering = await input.admit('s', explicit)
    expect(steering.delivery).toBe('steer')
    expect(await input.admit('s', explicit)).toEqual(steering)
    await expect(input.admit('s', { ...explicit, delivery: 'queue' })).rejects.toThrow(/match|payload/)
    release.resolve()
    await input.drain()
    await input.close()
    await service.close()
    await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    service = createSessionService({ workspace: root, coordinator, model, sessionFor: createDurableSessionLoader(coordinator) })
    input = createDesktopInput(coordinator, service)
    expect(await input.admit('s', { ...raw, start: false })).toEqual(admitted)
    expect(await input.admit('s', { text: raw.text, context: raw.context, delivery: 'steer', inputId: admitted.inputId, start: false })).toEqual(admitted)
    await expect(input.admit('s', { ...explicit, delivery: 'queue' })).rejects.toThrow(/match|payload/)
    expect(requests).toBe(1)
    const events = (await coordinator.snapshot!('s')).session.events
    expect(events.filter(event => event.type === 'agent/input/admitted' && event.inputId === admitted.inputId)).toHaveLength(1)
  } finally { release.resolve(); await cleanup.close() }
})
