import type { SessionEventView as SessionEvent } from '@i-harness/core-session'
import type { AgentProcessesView } from './agent-processes.ts'
import { effectiveCuts, hidden } from './saved-process-index.ts'
import type { SavedFactEvidence } from './saved-fact-selection.ts'
const key = (e: { type: string; callId: string; cellId?: string }) => JSON.stringify([e.type.startsWith('code/') ? 'code' : 'tool', e.cellId ?? null, e.callId])
export function savedTerminals(events: readonly SessionEvent[], sessionId: string) {
  const calls = new Map<string, { name: string; args: Record<string, unknown>; index: number; event: SessionEvent; invalid: boolean; dispatch?: SavedFactEvidence }>()
  const terminals = new Map<string, AgentProcessesView["terminals"][number] & { text: string; truncated: boolean; dropped: boolean; endOffset?: number; evidence: SavedFactEvidence[] }>()
  const names = new Set(["terminal_open", "process_spawn", "terminal_read", "terminal_close", "terminal_signal", "process_kill", "process_resize_pty"])
  const cuts = effectiveCuts(events)
  const cells = new Map<string, SavedFactEvidence[]>()
  for (const [index, event] of events.entries()) if (event.type === 'code/cell' && !hidden(event.seq, cuts)) { const bucket = cells.get(event.cellId) ?? []; bucket.push({ index, event }); cells.set(event.cellId, bucket) }
  for (const [index, event] of events.entries()) {
    if (hidden(event.seq, cuts)) continue
    if (event.type === 'tool/dispatch' || event.type === 'code/dispatch') {
      const call = calls.get(key(event))
      if (call) { if (call.dispatch || event.eventSeq !== undefined && event.eventSeq !== call.event.seq) call.invalid = true; call.dispatch = { index, event } }
      continue
    }
    if ((event.type === "tool/call" || event.type === "code/call") && names.has(event.name)) {
      calls.set(key(event), { index, event, invalid: calls.has(key(event)), name: event.name, args: event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {} })
      if (calls.size > 512) calls.delete(calls.keys().next().value!)
      continue
    }
    if (event.type !== "tool/result" && event.type !== "code/result") continue
    const call = calls.get(key(event)); calls.delete(key(event))
    if (!call || call.invalid || call.name !== event.name || !event.output || typeof event.output !== "object") continue
    const result = event.output as Record<string, unknown>
    if ("error" in result || result.ownerSessionId !== undefined && result.ownerSessionId !== sessionId) continue
    const id = typeof result.id === "string" ? result.id : call.args.id
    if (typeof id !== "string" || !id || id.length > 256 || call.args.id !== undefined && call.args.id !== id) continue
    let row = terminals.get(id)
    if (!row) {
      row = { id, ownerSessionId: sessionId, status: "running", live: false, canControl: false, outputAvailable: false, outputReason: "No terminal_read output was saved", text: "", truncated: false, dropped: false, evidence: [] }
      terminals.set(id, row)
      if (terminals.size > 200) terminals.delete(terminals.keys().next().value!)
    }
    row.evidence.push({ index: call.index, event: call.event }, { index, event })
    if (call.dispatch) row.evidence.push(call.dispatch)
    if (call.event.type === 'code/call') row.evidence.push(...cells.get((call.event as { cellId: string }).cellId) ?? [])
    if (typeof result.command === "string") row.command = result.command.slice(0, 256)
    else if (typeof call.args.command === "string") row.command = call.args.command.slice(0, 256)
    if (typeof result.beganAt === "string") row.beganAt = result.beganAt.slice(0, 128)
    for (const field of ["pid", "cols", "rows"] as const) if (typeof result[field] === "number" && Number.isSafeInteger(result[field]) && result[field] > 0) row[field] = result[field]
    if (result.status === "running" || result.status === "exited") row.status = result.status
    if (typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode)) row.exitCode = result.exitCode
    if (event.name !== "terminal_read" || typeof result.data !== "string") continue
    const data = result.data
    const end = typeof result.nextOffset === "number" && Number.isSafeInteger(result.nextOffset) && result.nextOffset >= data.length ? result.nextOffset : undefined
    const start = end === undefined ? undefined : end - data.length
    const extra = start !== undefined && row.endOffset !== undefined ? data.slice(Math.max(0, row.endOffset - start)) : data
    row.dropped ||= result.dropped === true || start !== undefined && start > (row.endOffset ?? 0)
    if (end !== undefined) row.endOffset = Math.max(row.endOffset ?? 0, end)
    row.truncated ||= result.truncated === true || row.text.length + extra.length > 131072
    row.text = (row.text + extra).slice(-131072); row.outputAvailable = !!row.text
    row.outputReason = "Only saved terminal_read snapshots are available; output between reads or after the last read may be missing"
  }
  return terminals
}
