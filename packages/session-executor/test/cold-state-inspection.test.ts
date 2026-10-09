import { expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append, createSession } from "@i-harness/core-session"
import { breakdown } from "@i-harness/token-meter"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"
import { coldReaderFixture } from "./helpers/cold-reader.ts"

it.each([false, true])("keeps cold per-ID Context ownership when a static fallback also exists (snapshot=%s)", async snapshotAvailable => {
  const root = await mkdtemp(join(tmpdir(), "ih-context-owner-")), coordinator = createSessionCoordinator(createJsonlBackend(root))
  const staticSession = createSession(), targetSession = createSession()
  append(staticSession, { type: "user/message", text: "Static A" })
  append(targetSession, { type: "user/message", text: "Session B owns this context. ".repeat(100) })
  await coordinator.create({ sessionId: "B" }); await coordinator.append("B", targetSession.events)
  const file = join(root, "B.jsonl"), before = await readFile(file, "utf8")
  const writer = vi.fn(async () => targetSession)
  const modelBindingFor = async () => ({ status: "ready" as const, binding: { model: { async *stream() {} }, providerId: "owned", modelId: "fixture", label: "Owned", contextWindow: 100_000 } })
  const service = createSessionService({ workspace: root, session: staticSession, sessionFor: writer, modelBindingFor, ...(snapshotAvailable ? { coordinator } : {}) })
  const staticOnly = createSessionService({ workspace: root, session: staticSession, modelBindingFor })
  try {
    const context = await service.contextState("B")
    if (snapshotAvailable) expect(context).toMatchObject({ kind: "ready", estimatedTokens: breakdown(targetSession).total })
    else expect(context).toMatchObject({ kind: "unavailable" })
    expect(writer).not.toHaveBeenCalled()
    expect(service.hasAssembly("B")).toBe(false)
    expect(await readFile(file, "utf8")).toBe(before)
    expect(await staticOnly.contextState("static")).toMatchObject({ kind: "ready", estimatedTokens: breakdown(staticSession).total })
  } finally { await service.close(); await staticOnly.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("keeps a cold Context inspection immutable when a live writer starts during its await", async () => {
  const f = await coldReaderFixture()
  const reading = f.service.contextState(f.id)
  try {
    await f.entered; await f.startTurn()
    const before = await f.contents(), live = f.service.liveSession(f.id)!
    f.releaseRead()
    const context = await reading
    expect(await f.contents()).toBe(before)
    expect(context).toMatchObject({ kind: "ready", estimatedTokens: breakdown(live).total })
    const assembly = await f.service.assemblyFor(f.id)
    assembly.inbox.admit({ inputId: "owned-steer", text: "Owned steering", delivery: "steer", intent: "user" })
    await f.finishTurn()
    await f.service.close(); await f.coordinator.close()
    const cold = createSessionCoordinator(createJsonlBackend(f.store))
    try { const restored = (await cold.loadOwned(f.id)).session; expect(restored.events.map(event => event.seq)).toEqual(restored.events.map((_, index) => index)) }
    finally { await cold.close() }
  } finally { f.releaseRead(); await reading.catch(() => {}); await f.close() }
})

it("shares simultaneous owned loading across adapters instead of creating two live write caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-owned-load-flight-")), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: process.platform === "win32", lockRoot: root } })
  await coordinator.create({ sessionId: "owned" })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const actualRead = backend.read.bind(backend)
  let first = true
  backend.read = async id => { if (first) { first = false; entered.resolve(); await release.promise }; return actualRead(id) }
  const one = createDurableSessionLoader(coordinator)("owned"), two = createDurableSessionLoader(coordinator)("owned")
  try {
    await entered.promise; release.resolve()
    const [firstLive, secondLive] = await Promise.all([one, two])
    append(firstLive, { type: "user/message", text: "One admitted cache" })
    expect(secondLive.events).toEqual(firstLive.events)
    expect(secondLive).toBe(firstLive)
    await coordinator.flush("owned")
    expect((await coordinator.snapshot!("owned")).session.events.map(event => event.seq)).toEqual([0])
  } finally { release.resolve(); await Promise.allSettled([one, two]); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("retries a failed shared owned load without retaining its rejected cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-owned-load-retry-")), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend)
  await coordinator.create({ sessionId: "owned" })
  const read = backend.read.bind(backend)
  let fail = true
  backend.read = async id => { if (fail) { fail = false; throw new Error("Owned read failure") }; return read(id) }
  try {
    const failures = await Promise.allSettled([createDurableSessionLoader(coordinator)("owned"), createDurableSessionLoader(coordinator)("owned")])
    expect(failures.map(result => result.status)).toEqual(["rejected", "rejected"])
    const live = await createDurableSessionLoader(coordinator)("owned")
    append(live, { type: "user/message", text: "Retry remains writable" })
    await coordinator.flush("owned")
    expect((await coordinator.snapshot!("owned")).session.events).toEqual(live.events)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
