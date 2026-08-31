import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append } from "@i-harness/core-session"

export const RUNTIME_CONTEXT_SOURCE_PLUGIN = "i-harness/runtime-context"
export const RUNTIME_CONTEXT_CLEARED = "Current runtime context: none. Earlier runtime-context snapshots no longer apply."

export interface ContextSection { name: string; text: string }

export interface RuntimeContextService {
  registerSection(name: string, getter: () => string): () => void
  render(): void
  currentText(): string
}

// R-A4: dynamic system context (dsh runtime-context re-implemented in
// i-harness vocabulary). The system prompt stays the host's static baseline;
// dynamic sections render into a snapshot USER MESSAGE appended to the session
// log ONLY when the rendered text changed — model-visible, replayable, and
// durable through the session's own coordinator mirror. A resumed session
// reconstructs the last retained snapshot by scanning the log (the caller's
// session object is the same one reloaded by the coordinator).
export function createRuntimeContext(session: Session): RuntimeContextService {
  const sections = new Map<string, () => string>()
  let retained: string | undefined

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

  function render(): void {
    const rendered = currentText()
    const snapshot = rendered.length === 0 ? RUNTIME_CONTEXT_CLEARED : rendered
    if (retained === snapshot) return
    append(session, {
      type: "user/message",
      text: snapshot,
      source: { kind: "plugin", plugin: RUNTIME_CONTEXT_SOURCE_PLUGIN },
    })
    retained = snapshot
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

export function installRuntimeContext(ctx: PluginContext, session: Session): RuntimeContextService {
  const service = createRuntimeContext(session)
  ctx.on("agent/pre-step", () => { service.render() })
  return service
}
