import { existsSync } from "node:fs"
import { createTerminalService } from "@i-harness/terminal"
import { createExecService, withExecCallerScope } from "@i-harness/exec"
import { shellProfiles, type ShellEnvironment } from "./terminal-shells.ts"

const owner = { sessionId: "desktop-user" }

function integer(value: unknown, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid terminal dimension or cursor")
  return value
}
export function createDesktopTerminal(workspace: string, environment: Partial<ShellEnvironment> = {}) {
  const exec = createExecService({ workspaceRoot: workspace, standaloneOwner: owner })
  const service = createTerminalService(exec)
  const shellEnvironment: ShellEnvironment = { env: environment.env ?? process.env, platform: environment.platform ?? process.platform, exists: environment.exists ?? existsSync }
  let closed = false
  let closing: Promise<void> | undefined
  // Counts admissions without a committed view and failed admissions whose
  // native cleanup has not been proven. A successful close drains both owners.
  const openReservations = new Set<symbol>()
  return {
    async request(method: string, input: unknown) {
      if (closed || closing) throw new Error("Terminal service is closed")
      const params = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
      if (method === "desktop/terminal/list") return service.list()
      if (method === "desktop/terminal/options") return shellProfiles(shellEnvironment).map(({ id, label, command }) => ({ id, label, command }))
      if (method === "desktop/terminal/open") {
        if (service.list().length + openReservations.size >= 8) throw new Error("Close an existing terminal before opening another")
        const selected = params.shell === undefined ? "auto" : params.shell
        if (typeof selected !== "string") throw new Error("Invalid terminal shell")
        const profile = shellProfiles(shellEnvironment).find((entry) => entry.id === selected)
        if (!profile) throw new Error(`Terminal shell ${selected} is unavailable`)
        const cols = integer(params.cols, 2, 500, 100)
        const rows = integer(params.rows, 2, 500, 30)
        const reservation = Symbol("desktop-terminal-open")
        openReservations.add(reservation)
        // A rejected admission can still own incomplete native cleanup without
        // a view ID. Keep its capacity until service and exec disposal succeed.
        try {
          const opened = await withExecCallerScope(owner, () => service.open({ command: profile.command, args: profile.args, cwd: workspace, rawOutput: true, cols, rows }, owner))
          openReservations.delete(reservation)
          return opened
        } catch (cause) {
          // ExecService reports failed rollback/settlement as an AggregateError;
          // the terminal adapter also names incomplete late-handle cleanup.
          // Other admission errors have completed their rollback before reject.
          const incomplete = cause instanceof AggregateError
            || (cause instanceof Error && /cleanup (?:incomplete|failed)/i.test(cause.message))
          if (!incomplete) openReservations.delete(reservation)
          throw cause
        }
      }
      if (typeof params.id !== "string" || !params.id || params.id.length > 128) throw new Error("Invalid terminal id")
      switch (method) {
        case "desktop/terminal/read": return service.read(params.id, { ...owner, offset: integer(params.offset, 0, Number.MAX_SAFE_INTEGER, 0), maxBytes: 32768 })
        case "desktop/terminal/write":
          if (typeof params.data !== "string" || params.data.length > 32768) throw new Error("Terminal input too large")
          await service.send(params.id, params.data, owner); return { ok: true }
        case "desktop/terminal/resize": return service.resize(params.id, integer(params.cols, 2, 500), integer(params.rows, 2, 500), owner)
        case "desktop/terminal/close": return service.close(params.id, owner)
        default: throw new Error("Unknown terminal operation")
      }
    },
    close() {
      if (closed) return Promise.resolve()
      if (closing) return closing
      const attempt = (async () => { await service.dispose(); await exec.dispose(); openReservations.clear(); closed = true })()
      closing = attempt
      void attempt.finally(() => { if (closing === attempt) closing = undefined }).catch(() => {})
      return attempt
    },
  }
}
