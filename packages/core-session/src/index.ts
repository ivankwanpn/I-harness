// `&` binds tighter than `|`, so the intersection must wrap the whole union —
// otherwise only the last member would carry `ignorable`.
export type SessionEvent =
  | (
    | { type: "turn/start"; seq?: number }
    | { type: "step/start"; seq?: number }
    | { type: "user/message"; text: string; seq?: number; source?: { kind: "plugin"; plugin: string }; images?: ImageInput[] }
    | { type: "assistant/chunk"; text: string; seq?: number }
    | { type: "assistant/message"; text: string; seq?: number }
    | { type: "tool/call"; callId: string; name: string; args: unknown; seq?: number }
    | { type: "tool/result"; callId: string; name: string; output: unknown; seq?: number }
    | { type: "step/end"; seq?: number }
    | { type: "turn/end"; seq?: number }
    | { type: "subagent/inbox"; messageId: string; message: string; seq?: number }
    | { type: "compaction/start"; seq?: number }
    | { type: "compaction/end"; seq?: number }
    | { type: "compaction/summary"; text: string; shadowedSeqs: number[]; seq?: number }
    // M20: pure-reset marker (compaction.resetWindow — absorb codex token-budget:
    // 新 context window、保留最近 N 條、無摘要)。Additive event type, format v1
    // stays. FIX ROUND 1 (Ruling 4): append-only durability — the marker does
    // NOT accompany a truncation; it RECORDS the removed seqs so deriveMessages
    // can shadow them (same mechanism as compaction/summary.shadowedSeqs).
    // Persistence backends are append-only, and recovery replays the log ⇒
    // nothing lost: every raw event stays durably recorded. Carries no
    // user-facing text → deliberately unindexed (default "").
    | { type: "compaction/reset"; removedSeqs: number[]; seq?: number }
    // M16: log-only sandbox session-mode marker (approval/* precedent) — mode is
    // a local union so core-session stays dependency-free (sandbox-policy owns
    // the real SandboxMode type; a sandbox import here would create a cycle).
    | { type: "sandbox/mode"; mode: "read-only" | "workspace-write" | "danger-full-access"; source?: "delegation"; seq?: number }
    // M19 subagent teams: team/* log events (version 1). The snapshot shapes
    // are INLINED (not imported from agent-team) — core-session must stay
    // dependency-free; agent-team imports core-session, so a reverse import
    // would create a cycle. Keep structurally identical to TeamEvent in
    // agent-team/src/types.ts.
    | { type: "team/member"; version: 1; teamId: string; member: { id: string; name: string; description: string; provider: string; context: "fresh" | "fork"; phase: "provisioning" | "active" | "failed"; error?: string; sessionId?: string }; seq?: number }
    | { type: "team/task"; version: 1; teamId: string; task: { id: string; revision: number; subject: string; description: string; status: "pending" | "in_progress" | "completed" | "deleted"; ownerId?: string; blockedBy: string[]; writeScopes: string[] }; seq?: number }
    | { type: "team/message/queued"; version: 1; teamId: string; message: { id: string; senderId: string; senderName: string; targetId: string; delivery: "quiet" | "wakeup"; content: string }; seq?: number }
    | { type: "team/message/delivered"; version: 1; teamId: string; messageId: string; targetId: string; seq?: number }
    // M21 todo tool: whole-list snapshot writes (version 1). INLINED like
    // team/* above so core-session stays dependency-free (the todo tool owns
    // the richer shape and reuses these names). No model-visible text →
    // deliberately unindexed (deriveMessages/deriveSearchText defaults).
    | { type: "todo/write"; version: 1; items: TodoItem[]; seq?: number }
  )
  & { ignorable?: true }

// M21 todo tool item shape (snapshot carried by every todo/write event). Each
// write REPLACES the visible list wholesale; status lives on the item, not the
// session, so the harness never derives todo progress from the log itself.
export type TodoItemStatus = "pending" | "in_progress" | "completed"
export interface TodoItem {
  content: string
  status: TodoItemStatus
}

// Lineage/identity carried on a session (M8): who spawned it and how deep in
// the subagent delegation chain it sits. Optional — a root session has none.
export interface SessionHeader {
  parentSession?: string
  seedLength?: number
  delegationDepth?: number
  origin?: string
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif"

export interface ImageInput {
  mediaType: ImageMediaType
  dataBase64: string // canonical base64 — NO `data:` prefix, NO whitespace
  // M20: optional durable store ref (`att-<uuid>` from @i-harness/attachment).
  // Purely additive — refs coexist with inline bytes: dataBase64 stays REQUIRED
  // (v0 does NOT migrate bytes out of the log), and store-less sessions keep
  // working. Validation: non-empty string when present (never required).
  attachmentId?: string
  name?: string
  width?: number // host-provided informational metadata (NOT verified in v0)
  height?: number
}

export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: ImageInput }

export interface Session {
  formatVersion: number
  events: SessionEvent[]
  header?: SessionHeader
}

export const CURRENT_FORMAT_VERSION = 1

// Optional per-session append observer (M4 persistence mirror). Stored in a
// WeakMap so the Session shape itself is unchanged.
const appendHooks = new WeakMap<Session, (ev: SessionEvent) => void>()

export function createSession(onAppend?: (ev: SessionEvent) => void): Session {
  const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events: [] }
  if (onAppend) appendHooks.set(session, onAppend)
  return session
}

export function append(session: Session, event: SessionEvent): void {
  if (event.type === "assistant/message" && (event as { source?: string }).source !== undefined) {
    throw new Error("assistant/message must originate from the log, not an external source")
  }
  // M14 image intake (fail-loud): images first attach to an event here, so this
  // is the boundary that validates them. deriveMessages stays a pure projection.
  const maybeImages = (event as { images?: unknown }).images
  const maybeOutputImages = event.type === "tool/result"
    ? (event as { output?: { images?: unknown } }).output?.images
    : undefined
  if (maybeImages !== undefined) {
    if (!Array.isArray(maybeImages)) throw new Error("image attachment: images must be an array")
    validateImages(maybeImages as ImageInput[], event.type)
  }
  if (maybeOutputImages !== undefined) {
    if (!Array.isArray(maybeOutputImages)) throw new Error("image attachment: images must be an array")
    validateImages(maybeOutputImages as ImageInput[], event.type)
  }
  const ev = { ...event, seq: session.events.length }
  session.events.push(ev)
  appendHooks.get(session)?.(ev)
}

const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>(["image/png", "image/jpeg", "image/webp", "image/gif"])
const MAX_IMAGES_PER_MESSAGE = 20
const MAX_IMAGE_BYTES_PER_MESSAGE = 200 * 1024 * 1024

function isValidBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0 && !s.includes(" ")
}

function validateImages(images: ImageInput[], evType: string): void {
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`image attachment: at most ${MAX_IMAGES_PER_MESSAGE} images per ${evType}`)
  }
  let bytes = 0
  for (const img of images) {
    if (!IMAGE_MEDIA_TYPES.has(img.mediaType)) {
      throw new Error(`image attachment: unsupported media type ${String(img.mediaType)}`)
    }
    if (!isValidBase64(img.dataBase64)) {
      throw new Error(`image attachment: dataBase64 must be canonical base64 (no data: prefix, no whitespace)`)
    }
    // M20: light check on the optional store ref — never required, but if a
    // caller attaches one it must be usable (an empty id would silently break
    // @i-harness/attachment store lookups).
    if (img.attachmentId !== undefined && (typeof img.attachmentId !== "string" || img.attachmentId.length === 0)) {
      throw new Error(`image attachment: attachmentId must be a non-empty string`)
    }
    bytes += Math.ceil((img.dataBase64.length * 3) / 4)
  }
  if (bytes > MAX_IMAGE_BYTES_PER_MESSAGE) {
    throw new Error(`image attachment: aggregate bytes exceed ${MAX_IMAGE_BYTES_PER_MESSAGE}`)
  }
}

export type LLMMessage =
  | { role: "user"; content: string | LLMContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: { id: string; name: string; args: unknown }[] }
  | { role: "tool"; toolCallId: string; content: string | LLMContentPart[] }

export function deriveMessages(session: Session): LLMMessage[] {
  const result: LLMMessage[] = []
  // A tool block is one step of assistant toolCalls followed by its tool
  // results. Both are buffered and flushed together (assistant toolCalls
  // FIRST, then tool results) so the model-visible order matches what the
  // APIs expect (function_call before function_call_output / tool_use before
  // tool_result), regardless of how the session log interleaves them.
  let pendingCalls: { id: string; name: string; args: unknown }[] | undefined
  const pendingResults: LLMMessage[] = []
  // M11 compaction shadow pre-pass: collect every seq a compaction/summary
  // replaced on the surface so the render pass skips them. The raw log keeps
  // all events; only this projection shrinks.
  // M20 fix round 1 (Ruling 4): `compaction/reset` markers join the SAME
  // shadow mechanism — their `removedSeqs` are collected additively, so an
  // append-only resetWindow hides exactly its removed tail without ever
  // truncating the durable log.
  const shadowed = new Set<number>()
  for (const ev of session.events) {
    if (ev.type === "compaction/summary") for (const seq of ev.shadowedSeqs) shadowed.add(seq)
    // defensive `?? []`: persisted logs bypass append validation, so a
    // malformed marker without removedSeqs must not throw here
    else if (ev.type === "compaction/reset") for (const seq of ev.removedSeqs ?? []) shadowed.add(seq)
  }
  for (const ev of session.events) {
    if (ev.seq !== undefined && shadowed.has(ev.seq)) continue
    if (ev.type === "user/message") {
      flushToolBlock()
      const images = ev.images as ImageInput[] | undefined
      result.push(
        images && images.length > 0
          ? { role: "user", content: [{ type: "text", text: ev.text }, ...images.map((image) => ({ type: "image" as const, image }))] }
          : { role: "user", content: ev.text },
      )
    } else if (ev.type === "assistant/message") {
      flushToolBlock()
      result.push({ role: "assistant", content: ev.text })
    } else if (ev.type === "compaction/summary") {
      flushToolBlock()
      result.push({ role: "user", content: ev.text })
    } else if (ev.type === "tool/call") {
      pendingCalls ??= []
      pendingCalls.push({ id: ev.callId, name: ev.name, args: ev.args })
    } else if (ev.type === "tool/result") {
      const out = ev.output as { images?: ImageInput[] } | null | undefined
      const images = out?.images
      pendingResults.push({ role: "tool", toolCallId: ev.callId, content: JSON.stringify(ev.output) })
      // Defensive (M14 spec §8): persisted logs bypass append validation (CLI
      // resume merges via events.push; fromJSONL does not validate), so a
      // truthy non-array `output.images` must NOT throw — treat the output as
      // plain data and flush no synthetic user message.
      if (Array.isArray(images) && images.length > 0) {
        pendingResults.push({
          role: "user",
          content: [
            { type: "text", text: "Attached image(s) from tool result:" },
            ...images.map((image) => ({ type: "image" as const, image })),
          ],
        })
      }
    } else if (ev.type === "step/end") {
      // Each step is a self-contained [assistant toolCalls -> tool results]
      // unit; flushing at step/end keeps per-turn tool blocks separate so the
      // log never folds across steps into consecutive user/tool-result runs
      // (which would violate Anthropic's Messages API role alternation).
      flushToolBlock()
    }
    // assistant/chunk events carry no model-visible text; skipped entirely
  }
  flushToolBlock()
  return result

  function flushToolBlock() {
    if (pendingCalls) {
      result.push({ role: "assistant", content: "", toolCalls: pendingCalls })
      pendingCalls = undefined
    }
    if (pendingResults.length > 0) {
      result.push(...pendingResults)
      pendingResults.length = 0
    }
  }
}

// Canonical event→searchable-text normalizer for the session-query FTS index
// (M10b). Control events and assistant/chunk (streaming noise duplicating the
// final assistant/message) contribute no text.
export function deriveSearchText(ev: SessionEvent): string {
  switch (ev.type) {
    case "user/message":
      return ev.text + imageDescriptor((ev as { images?: ImageInput[] }).images)
    case "assistant/message":
      return ev.text
    case "tool/call":
      return JSON.stringify(ev.args) ?? ""
    case "tool/result": {
      // Images never enter the FTS index: strip `output.images` before
      // stringifying so base64 payloads stay out of search text.
      const raw = ev.output
      if (raw === undefined) return ""
      if (typeof raw !== "object" || raw === null) return JSON.stringify(raw)
      // Array-shaped outputs (host-defined tool output) are opaque — never
      // destructure them into `{0:1,1:2}`; stringify the array as-is.
      if (Array.isArray(raw)) return JSON.stringify(raw)
      const { images, ...rest } = raw as Record<string, unknown>
      return JSON.stringify(rest) + imageDescriptor(images as ImageInput[] | undefined)
    }
    case "subagent/inbox":
      return ev.message
    case "compaction/summary":
      return ev.text
    // M19: only the two content-bearing team events are FTS-searchable
    // (team/member and team/message/delivered carry no user-facing text —
    // they stay unindexed via default "").
    case "team/task":
      return ev.task.subject + " " + ev.task.description
    case "team/message/queued":
      return ev.message.content
    default:
      return ""
  }
}

function imageDescriptor(images: ImageInput[] | undefined): string {
  // Defensive: malformed persisted events may carry a truthy non-array here.
  if (!Array.isArray(images) || images.length === 0) return ""
  return (
    "\n" +
    images.map((i) => `image: ${i.name ?? "unnamed"} ${i.width ?? "?"}x${i.height ?? "?"} ${Math.ceil((i.dataBase64.length * 3) / 4)}B base64:${i.dataBase64.slice(0, 8)}`).join("\n")
  )
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
