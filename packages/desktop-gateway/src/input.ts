import { randomUUID } from "node:crypto"
import type { ImageInput } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { createDurableSessionLoader } from "@i-harness/session-executor"
import { Inbox, validateImages } from "@i-harness/core-session"

/** Durable admission owns acceptance; each execution is scheduled separately. */
export function createDesktopInput(coordinator: SessionCoordinator, service: SessionService, options: {
  prepare?: (sessionId: string, text: string) => Promise<string>
  onStatus?: (sessionId: string, running: boolean, error?: string) => void
} = {}) {
  const load = createDurableSessionLoader(coordinator)
  const gates = new Map<string, Promise<unknown>>()
  const scheduled = new Set<string>()
  const jobs = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  let closed = false
  const keyFor = (id: string, input: string) => JSON.stringify([id, input])
  const ownSession = async (id: string) => service.liveSession(id) ?? await load(id)
  function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const job = (gates.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
    gates.set(id, job)
    void job.finally(() => { if (gates.get(id) === job) gates.delete(id) }).catch(() => undefined)
    return job
  }
  function start(id: string, inputId: string, text: string) {
    const key = keyFor(id, inputId)
    if (scheduled.has(key)) return
    scheduled.add(key)
    options.onStatus?.(id, true)
    const controller = new AbortController()
    controllers.add(controller)
    const job = service.submit(id, text, controller.signal, { admittedInputId: inputId })
      .then(() => { options.onStatus?.(id, service.queueState(id).running) }, (error) => { options.onStatus?.(id, false, error instanceof Error ? error.message : String(error)) })
      .finally(() => { scheduled.delete(key); jobs.delete(job); controllers.delete(controller) })
    jobs.add(job)
  }
  return {
    admit(id: string, raw: { text: string; delivery: "queue" | "steer"; context?: string; images?: ImageInput[]; clientToken?: string; inputId?: string; start?: boolean }) {
      return serial(id, async () => {
        if (closed) throw new Error("Input service closed")
        if (!raw || typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 131072 || !["queue", "steer"].includes(raw.delivery)) throw new Error("Invalid input")
        if (raw.context !== undefined && (typeof raw.context !== "string" || raw.context.length > 131072)) throw new Error("Invalid prompt context")
        if (raw.clientToken !== undefined && (typeof raw.clientToken !== "string" || raw.clientToken.length < 8 || raw.clientToken.length > 128)) throw new Error("Invalid prompt client token")
        if (raw.images) validateImages(raw.images, "desktop input")
        await coordinator.profile(id)
        // Live admissions use the exact assembly session and its write hook.
        // Recovery-only admissions can be saved without a configured model.
        const binding = raw.start === false ? await service.modelState(id) : undefined
        const session = raw.start === false && binding?.status !== "ready" ? await ownSession(id) : (await service.assemblyFor(id)).session
        const inbox = new Inbox(session)
        let inputId = raw.inputId ?? randomUUID()
        // A canceled admission grants no delivery. A shutdown-compensated
        // recovery can use a deterministic new generation; pending/promoted
        // generations remain exactly once across the crash window.
        while (raw.inputId) {
          const duplicate = session.events.find((event) => event.type === "agent/input/admitted" && event.inputId === inputId)
          if (!duplicate || duplicate.type !== "agent/input/admitted") break
          const cancelled = session.events.findLast((event) => event.type === "agent/input/cancelled" && event.inputId === inputId)
          if (cancelled) { inputId = `${raw.inputId}:retry:${cancelled.seq}`; continue }
          if (duplicate.text !== raw.text || duplicate.delivery !== raw.delivery) throw new Error("Recovered input does not match its durable admission")
          return { accepted: true as const, inputId, delivery: raw.delivery }
        }
        const prepared = raw.start === false ? raw.text : await options.prepare?.(id, raw.text) ?? raw.text
        const text = raw.context ? `${prepared}\n\n${raw.context}` : prepared
        const delivery = raw.delivery === "steer" && !service.queueState(id).running ? "queue" : raw.delivery
        inbox.admit({ inputId, text, delivery, intent: "user", ...(raw.images?.length ? { images: raw.images } : {}), ...(raw.clientToken ? { clientToken: raw.clientToken } : {}) })
        await coordinator.flush(id)
        if (closed) throw new Error("Input service closed")
        if (raw.start !== false && delivery === "queue") {
          const running = service.queueState(id).running
          for (const pending of inbox.pending()) {
            if (pending.delivery === "queue" || !running) start(id, pending.inputId, pending.text)
          }
        }
        return { accepted: true as const, inputId, delivery }
      })
    },
    async state(id: string) {
      await coordinator.profile(id)
      const pending = new Inbox(await ownSession(id)).pending()
      const rows = new Map(service.queue(id).map((row) => [row.id, row]))
      for (const input of pending) if (!rows.has(input.inputId)) rows.set(input.inputId, { id: input.inputId, text: input.text, delivery: input.delivery, intent: input.intent, state: "queued", order: input.admittedSeq })
      return { items: [...rows.values()], resumable: pending.some((input) => !scheduled.has(keyFor(id, input.inputId))) && !service.queueState(id).running }
    },
    cancel(id: string, inputId: string) {
      return serial(id, async () => {
        await coordinator.profile(id)
        const cancelled = service.cancelQueued(id, inputId).cancelled || new Inbox(await ownSession(id)).cancel(inputId)
        await coordinator.flush(id)
        return { cancelled }
      })
    },
    resume(id: string) {
      return serial(id, async () => {
        if (closed) throw new Error("Input service closed")
        const assembly = await service.assemblyFor(id)
        for (const input of assembly.inbox.pending()) start(id, input.inputId, input.text)
        return { resumed: true }
      })
    },
    async drain() { await Promise.allSettled([...jobs]) },
    async close() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...gates.values()]); await Promise.allSettled([...jobs]) },
  }
}
