import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../src/index.ts"
import { fromJSONL, type SessionEvent } from "@i-harness/core-session"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(body: string, version = 1) {
  const root = await mkdtemp(join(tmpdir(), "context-format-")); roots.push(root)
  const path = join(root, "s.jsonl")
  const raw = JSON.stringify({ formatVersion: version, sessionId: "s", createdAt: "x", title: "keep" }) + "\n" + body
  await writeFile(path, raw)
  return { path, raw, backend: createJsonlBackend(root) }
}

it.each([1, 2])("preflights unsupported complete records before repairing a torn open v%i tail", async version => {
  const { path, raw, backend } = await fixture('{"type":"turn/start","seq":0}\n{"type":"future/operational","seq":1}\n{"torn":', version)
  const coordinator = createSessionCoordinator(backend)
  await expect(coordinator.load("s")).rejects.toThrow(/unknown event/)
  expect(await readFile(path, "utf8")).toBe(raw)
  await coordinator.close()
})

it("cold v1 snapshots preserve bytes; owned upgrade durably preserves raw event bytes before append", async () => {
  const body = '{ "type": "user/message", "text": "你好", "seq": 0 }\n'
  const { path, raw, backend } = await fixture(body)
  const coordinator = createSessionCoordinator(backend)
  await coordinator.snapshot!("s")
  expect(await readFile(path, "utf8")).toBe(raw)
  const owned = await coordinator.loadOwned("s")
  expect(owned.session.formatVersion).toBe(8)
  const upgraded = await readFile(path, "utf8")
  expect(JSON.parse(upgraded.split("\n")[0]!)).toMatchObject({ formatVersion: 8, title: "keep" })
  expect(upgraded.slice(upgraded.indexOf("\n") + 1)).toBe(body)
  await expect(coordinator.updateMeta("s", { formatVersion: 1 })).rejects.toThrow(/downgrade|format/)
  await expect(coordinator.updateMeta("s", { formatVersion: undefined })).rejects.toThrow(/downgrade|format/)
  await expect(backend.updateMeta("s", { formatVersion: undefined })).rejects.toThrow(/downgrade|format/)
  await coordinator.close()
})

it("missing upgrade capability withholds writable v1 before any tail repair", async () => {
  const { path, raw, backend } = await fixture('{"type":"turn/start","seq":0}\n{"torn":')
  backend.upgradeSessionFormat = undefined
  const coordinator = createSessionCoordinator(backend)
  await expect(coordinator.loadOwned("s")).rejects.toThrow(/upgrade/)
  expect(await readFile(path, "utf8")).toBe(raw)
  await coordinator.close()
})

it.each([2, 3])("unsupported operational payload v%i refuses before any repair/replace", async version => {
  const { path, raw, backend } = await fixture('{"type":"turn/start","seq":0}\n' + JSON.stringify({ type: "context/recovery", version, ownerSessionId: "s", recoveryId: "r", logicalStepSeq: 0, bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "b".repeat(64), state: "required", seq: 1 }) + '\n{"torn":', 2)
  const repair = vi.spyOn(backend, "repair"), replace = vi.spyOn(backend, "replaceEvents")
  const coordinator = createSessionCoordinator(backend)
  await expect(coordinator.loadOwned("s")).rejects.toThrow(/unsupported operational/)
  expect(repair).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled()
  expect(await readFile(path, "utf8")).toBe(raw)
  await coordinator.close()
})

it("a held/rejected writer upgrade retains a pending batch once and orders the durable header before append", async () => {
  const { path, raw, backend } = await fixture('{"type":"user/message","text":"old","seq":0}\n')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const actualUpgrade = backend.upgradeSessionFormat!.bind(backend), actualAppend = backend.append.bind(backend)
  let appends = 0
  backend.upgradeSessionFormat = async () => { entered.resolve(); await release.promise; throw new Error("upgrade refused") }
  backend.append = async (id, events) => { expect((await backend.profile(id)).meta.formatVersion).toBe(8); appends++; await actualAppend(id, events) }
  const coordinator = createSessionCoordinator(backend, { maxDelayMs: 60000 })
  coordinator.enqueue("s", [{ type: "user/message", text: "new", seq: 1 }])
  const failed = coordinator.flush("s")
  await entered.promise
  expect(appends).toBe(0); expect(await readFile(path, "utf8")).toBe(raw)
  release.resolve(); await expect(failed).rejects.toThrow("upgrade refused")
  expect(appends).toBe(0); expect(await readFile(path, "utf8")).toBe(raw)
  backend.upgradeSessionFormat = actualUpgrade
  await coordinator.flush("s"); await coordinator.flush("s")
  expect(appends).toBe(1)
  expect((await backend.read("s")).events.map(event => event.seq)).toEqual([0, 1])
  await coordinator.close()
})

it("the durable header upgrade preserves metadata fields outside this reader's schema", async () => {
  const { path, backend } = await fixture('{ "type": "user/message", "text": "raw", "seq": 0 }\n')
  const original = await readFile(path, "utf8"), end = original.indexOf("\n")
  const header = { ...JSON.parse(original.slice(0, end)), extension: { exact: "preserve", nested: 7 }, modelSelection: { provider: "route", model: "m", futureLabel: "retain" } }
  await writeFile(path, JSON.stringify(header) + original.slice(end))
  await backend.upgradeSessionFormat!("s", 1, 8)
  const upgraded = await readFile(path, "utf8")
  expect(JSON.parse(upgraded.split("\n")[0]!)).toMatchObject({ ...header, formatVersion: 8, journal: { version: 1, legacyEventCount: 1 } })
  expect(upgraded.slice(upgraded.indexOf("\n") + 1)).toBe(original.slice(end + 1))
})

it("appends after an imported complete last record without joining two JSON objects", async () => {
  const { backend } = await fixture('{"type":"user/message","text":"old","seq":0}')
  const coordinator = createSessionCoordinator(backend)
  const owned = await coordinator.loadOwned("s")
  expect(owned.session.events).toHaveLength(1)
  await coordinator.append("s", [{ type: "user/message", text: "new", seq: 1 }])
  expect((await backend.read("s")).events.map(event => event.seq)).toEqual([0, 1])
  await coordinator.close()
})

it("keeps operational context facts at minimum format2 while upgrading the writer to8", async () => {
  const fact: SessionEvent = { type: "context/recovery", version: 1, ownerSessionId: "s", recoveryId: "r", logicalStepSeq: 0, bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "b".repeat(64), state: "required", seq: 0 }
  const { backend } = await fixture("", 2)
  await backend.append("s", [fact])
  const coordinator = createSessionCoordinator(backend)
  expect((await coordinator.snapshot!("s")).session.events).toEqual([fact])
  expect(fromJSONL(JSON.stringify({ formatVersion: 2 }) + "\n" + JSON.stringify(fact) + "\n").events).toEqual([fact])
  expect(() => fromJSONL(JSON.stringify({ formatVersion: 1 }) + "\n" + JSON.stringify(fact) + "\n")).toThrow()
  await coordinator.loadOwned("s")
  expect((await backend.profile("s")).meta.formatVersion).toBe(8)
  await coordinator.close()
})
