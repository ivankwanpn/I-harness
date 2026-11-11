import { createHash, randomUUID } from "node:crypto"
import type { AsyncInbox, ImageInput, SessionEventView } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { createDurableSessionLoader } from "@i-harness/session-executor"
import { isManagedFactOwner, readInbox, validateImages } from "@i-harness/core-session"
import { modelFailureFacts, type ModelFailureFacts } from "@i-harness/llm-seam"

/** Exact producer-owned document identity for permanent session cleanup. */
export const desktopInputReceiptDocumentKey = (sessionId: string) => `desktop-input-tokens-${createHash("sha256").update(sessionId).digest("hex")}`
type ManagedInputOwner=NonNullable<Awaited<ReturnType<NonNullable<SessionService['managedInputFor']>>>>
type ManagedInputObservation=ReturnType<ManagedInputOwner['observe']>

/** Durable admission owns acceptance; each execution is scheduled separately. */
export function createDesktopInput(coordinator: SessionCoordinator, service: SessionService, options: {
  prepare?: (sessionId: string, text: string) => Promise<string>
  /** Original managed runtime supplies its own retained preparation surface. */
  managedPreparation?: boolean
  onStatus?: (sessionId: string, running: boolean, error?: string, modelFailure?: ModelFailureFacts) => void
} = {}) {
  const load = createDurableSessionLoader(coordinator)
  const gates = new Map<string, Promise<unknown>>()
  const scheduled = new Set<string>()
  const jobs = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  let closed = false
  const keyFor = (id: string, input: string) => JSON.stringify([id, input])
  const ownSession = async (id: string) => {
    const session = await service.writableSessionFor?.(id, load) ?? service.liveSession(id) ?? await load(id)
    return await service.writableSessionFor?.(id, load) ?? service.liveSession(id) ?? session
  }
  function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const job = (gates.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
    gates.set(id, job)
    void job.finally(() => { if (gates.get(id) === job) gates.delete(id) }).catch(() => undefined)
    return job
  }
  function start(id: string, inputId: string, text: string, managed = false) {
    const key = keyFor(id, inputId)
    if (scheduled.has(key)) return
    scheduled.add(key)
    options.onStatus?.(id, true)
    const controller = new AbortController()
    controllers.add(controller)
    const job = service.submit(id, text, controller.signal, { admittedInputId: inputId,
      ...(!managed && options.prepare ? { prepareInput: (_assembly, raw) => options.prepare!(id, raw) } : {}),
    })
      .then(() => { options.onStatus?.(id, service.queueState(id).running) }, (error) => {
        const message = error instanceof Error ? error.message : String(error)
        const facts = modelFailureFacts(error)
        if (facts) options.onStatus?.(id, false, message, facts)
        else options.onStatus?.(id, false, message)
      })
      .finally(() => { scheduled.delete(key); jobs.delete(job); controllers.delete(controller) })
    jobs.add(job)
  }
  function schedulePending(id: string, inbox: Pick<AsyncInbox, 'pending'>, managed = false) {
    const running = service.queueState(id).running
    for (const pending of inbox.pending()) {
      if (pending.delivery === "queue" || !running) start(id, pending.inputId, pending.text, managed)
    }
  }
  async function acknowledgeExisting(id: string, existing: Extract<SessionEventView, { type: "agent/input/admitted" }>, shouldStart: boolean, managed?:ManagedInputOwner, observation?:ManagedInputObservation) {
    if (closed) throw new Error("Input service closed")
    if(managed){
      if(!observation)throw Error('Original admission observation required')
      observation.assertCurrent()
      if(shouldStart&&existing.delivery==='queue')schedulePending(id,managed.inbox,true)
      return {accepted:true as const,inputId:existing.inputId,delivery:existing.delivery}
    }
    const document = await coordinator.openManagedDocument(id)
    if (!isManagedFactOwner(document.view, document)) throw new Error('Durable input owner unavailable')
    // The actual managed view installs a received input only after its receipt.
    // An unrelated in-flight reservation need not recreate an admission or
    // block acknowledgement of this already-committed input.
    const persisted = document.view.events.find((event) => event.type === "agent/input/admitted" && event.inputId === existing.inputId)
    if (persisted?.type !== "agent/input/admitted" || persisted.text !== existing.text || persisted.delivery !== existing.delivery) throw new Error("Input admission is not durable")
    if (closed) throw new Error("Input service closed")
    // A failed earlier barrier never reached scheduling. Pending inputs may
    // now start; promoted/completed/cancelled inputs are absent from pending.
    let ready = true
    try { document.assertReady() } catch { ready = false }
    if (shouldStart && ready && persisted.delivery === "queue") schedulePending(id, await service.receivedInputFor(id))
    return { accepted: true as const, inputId: persisted.inputId, delivery: persisted.delivery }
  }
  return {
    admit(id: string, raw: { text: string; delivery: "queue" | "steer"; context?: string; images?: ImageInput[]; clientToken?: string; inputId?: string; start?: boolean }) {
      return serial(id, async () => {
        if (closed) throw new Error("Input service closed")
        if (!raw || typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 131072 || !["queue", "steer"].includes(raw.delivery)) throw new Error("Invalid input")
        if (raw.context !== undefined && (typeof raw.context !== "string" || raw.context.length > 131072)) throw new Error("Invalid prompt context")
        if (raw.clientToken !== undefined && (typeof raw.clientToken !== "string" || raw.clientToken.length < 8 || raw.clientToken.length > 128)) throw new Error("Invalid prompt client token")
        if (raw.images) validateImages(raw.images, "desktop input")
        const managed=await service.managedInputFor?.(id,{completePreparation:options.prepare!==undefined&&!options.managedPreparation,supplementalContext:raw.context!==undefined})
        await coordinator.profile(id)
        managed?.observe().assertCurrent()
        // The durable admission event is the idempotency record. A client
        // token deterministically selects its input id, so no second receipt
        // document (and no write→readback round trip) is needed.
        const tokenInputId = raw.clientToken
          ? `desktop-token-${createHash("sha256").update(JSON.stringify([id, raw.clientToken])).digest("hex")}`
          : undefined
        if (tokenInputId !== undefined) {
          const observation=managed?.observe()
          const existing = observation?await observation.inbox.admitted(tokenInputId):(await ownSession(id)).events.find((event) => event.type === "agent/input/admitted" && event.inputId === tokenInputId)
          observation?.assertCurrent()
          if (existing?.type === "agent/input/admitted") {
            if (existing.text !== raw.text || existing.delivery !== raw.delivery) throw new Error("Input token payload does not match its durable admission")
            return acknowledgeExisting(id, existing, raw.start !== false,managed,observation)
          }
        }
        const session = managed?undefined:await ownSession(id)
        const inbox = managed?.inbox??await service.receivedInputFor(id)
        let blocked = false
        if(managed)managed.observe().assertCurrent()
        else try { (await coordinator.openManagedDocument(id)).assertReady() } catch { blocked = true }
        const observation=managed?.observe()
        let inputId = tokenInputId ?? raw.inputId ?? randomUUID()
        // A canceled admission grants no delivery. A shutdown-compensated
        // recovery can use a deterministic new generation; pending/promoted
        // generations remain exactly once across the crash window.
        while (raw.inputId) {
          const duplicate = observation?await observation.inbox.admitted(inputId):session!.events.find((event) => event.type === "agent/input/admitted" && event.inputId === inputId)
          observation?.assertCurrent()
          if (!duplicate || duplicate.type !== "agent/input/admitted") break
          const cancelledSeq=observation?observation.inbox.lastCancellationSeq(inputId):session!.events.findLast((event) => event.type === "agent/input/cancelled" && event.inputId === inputId)?.seq
          observation?.assertCurrent()
          if (cancelledSeq!==undefined) { inputId = `${raw.inputId}:retry:${cancelledSeq}`; continue }
          if (duplicate.text !== raw.text || duplicate.delivery !== raw.delivery) throw new Error("Recovered input does not match its durable admission")
          return acknowledgeExisting(id, duplicate, raw.start !== false,managed,observation)
        }
        const delivery = raw.delivery === "steer" && !service.queueState(id).running ? "queue" : raw.delivery
        observation?.assertCurrent()
        await inbox.admit({ inputId, text: raw.text, preparationPolicy: 'human-host', delivery, intent: "user", provenance: { kind: "human", authority: "request", scope: "turn", producer: "desktop.input" },
          ...(raw.context ? { supplementalContext: raw.context } : {}), ...(raw.images?.length ? { images: raw.images } : {}), ...(raw.clientToken ? { clientToken: raw.clientToken } : {}) })
        managed?.observe().assertCurrent()
        if (closed) throw new Error("Input service closed")
        if (raw.start !== false && !blocked && delivery === "queue") {
          managed?.observe().assertCurrent()
          schedulePending(id, inbox, !!managed)
        }
        return { accepted: true as const, inputId, delivery }
      })
    },
    async state(id: string) {
      await coordinator.profile(id)
      let session = service.liveSession(id)
      if (!session) {
        if (!coordinator.snapshot) throw new Error("Read-only input snapshots unavailable")
        const saved = (await coordinator.snapshot(id)).session
        session = service.liveSession(id) ?? saved
      }
      const pending = readInbox(session).pending()
      const rows = new Map(service.queue(id).map((row) => [row.id, row]))
      for (const input of pending) if (!rows.has(input.inputId)) rows.set(input.inputId, { id: input.inputId, text: input.text, delivery: input.delivery, intent: input.intent, state: "queued", order: input.admittedSeq })
      return { items: [...rows.values()], resumable: pending.some((input) => !scheduled.has(keyFor(id, input.inputId))) && !service.queueState(id).running }
    },
    cancel(id: string, inputId: string) {
      return serial(id, async () => {
        await coordinator.profile(id)
        const cancelled = (await service.cancelQueued(id, inputId)).cancelled || await (await service.receivedInputFor(id)).cancel(inputId)
        return { cancelled }
      })
    },
    resume(id: string) {
      return serial(id, async () => {
        if (closed) throw new Error("Input service closed")
        const managed=await service.managedInputFor?.(id,{completePreparation:options.prepare!==undefined&&!options.managedPreparation})
        if(managed){const observation=managed.observe();const pending=managed.inbox.pending();observation.assertCurrent();for(const input of pending)start(id,input.inputId,input.text,true)}
        else {await ownSession(id);(await coordinator.openManagedDocument(id)).assertReady();for (const input of (await service.receivedInputFor(id)).pending()) start(id, input.inputId, input.text)}
        return { resumed: true }
      })
    },
    async drain() { await Promise.allSettled([...jobs]) },
    async close() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...gates.values()]); await Promise.allSettled([...jobs]) },
  }
}
