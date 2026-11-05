import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonlBackend } from "../src/index.ts"
import { createSessionCoordinator } from "./helpers/composed.ts"
import { fromJSONL, type SessionEvent } from "@i-harness/core-session"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(body: string, version = 1, options?: Parameters<typeof createJsonlBackend>[1]) {
  const root = await mkdtemp(join(tmpdir(), "context-format-")); roots.push(root)
  const path = join(root, "s.jsonl")
  const raw = JSON.stringify({ formatVersion: version, sessionId: "s", createdAt: "x", title: "keep" }) + "\n" + body
  await writeFile(path, raw)
  return { path, raw, backend: createJsonlBackend(root, options) }
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
  expect(owned.session.formatVersion).toBe(CURRENT_FORMAT_VERSION)
  const upgraded = await readFile(path, "utf8")
  expect(JSON.parse(upgraded.split("\n")[0]!)).toMatchObject({ formatVersion: CURRENT_FORMAT_VERSION, title: "keep" })
  expect(upgraded.slice(upgraded.indexOf("\n") + 1)).toBe(body)
  await expect(coordinator.updateMeta("s", { formatVersion: 1 })).rejects.toThrow(/downgrade|format/)
  await expect(coordinator.updateMeta("s", { formatVersion: undefined })).rejects.toThrow(/downgrade|format/)
  await expect(backend.updateMeta("s", { formatVersion: undefined })).rejects.toThrow(/downgrade|format/)
  await coordinator.close()
})

it("the composed lane durably upgrades v1 without the backend upgrade method", async () => {
  // The transition lane stages its own header upgrade, so the backend method is
  // not the capability gate here. A backend that never had it must still reach
  // writable format through the composed lane (pre-bind seam, not a later patch).
  const { path, backend } = await fixture('{"type":"turn/start","seq":0}\n{"torn":', 1, { wrap: b => { delete (b as { upgradeSessionFormat?: unknown }).upgradeSessionFormat } })
  const coordinator = createSessionCoordinator(backend)
  const owned = await coordinator.loadOwned("s")
  expect(owned.session.formatVersion).toBe(CURRENT_FORMAT_VERSION)
  expect(JSON.parse((await readFile(path, "utf8")).split("\n")[0]!)).toMatchObject({ formatVersion: CURRENT_FORMAT_VERSION })
  await coordinator.close()
})

it.each([2, 3])("unsupported operational payload v%i refuses before any repair/replace", async version => {
  let repairs = 0, replaces = 0
  const { path, raw, backend } = await fixture('{"type":"turn/start","seq":0}\n' + JSON.stringify({ type: "context/recovery", version, ownerSessionId: "s", recoveryId: "r", logicalStepSeq: 0, bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "b".repeat(64), state: "required", seq: 1 }) + '\n{"torn":', 2, { wrap: b => {
    const repair = b.repair!.bind(b), replace = b.replaceEvents!.bind(b)
    b.repair = async (...args) => { repairs++; return repair(...args) }
    b.replaceEvents = async (...args) => { replaces++; return replace(...args) }
  } })
  const coordinator = createSessionCoordinator(backend)
  // The transition wrapper preserves the machine-readable format code (D-12 #7).
  await expect(coordinator.loadOwned("s")).rejects.toMatchObject({ code: "SESSION_FORMAT_UNSUPPORTED" })
  expect([repairs, replaces]).toEqual([0, 0])
  expect(await readFile(path, "utf8")).toBe(raw)
  await coordinator.close()
})

it("a failed durable transition retains a pending batch once and orders the header before append", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let appends = 0, refuseRepair = true
  // The composed lane upgrades the header before its repair step, so the
  // reachable refusal point for the writer is repair; the batch must survive it.
  const { path, raw, backend } = await fixture('{"type":"user/message","text":"old","seq":0}\n', 1, { wrap: b => {
    const repair = b.repair!.bind(b), append = b.append.bind(b)
    b.repair = async (...args) => {
      if (!refuseRepair) return repair(...args)
      entered.resolve(); await release.promise; throw new Error("repair refused")
    }
    b.append = async (id, events) => { expect((await b.profile(id)).meta.formatVersion).toBe(CURRENT_FORMAT_VERSION); appends++; return append(id, events) }
  } })
  const coordinator = createSessionCoordinator(backend, { maxDelayMs: 60000 })
  coordinator.enqueue("s", [{ type: "user/message", text: "new", seq: 1 }])
  const failed = coordinator.flush("s")
  await entered.promise
  expect(appends).toBe(0); expect(await readFile(path, "utf8")).toBe(raw)
  release.resolve()
  const failure = await failed.then(() => undefined, error => error)
  expect(failure.message).toBe("TASK_TRANSITION_FAILED")
  expect((failure.cause as Error).message).toBe("repair refused")
  expect(appends).toBe(0)
  // An unknown durable write poisons the process-read latch: the pending batch
  // stays retained and an unsafe retry is refused until the coordinator restarts.
  refuseRepair = false
  await expect(coordinator.flush("s")).rejects.toThrow("PROCESS_READ_UNAVAILABLE")
  expect(appends).toBe(0)
  // The retained batch cannot be persisted without a restart: shutdown reports
  // the debt instead of silently dropping it.
  await expect(coordinator.close()).rejects.toThrow(/Failed to persist sessions during shutdown/)
})

it("the durable header upgrade preserves metadata fields outside this reader's schema", async () => {
  const { path, backend } = await fixture('{ "type": "user/message", "text": "raw", "seq": 0 }\n')
  const original = await readFile(path, "utf8"), end = original.indexOf("\n")
  const header = { ...JSON.parse(original.slice(0, end)), extension: { exact: "preserve", nested: 7 }, modelSelection: { provider: "route", model: "m", futureLabel: "retain" } }
  await writeFile(path, JSON.stringify(header) + original.slice(end))
  await backend.upgradeSessionFormat!("s", 1, CURRENT_FORMAT_VERSION)
  const upgraded = await readFile(path, "utf8")
  expect(JSON.parse(upgraded.split("\n")[0]!)).toMatchObject({ ...header, formatVersion: CURRENT_FORMAT_VERSION, journal: { version: 1, legacyEventCount: 1 } })
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

it("keeps operational context facts at minimum format2 while upgrading the writer to11", async () => {
  const fact: SessionEvent = { type: "context/recovery", version: 1, ownerSessionId: "s", recoveryId: "r", logicalStepSeq: 0, bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "b".repeat(64), state: "required", seq: 0 }
  const { backend } = await fixture("", 2)
  await backend.append("s", [fact])
  const coordinator = createSessionCoordinator(backend)
  expect((await coordinator.snapshot!("s")).session.events).toEqual([fact])
  expect(fromJSONL(JSON.stringify({ formatVersion: 2 }) + "\n" + JSON.stringify(fact) + "\n").events).toEqual([fact])
  expect(() => fromJSONL(JSON.stringify({ formatVersion: 1 }) + "\n" + JSON.stringify(fact) + "\n")).toThrow()
  await coordinator.loadOwned("s")
  expect((await backend.profile("s")).meta.formatVersion).toBe(CURRENT_FORMAT_VERSION)
  await coordinator.close()
})