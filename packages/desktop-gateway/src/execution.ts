import { readFileSync } from "node:fs"
import type { SessionEvent } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { normalizeCodeMode, type SettingsCodeMode } from "@i-harness/settings"
import { withDesktopSettings } from "./settings-file.ts"

export type CodeMode = "off" | "mixed" | "only"
export interface CodeModeSettingsView { saved: SettingsCodeMode; effective?: CodeMode; live: boolean }
export interface ExecutionCallView { id: string; parentCallId?: string; name: string; args: string; output?: string; isError?: boolean; dispatched: boolean; seq?: number }
export interface ExecutionCellView {
  id: string; ownerSessionId: string; parentCallId?: string; status: string; source: string; error?: string
  live: boolean; canTerminate: boolean; truncated: boolean; seq?: number
  output: { kind: string; text: string; seq?: number }[]; calls: ExecutionCallView[]
}
export interface DesktopExecutionView { sessionId: string; live: boolean; effectiveMode?: CodeMode; cells: ExecutionCellView[]; total: number; offset: number; hasMore: boolean }
export type ExecutionRequest =
  | { kind: "desktop/code-mode/state"; workspaceId: string; sessionId?: string }
  | { kind: "desktop/code-mode/configure"; workspaceId: string; sessionId?: string; patch: { mode: CodeMode } }
  | { kind: "desktop/session/execution/read"; workspaceId: string; sessionId: string; offset?: number; limit?: number }
  | { kind: "desktop/session/execution/stop"; workspaceId: string; sessionId: string; cellId: string }

export function boundedInteger(value: unknown, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid execution cursor or dimension")
  return value
}
export function resourceId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || value.includes("\0")) throw new Error("Invalid execution resource id")
  return value
}
/** Inspector reads must never enter the loader's crash-recovery write path. */
export async function readDesktopSnapshot(coordinator: SessionCoordinator, sessionId: string) {
  if (!coordinator.snapshot) throw new Error("Read-only snapshot inspection is unavailable for this backend")
  return (await coordinator.snapshot(sessionId)).session
}
/** Text-only bounded rendering keeps media payloads out of the diagnostic IPC. */
export function displayValue(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value, (key, child) => ["data", "audioUrl", "base64"].includes(key) && typeof child === "string" && child.length > 2048 ? `[media ${child.length} characters]` : child) ?? ""
}

export function createCodeModeSettings(path: string, service: Pick<SessionService, "liveAssembly">) {
  function resolve(): SettingsCodeMode {
    let raw: unknown
    try { raw = JSON.parse(readFileSync(path, "utf8")) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeCodeMode(undefined); throw new Error("Cannot read Code Mode settings") }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Code Mode settings document")
    return normalizeCodeMode((raw as Record<string, unknown>).codeMode)
  }
  function view(saved: SettingsCodeMode, sessionId?: string): CodeModeSettingsView {
    const assembly = sessionId ? service.liveAssembly(resourceId(sessionId)) : undefined
    return { saved, live: Boolean(assembly), ...(assembly?.executionState ? { effective: assembly.executionState().codeMode } : {}) }
  }
  return {
    resolve,
    state: (sessionId?: string) => withDesktopSettings(path, async store => view(store.get().codeMode, sessionId)),
    async configure(input: unknown, sessionId?: string): Promise<CodeModeSettingsView> {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Code Mode settings")
      const command = input as Record<string, unknown>
      if (Object.keys(command).some(key => key !== "mode")) throw new Error("Unsupported Code Mode setting field")
      if (!["off", "mixed", "only"].includes(String(command.mode))) throw new Error("Invalid Code Mode mode")
      return withDesktopSettings(path, async store => {
        await store.set({ codeMode: { ...store.get().codeMode, mode: command.mode as CodeMode } })
        return view(store.get().codeMode, sessionId)
      })
    },
  }
}

export function createDesktopExecution(coordinator: SessionCoordinator, service: Pick<SessionService, "liveAssembly">) {
  return {
    async read(sessionId: string, options: { offset?: number; limit?: number } = {}): Promise<DesktopExecutionView> {
      resourceId(sessionId); await coordinator.profile(sessionId)
      const offset = boundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER, 0)
      const limit = boundedInteger(options.limit, 1, 20, 10)
      const assembly = service.liveAssembly(sessionId)
      const session = assembly?.session ?? await readDesktopSnapshot(coordinator, sessionId)
      const owned = new Set(assembly?.liveResources?.().codeCells.map(cell => cell.id) ?? [])
      const starts = new Map<string, Extract<SessionEvent, { type: "code/cell" }>>()
      for (const event of session.events) if (event.type === "code/cell" && (!event.sessionId || event.sessionId === sessionId)) starts.set(event.cellId, { ...starts.get(event.cellId), ...event })
      const ids = [...starts.keys()].reverse()
      const selected = ids.slice(offset, offset + limit)
      const cells = new Map<string, ExecutionCellView>()
      for (const id of selected) {
        const event = starts.get(id)!
        cells.set(id, { id, ownerSessionId: sessionId, parentCallId: event.parentCallId, status: event.state, source: event.source ?? "", error: event.error,
          live: owned.has(id), canTerminate: owned.has(id) && typeof assembly?.stopCodeCell === "function", truncated: false, seq: event.seq, output: [], calls: [] })
      }
      // Per-page content is bounded to 20 * 64K; every clipping is disclosed.
      const budgets = new Map(selected.map(id => [id, 65536]))
      function clip(cell: ExecutionCellView, value: unknown): string {
        const raw = displayValue(value); const remaining = budgets.get(cell.id) ?? 0
        const text = raw.slice(0, remaining); budgets.set(cell.id, remaining - text.length)
        if (text.length < raw.length) cell.truncated = true
        return text
      }
      for (const cell of cells.values()) { cell.source = clip(cell, cell.source); if (cell.error) cell.error = clip(cell, cell.error) }
      for (const event of session.events) {
        if (!("cellId" in event)) continue
        const cell = cells.get(event.cellId); if (!cell) continue
        if (event.type === "code/output") {
          if (cell.output.length >= 100) { cell.truncated = true; continue }
          const content = event.content as { type?: string; text?: string } | null
          cell.output.push({ kind: content?.type ?? "value", text: clip(cell, content?.type === "text" ? content.text : event.content), seq: event.seq })
        } else if (event.type === "code/call") {
          if (cell.calls.length >= 100) { cell.truncated = true; continue }
          cell.calls.push({ id: event.callId, parentCallId: event.parentCallId, name: event.name, args: clip(cell, event.args), dispatched: false, seq: event.seq })
        } else if (event.type === "code/dispatch" || event.type === "code/result") {
          const call = cell.calls.find(call => call.id === event.callId)
          if (call && event.type === "code/dispatch") call.dispatched = true
          if (call && event.type === "code/result") { call.output = clip(cell, event.output); call.isError = event.isError === true }
        }
      }
      return { sessionId, live: Boolean(assembly), ...(assembly?.executionState ? { effectiveMode: assembly.executionState().codeMode } : {}), cells: selected.map(id => cells.get(id)!), total: ids.length, offset, hasMore: offset + limit < ids.length }
    },
    async stop(sessionId: string, cellId: string) {
      resourceId(sessionId); resourceId(cellId); await coordinator.profile(sessionId)
      const assembly = service.liveAssembly(sessionId)
      if (!assembly?.stopCodeCell || !assembly.liveResources?.().codeCells.some(cell => cell.id === cellId)) throw new Error("Cell has no live execution owner; cold history cannot be stopped")
      await assembly.stopCodeCell(cellId)
      await coordinator.flush(sessionId)
      return { stopped: true as const, cellId }
    },
  }
}
