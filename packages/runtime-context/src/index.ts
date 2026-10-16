import type { PluginContext } from "@i-harness/core-plugin"
import type { SessionView as Session, FeedbackFactSource } from "@i-harness/core-session"
import { committedFactSeqs, feedbackFactsFor } from "@i-harness/core-session"

export const RUNTIME_CONTEXT_SOURCE_PLUGIN = "i-harness/runtime-context"
export const RUNTIME_CONTEXT_CLEARED = "Current runtime context: none. Earlier runtime-context snapshots no longer apply."

export interface ContextSection { name: string; text: string }

export interface RuntimeContextService {
  registerSection(name: string, getter: () => string): () => void
  render(signal?: AbortSignal): Promise<void>
  currentText(): string
}

// R-A4: dynamic system context (dsh runtime-context re-implemented in
// i-harness vocabulary). The system prompt stays the host's static baseline;
// dynamic sections render into a snapshot USER MESSAGE appended to the session
// log ONLY when the rendered text changed — model-visible, replayable, and
// retained through the session's owned fact receipt. A resumed session
// reconstructs the last retained snapshot by scanning the log (the caller's
// session object is the same one reloaded by the coordinator).
export function createRuntimeContext(session: Session, facts?: FeedbackFactSource): RuntimeContextService {
  const sections = new Map<string, () => string>()
  let retained: string | undefined
  let observation = 0, lastConfirmation = 0, uncertainAfter = 0
  let pending: { snapshot: string; signal?: AbortSignal; feedback: ReturnType<typeof feedbackFactsFor>; work: Promise<void> } | undefined

  // Replay: last snapshot user/message wins; `undefined` = no snapshot ever.
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const ev = session.events[i]
    if (ev?.type !== "user/message" || ev.source?.kind !== "plugin") continue
    if (ev.source.plugin !== RUNTIME_CONTEXT_SOURCE_PLUGIN) continue
    retained = ev.text
    break
  }

  function currentText(): string {
    const parts: ContextSection[] = []
    for (const [name, getter] of sections) {
      const text = getter()
      if (text.length > 0) parts.push({ name, text })
    }
    if (parts.length === 0) return ""
    return parts.map((s) => `## ${s.name}\n\n${s.text.trim()}`).join("\n\n")
  }

  async function render(signal?: AbortSignal): Promise<void> {
    const rendered = currentText()
    const snapshot = rendered.length === 0 ? RUNTIME_CONTEXT_CLEARED : rendered
    if (!pending && retained === snapshot) return Promise.resolve()
    // Bind and submit under this original call's source/signal synchronously.
    // Different text joins the existing owner's FIFO; a same-source adjacent
    // observation only shares its already-issued receipt, never new authority.
    const feedback = !facts && pending && pending.signal === signal ? pending.feedback : feedbackFactsFor(session, facts, signal)
    if (pending?.snapshot === snapshot && pending.signal === signal && pending.feedback === feedback) return pending.work
    const ordinal = ++observation
    const failed = (error: unknown): never => {
      // An uncertain newer write can later reconcile into the real view.
      // Forget dedupe knowledge without declaring that write committed, and
      // never let an older failure erase a newer confirmed observation.
      if (ordinal > lastConfirmation) {
        uncertainAfter = Math.max(uncertainAfter, ordinal)
        retained = undefined
      }
      throw error
    }
    const receipt = feedback.feedback({
      type: "user/message",
      text: snapshot,
      source: { kind: "plugin", plugin: RUNTIME_CONTEXT_SOURCE_PLUGIN },
      // M59: model-visible context, never a user-facing turn.
      internal: true,
    })
    const work = receipt.then(outcome => {
      try { committedFactSeqs(outcome) } catch (error) { return failed(error) }
      if (ordinal > lastConfirmation) {
        lastConfirmation = ordinal
        retained = ordinal >= uncertainAfter ? snapshot : undefined
      }
    }, failed)
    pending = { snapshot, signal, feedback, work }
    const complete = () => { if (pending?.work === work) pending = undefined }
    void work.then(complete, complete)
    return work
  }

  return {
    registerSection(name, getter) {
      if (sections.has(name)) throw new Error(`duplicate runtime-context section: ${name}`)
      sections.set(name, getter)
      return () => { sections.delete(name) }
    },
    render,
    currentText,
  }
}

export function installRuntimeContext(ctx: PluginContext, session: Session, facts?: FeedbackFactSource): RuntimeContextService {
  const service = createRuntimeContext(session, facts)
  ctx.on("agent/pre-step", async input => { await service.render((input as { signal?: AbortSignal }).signal) })
  return service
}
