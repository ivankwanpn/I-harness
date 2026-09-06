// @i-harness/tui — M49 Task 10: typed tool presentation.
//
// ToolPresentation is the structured surface the block viewer renders:
//   title    — the block header (`Run {command}` / `Read {path}` / …),
//   summary  — the optional delta/matches chip (`(+1/-1)`, `(3 matches)`),
//   body     — text/diff/json entries (a device: `diff` carries the real
//              TextDiff — the viewer expands hunks itself; `json` holds the
//              REDACTED structured payload as pretty text),
//   raw      — the REDACTED args+result payload (the raw view's source),
//   groupKey — the verb-group key (`read`/`search`/…) when groupable.
//
// Dedicated formatters per tool family: execute, read, edit (write/apply_patch
// — the change-bearing family), list, search, web fetch/search, MCP, skill,
// subagent/task/job, todo, generic. Every field comes from the STRUCTURED
// payload (args/result members) — never regex-extracted out of a JSON string.
// The payload is redacted (redactToolPayload) BEFORE the presentation is
// built — a secret value under a secret key can never reach any field.
import type { TextDiff } from "@i-harness/text-diff"
import type { TuiToolEvent } from "../contracts.ts"
import { redactToolPayload } from "./redact.ts"

export interface ToolBodyEntry {
  kind: "text" | "diff" | "json"
  value: string | TextDiff
}

export interface ToolPresentation {
  title: string
  summary?: string
  body: Array<ToolBodyEntry>
  raw: unknown
  groupKey?: string
}

/** The event-like inputs the formatters accept (the TuiToolEvent from the
 * stream, or the scrollback engine's ToolBlock — both carry the typed fields;
 * the callId is optional and unused by the formatters). */
export interface ToolEventLike {
  name: string
  kind: TuiToolEvent["kind"]
  status: TuiToolEvent["status"]
  callId?: string
  args?: unknown
  result?: unknown
  output?: string
  error?: string
  progress?: string
}

export const GROUPABLE_KINDS = ["read", "list", "search", "webfetch", "websearch"] as const

/* ------------------------------------------------------------------ helpers */

/** The redacted raw composite: { args, result } — the raw view's JSON. */
function rawOf(ev: ToolEventLike): unknown {
  return {
    ...(ev.args !== undefined ? { args: redactToolPayload(ev.args) } : {}),
    ...(ev.result !== undefined ? { result: redactToolPayload(ev.result) } : {}),
  }
}

function jsonOf(value: unknown): ToolBodyEntry["value"] {
  return JSON.stringify(value, null, 2) ?? String(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(r: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = r[k]
    if (typeof v === "string" && v !== "") return v
  }
  return undefined
}

/** The fs change (or changes array) a result carries. */
function changeOf(result: unknown): TextDiff | TextDiff[] | undefined {
  const r = asRecord(result)
  if (r === undefined) return undefined
  const valid = (c: unknown): c is TextDiff =>
    c !== null && typeof c === "object"
    && typeof (c as TextDiff).path === "string"
    && typeof (c as TextDiff).added === "number"
    && typeof (c as TextDiff).deleted === "number"
  const changes = r.changes
  if (Array.isArray(changes) && changes.length > 0 && changes.every(valid)) return changes as TextDiff[]
  if (valid(r.change)) return r.change
  return undefined
}

function deltaOf(result: unknown): string | undefined {
  const change = changeOf(result)
  if (change === undefined) return undefined
  const list = Array.isArray(change) ? change : [change]
  let added = 0
  let deleted = 0
  for (const c of list) { added += c.added; deleted += c.deleted }
  if (added === 0 && deleted === 0) return undefined
  return `(+${added}/-${deleted})`
}

function entryDiffOf(result: unknown): ToolBodyEntry | undefined {
  const change = changeOf(result)
  if (change === undefined) return undefined
  return { kind: "diff", value: Array.isArray(change) ? change[0]! : change }
}

function bodyTextOf(ev: ToolEventLike): string | undefined {
  if (ev.error !== undefined && ev.error !== "") return ev.error
  if (ev.output !== undefined && ev.output !== "") return ev.output
  return undefined
}

/** number|string value of a member (the read tool's start/end are numbers). */
function num(r: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = r[k]
    if (typeof v === "number") return String(v)
    if (typeof v === "string" && v !== "") return v
  }
  return undefined
}

function withSummary(title: string, summary: string | undefined, body: ToolBodyEntry[], raw: unknown, groupKey?: string): ToolPresentation {
  return {
    title,
    ...(summary !== undefined && summary !== "" ? { summary } : {}),
    body,
    raw,
    ...(groupKey !== undefined ? { groupKey } : {}),
  }
}

/* ------------------------------------------------------------------ formatters */

/** Execute: `Run {command}` — args.command (structured) or the summary/name. */
export function formatExecute(ev: ToolEventLike): ToolPresentation {
  const args = asRecord(ev.args)
  const label = (args !== undefined && str(args, "command", "cmd", "script")) ?? ev.name
  const body: ToolBodyEntry[] = []
  const text = bodyTextOf(ev)
  if (text !== undefined) body.push({ kind: "text", value: text })
  if (body.length === 0 && args !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(args)) })
  if (body.length === 0) body.push({ kind: "text", value: "" })
  return withSummary(`Run ${label}`, undefined, body, rawOf(ev))
}

/** Read: `Read {path}` + the content body (or the `({start}-{end})` ranges
 * the tool's structured result supplies). */
export function formatRead(ev: ToolEventLike): ToolPresentation {
  const args = asRecord(ev.args)
  const label = (args !== undefined && str(args, "path", "file")) ?? ev.name
  const body: ToolBodyEntry[] = []
  const result = asRecord(ev.result)
  const rng = result !== undefined ? num(result, "start", "startLine") : undefined
  const rngEnd = result !== undefined ? num(result, "end", "endLine") : undefined
  if (rng !== undefined) {
    body.push({ kind: "text", value: `(${rng}-${rngEnd ?? "?"})` })
  }
  const text = bodyTextOf(ev)
  if (text !== undefined) body.push({ kind: "text", value: text })
  if (body.length === 0 && result !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(result as never)) })
  if (body.length === 0) body.push({ kind: "text", value: "" })
  return withSummary(`Read ${label}`, undefined, body, rawOf(ev), "read")
}

/** Edit/write/apply_patch: the structured change IS the expandable diff block
 * — the delta + the hunk rows come from result.change (TextDiff), never by
 * parsing the JSON text. */
export function formatEdit(ev: ToolEventLike): ToolPresentation {
  const args = asRecord(ev.args)
  const change = changeOf(ev.result)
  const label = (args !== undefined && str(args, "path", "file"))
    ?? (Array.isArray(change) ? change.map((c) => c.path).join("+") : change?.path)
    ?? ev.name
  const body: ToolBodyEntry[] = []
  const entry = entryDiffOf(ev.result)
  if (entry !== undefined) body.push(entry)
  const rest = bodyTextOf(ev)
  if (entry === undefined && rest !== undefined) body.push({ kind: "text", value: rest })
  if (body.length === 0 && args !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(args as never)) })
  if (body.length === 0) body.push({ kind: "text", value: "" })
  const summary = deltaOf(ev.result)
  return withSummary(`Edit ${label}`, summary, body, rawOf(ev))
}

/** List: `List {path}` + the result rows (json: the redacted payload). */
export function formatList(ev: ToolEventLike): ToolPresentation {
  const args = asRecord(ev.args)
  const label = (args !== undefined && str(args, "path", "dir")) ?? ev.name
  const body: ToolBodyEntry[] = []
  const text = bodyTextOf(ev)
  if (text !== undefined) body.push({ kind: "text", value: text })
  if (body.length === 0) {
    const result = asRecord(ev.result)
    if (result !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(result as never)) })
    else body.push({ kind: "text", value: "" })
  }
  return withSummary(`List ${label}`, undefined, body, rawOf(ev), "list")
}

/** Search: `Search {pattern}` + the matches count (the structured matchCount
 * when the result supplies one — never derived by regex on the JSON). */
export function formatSearch(ev: ToolEventLike): ToolPresentation {
  const args = asRecord(ev.args)
  const label = (args !== undefined && str(args, "pattern", "query", "path")) ?? ev.name
  const result = asRecord(ev.result)
  const n = result !== undefined && typeof result.matches === "number" ? result.matches : undefined
  const body: ToolBodyEntry[] = []
  const text = bodyTextOf(ev)
  if (text !== undefined) body.push({ kind: "text", value: text })
  if (body.length === 0 && result !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(result as never)) })
  if (body.length === 0) body.push({ kind: "text", value: "" })
  const summary = n !== undefined ? `(${n} matches)` : undefined
  return withSummary(`Search ${label}`, summary, body, rawOf(ev), "search")
}

/** Web fetch: `Fetch {url}` + the (N chars) chip. */
export function formatWebFetch(ev: ToolEventLike): ToolPresentation {
  const args = asRecord(ev.args)
  const label = (args !== undefined && str(args, "url", "uri")) ?? ev.name
  const body: ToolBodyEntry[] = []
  const text = bodyTextOf(ev)
  if (text !== undefined) body.push({ kind: "text", value: text })
  if (body.length === 0 && args !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(args as never)) })
  if (body.length === 0) body.push({ kind: "text", value: "" })
  return withSummary(`Fetch ${label}`, undefined, body, rawOf(ev), "webfetch")
}

/** Web search: `Search web for {query}`. */
export function formatWebSearch(ev: ToolEventLike): ToolPresentation {
  const args = asRecord(ev.args)
  const label = (args !== undefined && str(args, "query", "q")) ?? ev.name
  const body: ToolBodyEntry[] = []
  const text = bodyTextOf(ev)
  if (text !== undefined) body.push({ kind: "text", value: text })
  if (body.length === 0) {
    const result = asRecord(ev.result)
    if (result !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(result as never)) })
    else body.push({ kind: "text", value: "" })
  }
  return withSummary(`Search web for ${label}`, undefined, body, rawOf(ev), "websearch")
}

/** MCP: `Call mcp_…` — body from the (redacted) args/result JSON. */
export function formatMcp(ev: ToolEventLike): ToolPresentation {
  const body: ToolBodyEntry[] = []
  const result = asRecord(ev.result)
  if (result !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(result as never)) })
  else {
    const args = asRecord(ev.args)
    if (args !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(args as never)) })
  }
  if (body.length === 0) body.push({ kind: "text", value: "" })
  return withSummary(`Call ${ev.name}`, undefined, body, rawOf(ev))
}

/** Skill: `Invoke {skill}…`. */
export function formatSkill(ev: ToolEventLike): ToolPresentation {
  const args = asRecord(ev.args)
  const label = (args !== undefined && str(args, "skill", "name")) ?? ev.name
  const body: ToolBodyEntry[] = []
  const text = bodyTextOf(ev)
  if (text !== undefined) body.push({ kind: "text", value: text })
  if (body.length === 0 && args !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(args as never)) })
  if (body.length === 0) body.push({ kind: "text", value: "" })
  return withSummary(`Invoke ${label}`, undefined, body, rawOf(ev))
}

/** Subagent/task/job: `Started/Completed/Failed {label}` (base/status word). */
export function formatSubagent(ev: ToolEventLike): ToolPresentation {
  const args = asRecord(ev.args)
  const label = (args !== undefined && str(args, "subject", "task", "role", "description")) ?? ev.name
  const word = ev.status === "running" ? "Started" : ev.status === "done" ? "Completed" : "Failed"
  const body: ToolBodyEntry[] = []
  const text = bodyTextOf(ev)
  if (text !== undefined) body.push({ kind: "text", value: text })
  if (body.length === 0 && args !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(args as never)) })
  if (body.length === 0) body.push({ kind: "text", value: "" })
  return withSummary(`${word} ${label}`, undefined, body, rawOf(ev))
}

/** Todo: `Update todo` + the items (json body — the structured snapshot). */
export function formatTodo(ev: ToolEventLike): ToolPresentation {
  const body: ToolBodyEntry[] = []
  const result = asRecord(ev.result)
  if (result !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(result as never)) })
  else {
    const args = asRecord(ev.args)
    if (args !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(args as never)) })
  }
  if (body.length === 0) body.push({ kind: "text", value: "" })
  return withSummary("Update todo", undefined, body, rawOf(ev))
}

/** Generic/other: `Call {name}` + the (redacted) json body. */
export function formatGeneric(ev: ToolEventLike): ToolPresentation {
  const body: ToolBodyEntry[] = []
  const text = bodyTextOf(ev)
  if (text !== undefined) body.push({ kind: "text", value: text })
  if (body.length === 0) {
    const result = asRecord(ev.result)
    if (result !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(result as never)) })
    else {
      const args = asRecord(ev.args)
      if (args !== undefined) body.push({ kind: "json", value: jsonOf(redactToolPayload(args as never)) })
    }
  }
  if (body.length === 0) body.push({ kind: "text", value: "" })
  return withSummary(`Call ${ev.name}`, undefined, body, rawOf(ev))
}

/* ------------------------------------------------------------------ dispatch */

/** The one dispatcher: kind → the family formatter; the kind comes from the
 * same toolKindOf classification the engine block uses (no regex re-ranking
 * of a structured payload). */
export function presentTool(ev: ToolEventLike): ToolPresentation {
  switch (ev.kind) {
    case "execute": return formatExecute(ev)
    case "read": return formatRead(ev)
    case "edit": return formatEdit(ev)
    case "list": return formatList(ev)
    case "search": return formatSearch(ev)
    case "webfetch": return formatWebFetch(ev)
    case "websearch": return formatWebSearch(ev)
    case "mcp-tool": return formatMcp(ev)
    case "skill": return formatSkill(ev)
    case "subagent": return formatSubagent(ev)
    case "todo": return formatTodo(ev)
    default: return formatGeneric(ev)
  }
}
