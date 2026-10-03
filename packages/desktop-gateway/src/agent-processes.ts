import { randomUUID } from "node:crypto"
import type { SessionEvent } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import type { TerminalView } from "@i-harness/terminal"
import { foldJobs, projectJobsDoc, type JobView } from "@i-harness/jobs"
import { boundedInteger, resourceId, readDesktopSnapshot } from "./execution.ts"

export type AgentProcessCommand =
  | { action: "read"; id: string; offset?: number }
  | { action: "send"; id: string; data: string }
  | { action: "resize"; id: string; cols: number; rows: number }
  | { action: "signal"; id: string; signal: "INT" | "TERM" | "KILL" }
  | { action: "close"; id: string }
  | { action: "job/cancel"; id: string }
export interface AgentProcessesView {
  sessionId: string; live: boolean
  terminals: (Omit<TerminalView, "pid" | "command" | "cols" | "rows" | "beganAt"> & { pid?: number; command?: string; cols?: number; rows?: number; beganAt?: string; live: boolean; canControl: boolean; outputAvailable?: boolean; outputReason?: string })[]
  jobs: (JobView & { ownerSessionId: string; live: boolean; canCancel: boolean })[]
}
export type AgentProcessesRequest =
  | { kind: "desktop/session/processes/read"; workspaceId: string; sessionId: string }
  | { kind: "desktop/session/processes/control"; workspaceId: string; sessionId: string; command: AgentProcessCommand }
  | { kind: "desktop/session/processes/job-output"; workspaceId: string; sessionId: string; id: string }
  | { kind: "desktop/session/processes/terminal-output"; workspaceId: string; sessionId: string; id: string }

function savedTerminals(events: SessionEvent[], sessionId: string) {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  const terminals = new Map<string, AgentProcessesView["terminals"][number] & { text: string; truncated: boolean; dropped: boolean; endOffset?: number }>()
  const names = new Set(["terminal_open", "process_spawn", "terminal_read", "terminal_close", "terminal_signal", "process_kill", "process_resize_pty"])
  for (const event of events) {
    if ((event.type === "tool/call" || event.type === "code/call") && names.has(event.name)) {
      calls.set(event.callId, { name: event.name, args: event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {} })
      if (calls.size > 512) calls.delete(calls.keys().next().value!)
      continue
    }
    if (event.type !== "tool/result" && event.type !== "code/result") continue
    const call = calls.get(event.callId); calls.delete(event.callId)
    if (!call || call.name !== event.name || !event.output || typeof event.output !== "object") continue
    const result = event.output as Record<string, unknown>
    if ("error" in result || result.ownerSessionId !== undefined && result.ownerSessionId !== sessionId) continue
    const id = typeof result.id === "string" ? result.id : call.args.id
    if (typeof id !== "string" || !id || id.length > 256 || call.args.id !== undefined && call.args.id !== id) continue
    let row = terminals.get(id)
    if (!row) {
      row = { id, ownerSessionId: sessionId, status: "running", live: false, canControl: false, outputAvailable: false, outputReason: "No terminal_read output was saved", text: "", truncated: false, dropped: false }
      terminals.set(id, row)
      if (terminals.size > 200) terminals.delete(terminals.keys().next().value!)
    }
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

/** Saved shell tool results are evidence of submission/output, never of a
 * live process. A saved running state remains explicitly unconfirmed. */
function savedShellJobs(events: SessionEvent[]) {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  const jobs = new Map<string, JobView & { output: string; outputTruncated: boolean }>()
  for (const event of events) {
    if (event.type === "tool/call" || event.type === "code/call") {
      calls.set(event.callId, { name: event.name, args: event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {} })
    } else if (event.type === "tool/result" || event.type === "code/result") {
      const call = calls.get(event.callId)
      calls.delete(event.callId)
      if (!call || call.name !== event.name || event.isError || !event.output || typeof event.output !== "object" || Array.isArray(event.output)) continue
      const result = event.output as Record<string, unknown>
      if ("error" in result) continue
      if (["shell", "bash", "pwsh"].includes(event.name) && typeof result.job_id === "string" && result.job_id.length > 0 && result.job_id.length <= 256 && !result.job_id.includes("\0")) {
        const label = typeof call?.args.command === "string" ? call.args.command.slice(0, 256) : result.job_id
        jobs.set(result.job_id, { jobId: result.job_id, kind: "shell", label, status: "running", output: "", outputAvailable: false, outputTruncated: false })
      } else if (event.name === "job_output" && typeof call?.args.job_id === "string") {
        const row = jobs.get(call.args.job_id); if (!row) continue
        // The registered job_output returns a full retained snapshot in text,
        // including its status footer. Repeated reads replace, never append.
        // Older saved DTOs used stdout/stderr; no spill path is read here.
        const text = typeof result.text === "string" ? result.text : `${typeof result.stdout === "string" ? result.stdout : ""}${typeof result.stderr === "string" ? result.stderr : ""}`
        row.output = text.slice(0, 131072); row.outputAvailable = Boolean(text); row.outputTruncated = result.truncated === true || text.length > 131072
        if (["running", "completed", "killed", "error"].includes(String(result.status))) row.status = result.status as JobView["status"]
      }
    }
  }
  return jobs
}

export function createAgentProcesses(coordinator: SessionCoordinator, service: Pick<SessionService, "liveAssembly">) {
  return {
    async read(sessionId: string): Promise<AgentProcessesView> {
      resourceId(sessionId); await coordinator.profile(sessionId)
      const assembly = service.liveAssembly(sessionId)
      const session = assembly?.session ?? await readDesktopSnapshot(coordinator, sessionId)
      const jobs = new Map([...savedShellJobs(session.events).values(), ...projectJobsDoc(await coordinator.getDocument(sessionId)), ...foldJobs(session.events)].map(job => [job.jobId, job]))
      const tasks = assembly?.tasks() ?? []
      const background = assembly?.backgroundJobs?.().filter(job => job.ownerSessionId === sessionId) ?? []
      const terminals = new Map([...savedTerminals(session.events, sessionId).values()].map(({ text: _text, truncated: _truncated, dropped: _dropped, endOffset: _offset, ...row }) => [row.id, row]))
      for (const row of assembly?.liveResources?.().terminals ?? []) if (row.ownerSessionId === sessionId) terminals.set(row.id, { ...row, live: true, canControl: row.status === "running", outputAvailable: true })
      for (const job of background) jobs.set(job.id, { jobId: job.id, kind: job.kind, label: job.id, status: job.status, outputAvailable: Boolean(job.output) })
      return { sessionId, live: Boolean(assembly), terminals: [...terminals.values()].slice(-200),
        jobs: [...jobs.values()].slice(-200).map(job => {
          const task = tasks.find(task => task.id === job.jobId); const active = background.find(row => row.id === job.jobId)
          return { jobId: job.jobId, kind: job.kind, label: job.label, status: job.status, outputAvailable: job.outputAvailable, startedAt: job.startedAt, endedAt: job.endedAt,
            ownerSessionId: sessionId, live: Boolean(task || active), canCancel: active ? active.status === "running" : task?.canCancel === true }
        }) }
    },
    async terminalOutput(sessionId: string, id: string) {
      resourceId(sessionId); resourceId(id); await coordinator.profile(sessionId)
      const assembly = service.liveAssembly(sessionId)
      const session = assembly?.session ?? await readDesktopSnapshot(coordinator, sessionId)
      const row = savedTerminals(session.events, sessionId).get(id)
      if (!row?.outputAvailable) throw new Error("Saved terminal output unavailable for this owner")
      return { text: row.text, truncated: row.truncated, dropped: row.dropped, reason: row.outputReason, ownerSessionId: sessionId, live: false }
    },
    async control(sessionId: string, input: unknown) {
      resourceId(sessionId); await coordinator.profile(sessionId)
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid process command")
      const command = input as Record<string, unknown>; const id = resourceId(command.id)
      const allowed: Record<string, string[]> = { read: ["offset"], send: ["data"], resize: ["cols", "rows"], signal: ["signal"], close: [], "job/cancel": [] }
      const fields = allowed[String(command.action)]
      if (!fields || Object.keys(command).some(key => !["action", "id", ...fields].includes(key))) throw new Error("Unsupported process command")
      const assembly = service.liveAssembly(sessionId)
      if (!assembly) throw new Error("No live process owner; cold history cannot control a process")
      if (command.action === "job/cancel") {
        const background = assembly.backgroundJobs?.().some(job => job.id === id && job.ownerSessionId === sessionId && job.status === "running")
        if (!background && !assembly.tasks().some(task => task.id === id && task.group === "job" && task.canCancel)) throw new Error("Job is not live or cancellable for this owner")
        const prepared = await assembly.tools.prepare({ name: "job_kill", args: { job_id: id, reason: "Stopped by user" } }, undefined, { sessionId, callId: `desktop-job-${randomUUID()}` })
        const output = await assembly.tools.dispatch(prepared); await assembly.tools.finalize(prepared, output)
        await coordinator.flush(sessionId); return output
      }
      const row = assembly.liveResources?.().terminals.find(row => row.id === id && row.ownerSessionId === sessionId)
      if (!row || (command.action !== "read" && row.status !== "running")) throw new Error("Terminal has no live process owner in this session")
      let name: string; let args: Record<string, unknown> = { id }
      switch (command.action) {
        case "read": name = "terminal_read"; args = { id, offset: boundedInteger(command.offset, 0, Number.MAX_SAFE_INTEGER, 0), maxBytes: 32768 }; break
        case "send":
          if (typeof command.data !== "string" || command.data.length > 32768) throw new Error("Terminal input exceeds limit")
          name = "terminal_send"; args.data = command.data; break
        case "resize": name = "process_resize_pty"; args.cols = boundedInteger(command.cols, 2, 500); args.rows = boundedInteger(command.rows, 2, 500); break
        case "signal":
          if (!["INT", "TERM", "KILL"].includes(String(command.signal))) throw new Error("Invalid process signal")
          name = "terminal_signal"; args.signal = command.signal; break
        case "close": name = "terminal_close"; break
        default: throw new Error("Unsupported process command")
      }
      // UI carries no arbitrary tool name, executable, owner, or escalation.
      // Prepare/dispatch preserve the registry's role, hooks, Plan, approval,
      // sandbox, and service ownership checks at the actual action boundary.
      const prepared = await assembly.tools.prepare({ name, args }, undefined, { sessionId, callId: `desktop-process-${randomUUID()}` })
      const output = await assembly.tools.dispatch(prepared)
      await assembly.tools.finalize(prepared, output)
      if (output && typeof output === "object" && "error" in output) throw new Error(String(output.error))
      return output
    },
    async jobOutput(sessionId: string, id: string) {
      resourceId(sessionId); resourceId(id); await coordinator.profile(sessionId)
      const assembly = service.liveAssembly(sessionId)
      const background = assembly?.backgroundJobs?.().find(job => job.id === id && job.ownerSessionId === sessionId)
      if (background) return { text: background.output.slice(0, 131072), truncated: background.outputTruncated || background.output.length > 131072, ownerSessionId: sessionId, live: true }
      const doc = assembly?.subagentState() ?? await coordinator.getDocument(sessionId) as { jobs?: { id: string; output?: string }[] } | undefined
      const job = doc?.jobs?.find(job => job.id === id)
      if (!job) {
        const session = assembly?.session ?? await readDesktopSnapshot(coordinator, sessionId)
        const saved = savedShellJobs(session.events).get(id)
        if (!saved?.outputAvailable) throw new Error("Job output unavailable for this owner")
        return { text: saved.output, truncated: saved.outputTruncated, ownerSessionId: sessionId, live: false }
      }
      const text = job.output ?? ""
      return { text: text.slice(0, 131072), truncated: text.length > 131072, ownerSessionId: sessionId, live: Boolean(assembly?.tasks().some(task => task.id === id)) }
    },
  }
}
