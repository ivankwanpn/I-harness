export type SessionEvent =
  | { type: "turn/start"; seq?: number }
  | { type: "step/start"; seq?: number }
  | { type: "user/message"; text: string; seq?: number }
  | { type: "assistant/chunk"; text: string; seq?: number }
  | { type: "assistant/message"; text: string; seq?: number }
  | { type: "tool/call"; name: string; args: unknown; seq?: number }
  | { type: "tool/result"; name: string; output: unknown; seq?: number }
  | { type: "step/end"; seq?: number }
  | { type: "turn/end"; seq?: number }

export interface Session {
  formatVersion: number
  events: SessionEvent[]
}

export const CURRENT_FORMAT_VERSION = 1

export function createSession(): Session {
  return { formatVersion: CURRENT_FORMAT_VERSION, events: [] }
}

export function append(session: Session, event: SessionEvent): void {
  if (event.type === "assistant/message" && (event as { source?: string }).source !== undefined) {
    throw new Error("assistant/message must originate from the log, not an external source")
  }
  const ev = { ...event, seq: session.events.length }
  session.events.push(ev)
}

export interface LLMMessage {
  role: "user" | "assistant"
  content: string
}

export function deriveMessages(session: Session): LLMMessage[] {
  const result: LLMMessage[] = []
  for (const ev of session.events) {
    if (ev.type === "user/message") result.push({ role: "user", content: ev.text })
    else if (ev.type === "assistant/message") result.push({ role: "assistant", content: ev.text })
    // assistant/chunk events carry no model-visible text; they are skipped entirely
  }
  return result
}

export function toJSONL(session: Session): string {
  const lines: string[] = [JSON.stringify({ formatVersion: session.formatVersion })]
  for (const ev of session.events) lines.push(JSON.stringify(ev))
  return lines.join("\n") + "\n"
}

export function assertVersion(session: Session, expected: number): number {
  if (session.formatVersion !== expected) {
    throw new Error(`session format version ${session.formatVersion} not supported (expected ${expected})`)
  }
  return session.formatVersion
}

export function fromJSONL(text: string): Session {
  if (text.trim().length === 0) {
    throw new Error("session log is empty")
  }
  const lines = text.trim().split("\n")
  const header = JSON.parse(lines[0]!) as { formatVersion?: number }
  if (header.formatVersion !== CURRENT_FORMAT_VERSION) {
    throw new Error(`session format version ${header.formatVersion} not supported`)
  }
  const events = lines.slice(1).map((l) => JSON.parse(l) as SessionEvent)
  return { formatVersion: CURRENT_FORMAT_VERSION, events }
}

export function migrate(session: Session, targetVersion: number): Session {
  if (targetVersion !== CURRENT_FORMAT_VERSION) {
    throw new Error(`no migration path to format version ${targetVersion}`)
  }
  return session // M1: only v1 exists; migrate-on-continue is a no-op placeholder for future versions
}
