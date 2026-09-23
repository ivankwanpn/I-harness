import type { Session } from "@i-harness/core-session"
import { append, deriveSessionTitle } from "@i-harness/core-session"
import { clampOutputCap } from "@i-harness/llm-seam"
import type { LLMMessage, LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { estimateContent } from "@i-harness/token-meter"
import type { SessionCoordinator } from "@i-harness/session-persistence"

export const TITLE_MAX_BYTES = 120
export const TITLE_MAX_WORDS = 8

const SYSTEM_TITLE_PROMPT =
  "You produce ONLY a short session title. Reply with at most 8 words that capture the user's goal " +
  "from the messages. No quotes, no markdown, no trailing period."

// R-A6: deterministic fallback (dsh normalize/fallback re-implementation):
// first `maxWords` whitespace-delimited words, single-line collapsed.
export function fallbackTitle(text: string, maxWords = TITLE_MAX_WORDS): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter((w) => w.length > 0)
  if (words.length === 0) return "New session"
  const head = words.slice(0, maxWords).join(" ")
  const truncated = words.length > maxWords
  const title = truncated ? `${head}...` : head
  return normalizeTitle(title, TITLE_MAX_BYTES)
}

export function normalizeTitle(text: string, maxBytes = TITLE_MAX_BYTES): string {
  // trim ends only — internal whitespace/newlines are preserved (test contract)
  const normalized = text.trim()
  const buf = Buffer.from(normalized, "utf8")
  if (buf.byteLength <= maxBytes) return normalized
  return `${buf.subarray(0, maxBytes).toString("utf8").trim()}...`
}

// Eligible model-visible USER prompts: real user messages only — runtime
// context snapshots and system injections carry a plugin source and are
// excluded.
function eligibleUserTexts(session: Session): { seq: number; text: string }[] {
  const out: { seq: number; text: string }[] = []
  for (const ev of session.events) {
    if (ev.type !== "user/message") continue
    const src = (ev as { source?: unknown }).source
    if (src !== undefined) continue
    out.push({ seq: ev.seq ?? 0, text: ev.text })
  }
  return out
}

export async function suggestTitle(deps: {
  session: Session
  model: ModelClient
  maxWords?: number
  /** M73 (fix wave, I3): the SESSION model's resolved numbers, handed down the
   * way core-agent hands them to the summarizer. This request is built HERE, so
   * nothing else can clamp it — without them it left the process with no cap,
   * and on an anthropic route the adapter's own unclamped fallback went to the
   * wire. Optional and never defaulted: absent ⇒ no key is written. */
  contextWindow?: number
  maxOutputTokens?: number
}): Promise<{ title: string; source: "provider" | "fallback" }> {
  const inputs = eligibleUserTexts(deps.session)
  const first = inputs[0]?.text ?? ""
  try {
    const messages: LLMMessage[] = [{ role: "user", content: inputs.map((i) => i.text).join("\n\n").slice(0, 4000) || "(no messages)" }]
    const request: LLMRequest = {
      messages,
      tools: [],
      systemPrompt: SYSTEM_TITLE_PROMPT,
      // M73: the request's own budget, clamped the way the session's own
      // requests are (`clampOutputCap`, priced with the same public meter).
      // Normally a no-op — the input is sliced to 4 000 chars and the answer is
      // a short line — and kept anyway, because a cap that reaches the wire
      // unclamped is the hazard, not the tokens the clamp saves.
      ...(deps.maxOutputTokens !== undefined
        ? { maxOutputTokens: clampOutputCap(deps.maxOutputTokens, deps.contextWindow, estimateContent(messages)) }
        : {}),
    }
    let out = ""
    // M77: the provider can decline to produce a title (HTTP 200, no content,
    // `end.refused`) — a different fact from "the provider answered with
    // nothing", which is what the message below used to say.
    let refused = false
    for await (const ev of deps.model.stream(request)) {
      if (ev.type === "text/chunk") out += ev.text
      if (ev.type === "error") throw ev.error
      if (ev.type === "end" && ev.refused === true) refused = true
    }
    const title = normalizeTitle(out)
    // M77: absent stays absent — without the bit this message is byte-identical
    // to pre-M77. NOTE: the throw is swallowed by this function's own catch two
    // lines down, so the text is a message for a reader of the source (and for
    // whatever catches it if that ever changes), not for an operator today.
    if (title.length === 0) throw new Error(refused ? "provider refused to produce a title" : "empty provider title")
    return { title, source: "provider" }
  } catch {
    return { title: fallbackTitle(first, deps.maxWords), source: "fallback" }
  }
}

export function applyTitle(session: Session, title: string, source: "fallback" | "provider" | "user", messageSeqs?: number[]): void {
  append(session, { type: "session/title", title: normalizeTitle(title), messageSeqs: messageSeqs ?? [], source })
}

// First-prompt mode (roadmap). Fail-soft: a provider failure degrades to the
// deterministic fallback; a coordinator failure never rejects the caller
// (putDocument reports internally).
export async function maybeAutoTitle(deps: {
  session: Session
  model: ModelClient
  coordinator?: SessionCoordinator
  sessionId?: string
  /** M73 (fix wave, I3): the same two numbers `suggestTitle` clamps with,
   * forwarded verbatim — the CLI holds them at the binding it resolved for the
   * session's model (run.ts), and the title request runs on that model. */
  contextWindow?: number
  maxOutputTokens?: number
}): Promise<void> {
  if (deps.coordinator && deps.sessionId) {
    // best-effort persisted mirror (list-screen fast path). The key is a
    // namespaced SUBDIRECTORY ("session-title/<id>") so the mirror never
    // appears as a top-level *.jsonl/*.doc.jsonl beside the session file
    // (the JSONL doc backend mkdirs the key's parent dir).
    void deps.coordinator.putDocument(`session-title/${deps.sessionId}`, {
      formatVersion: 1,
      title: deriveSessionTitle(deps.session)?.title ?? null,
    }).catch(() => {})
  }
  if (deriveSessionTitle(deps.session) !== null) return
  const inputs = eligibleUserTexts(deps.session)
  if (inputs.length === 0) return
  const { title, source } = await suggestTitle({
    session: deps.session,
    model: deps.model,
    ...(deps.contextWindow !== undefined ? { contextWindow: deps.contextWindow } : {}),
    ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
  })
  applyTitle(deps.session, title, source, inputs.map((i) => i.seq))
  if (deps.coordinator && deps.sessionId) {
    void deps.coordinator.putDocument(`session-title/${deps.sessionId}`, {
      formatVersion: 1,
      title,
      source,
    }).catch(() => {})
  }
}
