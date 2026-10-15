import { describe, expect, it } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { createSessionCoordinator, registerEventType, registerUpgrade, type CoordinatorOptions, type PersistenceBackend } from "../src/index.ts"

function backend(): PersistenceBackend {
  return {
    id: "jsonl", capabilities: { seekableRead: false, rawArtifacts: true },
    async create() {}, async append() {}, async list() { return [] },
    async read() { return { version: 3, events: [] } },
    async repair() { return { version: 3, events: [] } },
    async putDocument() {}, async getDocument() { return undefined },
    async profile() { throw new Error("unused") }, async updateMeta() { throw new Error("unused") },
  }
}

describe("coordinator callback and evaluation order", () => {
  it("shares late event and upgrade registrations across already created coordinators", async () => {
    const store = backend()
    const events = [{ type: "s9/custom", seq: 0 }] as unknown as SessionEvent[]
    store.read = async () => ({ version: 0, events })
    store.repair = async () => ({ version: 0, events })
    const first = createSessionCoordinator(store)
    const second = createSessionCoordinator(store)
    registerEventType("s9/custom")
    registerUpgrade(0, (events) => events.map(event => ({ ...event, upgraded: true })))
    expect((await first.snapshot!("s")).session.events).toEqual([{ type: "s9/custom", seq: 0, upgraded: true }])
    expect((await second.load("s")).session.events).toEqual([{ type: "s9/custom", seq: 0, upgraded: true }])
    await first.close()
    await second.close()
  })

  it("keeps initialization getter order and reads append after its operation await", async () => {
    const reads: string[] = []
    const store = backend()
    Object.defineProperty(store, "lockRoot", { get() { reads.push("backend.lockRoot"); return undefined } })
    const options: CoordinatorOptions = {
      get reportBackgroundFailure() { reads.push("report"); return () => {} },
      get maxDelayMs() { reads.push("delay"); return 60000 },
      get lock() {
        reads.push("lock")
        return { get enabled() { reads.push("enabled"); return false }, get lockRoot() { reads.push("root"); return undefined } }
      },
      get acquireRetryMs(): number { throw new Error("retry must remain lazy") },
      get acquireDeadlineMs(): number { throw new Error("deadline must remain lazy") },
    }
    const coordinator = createSessionCoordinator(store, options)
    expect(reads).toEqual(["report", "delay", "lock", "enabled", "lock", "root", "backend.lockRoot"])
    const pending = coordinator.append("s", [])
    let calls = 0
    store.append = async function () { expect(this).toBe(store); calls++ }
    await pending
    expect(calls).toBe(1)
    await coordinator.close()
  })

  it("lets a throwing document reporter reject while the next document and close still drain", async () => {
    const store = backend()
    const diskError = new Error("disk")
    const reportError = new Error("reporter")
    const writes: string[] = []
    store.putDocument = async function (key) {
      expect(this).toBe(store)
      writes.push(key)
      if (key === "bad") throw diskError
    }
    const coordinator = createSessionCoordinator(store, { reportBackgroundFailure(error) {
      expect(error).toBe(diskError)
      throw reportError
    } })
    const failed = coordinator.putDocument("bad", {})
    const next = coordinator.putDocument("next", {})
    await expect(failed).rejects.toBe(reportError)
    await next
    await coordinator.close()
    expect(writes).toEqual(["bad", "next"])
  })

  it("reads replaceEvents after repair settles and retains its backend receiver", async () => {
    const store = backend()
    const repaired = Promise.withResolvers<Awaited<ReturnType<PersistenceBackend["repair"]>>>()
    const entered = Promise.withResolvers<void>()
    store.repair = async function () { expect(this).toBe(store); entered.resolve(); return repaired.promise }
    const coordinator = createSessionCoordinator(store)
    const loaded = coordinator.loadOwned("s")
    await entered.promise
    let calls = 0
    store.replaceEvents = async function (_id, events) { expect(this).toBe(store); calls++; expect(events[0]?.seq).toBe(0) }
    repaired.resolve({ version: 3, events: [{ type: "assistant/message", text: "persist me" }] })
    await loaded
    expect(calls).toBe(1)
    await coordinator.close()
  })
})
