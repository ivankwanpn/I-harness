import { recordFixture } from "./helpers.ts"
import { expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile, unlink, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionCoordinator, createForkSessionController, forkSession, retryForkSession } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService, createCliForkHost } from "../src/index.ts"
import { acquireResultReadStore } from '../src/lifecycle/result-store.ts'

it("restores JSON through the real durable executor and copies visible state through repeated session forks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-store-executor-"))
  const settings = join(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: true } } }))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const controller = createForkSessionController(coordinator, createCliForkHost({ workspace: root, coordinator, contextOutputSettingsPath: settings }))
  const options = { workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutputSettingsPath: settings, modelPolicy: "test-mock" as const, sandbox: "danger-full-access" as const, codeMode: { mode: "only" as const } }
  let service = createSessionService(options)
  await coordinator.create({ sessionId: "source" })
  try {
    let source = await service.assemblyFor("source")
    await recordFixture(source.factOwner, { type: "turn/start" }); await recordFixture(source.factOwner, { type: "user/message", text: "save data" })
    expect((await source.tools.execute({ name: "code_exec", args: { code: 'store("value",{count:7});globalThis.secret=1;' } })).output).toMatchObject({ status: "completed" })
    await recordFixture(source.factOwner, { type: "turn/end" })
    await coordinator.flush("source")
    expect((await coordinator.snapshot!("source")).session.events.some(event => event.type === "code/store" as string)).toBe(true)
    const fork = await forkSession(coordinator, "source", { controller })
    await service.close(); service = createSessionService(options)
    source = await service.assemblyFor("source")
    expect((await source.tools.execute({ name: "code_exec", args: { code: 'text(load("value"));text(typeof secret);' } })).output).toMatchObject({ text: '{"count":7}\nundefined' })
    const child = await service.assemblyFor(fork.sessionId)
    expect((await child.tools.execute({ name: "code_exec", args: { code: 'text(load("value"));store("value",{count:8});' } })).output).toMatchObject({ text: '{"count":7}' })
    await recordFixture(child.factOwner, { type: "turn/start" }); await recordFixture(child.factOwner, { type: "user/message", text: "child boundary" }); await recordFixture(child.factOwner, { type: "turn/end" })
    await coordinator.flush(fork.sessionId)
    const next = await forkSession(coordinator, fork.sessionId, { controller })
    const grandchild = await service.assemblyFor(next.sessionId)
    expect((await grandchild.tools.execute({ name: "code_exec", args: { code: 'text(load("value"));' } })).output).toMatchObject({ text: '{"count":8}' })
    expect((await source.tools.execute({ name: "code_exec", args: { code: 'text(load("value"));' } })).output).toMatchObject({ text: '{"count":7}' })
  } finally { await controller.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)

it('keeps the captured value after independent source mutation and cold source clear/removal without recapture or assembly during fork', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-store-cold-')), settings = join(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: true } } }))
  let coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const options = () => ({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutputSettingsPath: settings, modelPolicy: 'test-mock' as const, sandbox: 'danger-full-access' as const, codeMode: { mode: 'only' as const } })
  let controller = createForkSessionController(coordinator, createCliForkHost({ workspace: root, coordinator, contextOutputSettingsPath: settings })), service = createSessionService(options())
  let captures = 0
  const originalCapture = coordinator.bootstrapSemanticTargetWithCapture!.bind(coordinator)
  coordinator.bootstrapSemanticTargetWithCapture = (request, guards, use) => originalCapture(request, guards, async () => { captures++; return use() })
  try {
    await coordinator.create({ sessionId: 'source' })
    const source = await service.assemblyFor('source'), run = async (assembly: typeof source, code: string) => (await assembly.tools.execute({ name: 'code_exec', args: { code } })).output
    await recordFixture(source.factOwner, { type: 'turn/start' }); await recordFixture(source.factOwner, { type: 'user/message', text: 'source' })
    expect(await run(source, 'store("value",7);globalThis.secret=99;')).toMatchObject({ status: 'completed' })
    await recordFixture(source.factOwner, { type: 'turn/end' })
    const assemblyCalls = vi.spyOn(service, 'assemblyFor'), toolCalls = vi.spyOn(source.tools, 'execute')
    const childResult = await forkSession(coordinator, 'source', { controller })
    expect(assemblyCalls).not.toHaveBeenCalled(); expect(toolCalls).not.toHaveBeenCalled(); expect(captures).toBe(1)
    const birth = await readFile(join(root, childResult.sessionId + '.jsonl'))
    expect((await retryForkSession(coordinator, childResult.operation, { controller })).kind).toBe('adopted')
    expect(captures).toBe(1); expect(await readFile(join(root, childResult.sessionId + '.jsonl'))).toEqual(birth)
    expect(await run(source, 'store("value",99);')).toMatchObject({ status: 'completed' })
    const child = await service.assemblyFor(childResult.sessionId)
    const childRead = await run(child, 'text(load("value"));text(typeof secret);store("value",8);')
    expect(childRead).toMatchObject({ text: '7\nundefined' })
    const sourceRead = await run(source, 'text(load("value"));')
    expect(sourceRead).toMatchObject({ text: '99' })
    await recordFixture(child.factOwner, { type: 'turn/start' }); await recordFixture(child.factOwner, { type: 'user/message', text: 'child' }); await recordFixture(child.factOwner, { type: 'turn/end' })
    assemblyCalls.mockClear(); toolCalls.mockClear()
    const grandchild = await forkSession(coordinator, childResult.sessionId, { controller })
    expect(assemblyCalls).not.toHaveBeenCalled(); expect(toolCalls).not.toHaveBeenCalled(); expect(captures).toBe(2)
    assemblyCalls.mockRestore(); toolCalls.mockRestore()
    await service.close(); await controller.close()
    const lease = await acquireResultReadStore({ workspace: root, coordinator, sessionId: 'source', contextOutputSettingsPath: settings, readCallerAvailable: () => true })
    try { await lease.service!.clear('source'); await lease.service!.clear(childResult.sessionId) } finally { await lease.release() }
    await coordinator.close()
    await unlink(join(root, 'source.jsonl')); await unlink(join(root, childResult.sessionId + '.jsonl'))
    coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    controller = createForkSessionController(coordinator, createCliForkHost({ workspace: root, coordinator, contextOutputSettingsPath: settings })); service = createSessionService(options())
    const profile = coordinator.profile.bind(coordinator), profiles = vi.spyOn(coordinator, 'profile').mockImplementation(async id => {
      if (id === 'source' || id === childResult.sessionId) throw Error('Unavailable source must not be profiled')
      return profile(id)
    })
    let coldCaptures = 0
    const capture = coordinator.bootstrapSemanticTargetWithCapture!.bind(coordinator)
    coordinator.bootstrapSemanticTargetWithCapture = (...args) => { coldCaptures++; return capture(...args) }
    const coldAssembly = vi.spyOn(service, 'assemblyFor')
    expect((await retryForkSession(coordinator, grandchild.operation, { controller })).kind).toBe('adopted')
    expect(coldCaptures).toBe(0); expect(coldAssembly).not.toHaveBeenCalled(); expect(profiles).not.toHaveBeenCalled()
    const assembliesDuringRetry = coldAssembly.mock.calls.length
    const restored = await service.assemblyFor(grandchild.sessionId)
    const grandchildRead = await run(restored, 'text(load("value"));text(typeof secret);')
    expect(grandchildRead).toMatchObject({ text: '8\nundefined' })
    expect(profiles.mock.calls.some(([id]) => id === 'source' || id === childResult.sessionId)).toBe(false)
    console.log(JSON.stringify({ control: 'public passive Code Mode', captures, coldCaptures, assembliesDuringRetry,
      ancestorProfiles: profiles.mock.calls.filter(([id]) => id === 'source' || id === childResult.sessionId).length,
      childRead: (childRead as { text: string }).text, grandchildRead: (grandchildRead as { text: string }).text, sourceMutatedAfterCapture: (sourceRead as { text: string }).text }))
    profiles.mockRestore(); coordinator.bootstrapSemanticTargetWithCapture = capture; coldAssembly.mockRestore()
  } finally { await controller.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 20000)

it('keeps ordinary two-argument standalone positive and seed-bearing nested convenience typed unsupported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-store-inline-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  try {
    await coordinator.create({ sessionId: 'source' }); await coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'ordinary no-sidecar' }, { type: 'turn/end' }])
    const child = await forkSession(coordinator, 'source')
    expect(child.kind).toBe('ready')
    await expect(forkSession(coordinator, child.sessionId)).rejects.toMatchObject({ name: 'ForkPreparationError', kind: 'unavailable', result: { kind: 'unavailable', reason: 'unsupported' } })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
