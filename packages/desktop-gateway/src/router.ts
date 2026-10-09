import {
  decodeFrame,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isRpcRequest,
  isRpcSuccess,
  makeFailure,
  makeSuccess,
  METHOD_NOT_FOUND,
} from "@i-harness/sdk"
import type { SdkServer } from "@i-harness/sdk/server"
import type { DesktopHandlers, GatewayWrite } from "./types.ts"
import { ReviewPathError } from "./review.ts"
import { randomUUID } from "node:crypto"
import { ScheduleInputError } from "@i-harness/schedule"
import { ModelUnavailableError } from "@i-harness/session-executor"
import { memoryRequest } from "./memory-wire.ts"
import { boundSearchHits } from "./search-bounds.ts"
import { providerCommand } from "./provider-wire.ts"
import { createProviderProbes } from "./provider-probes.ts"
import { dispatchGatewayProjectFiles } from "./project-files.ts"
import { dispatchGatewayContentSearch } from "./project-content-search.ts"

/** Augment only an initialize reply, without modifying the SDK server's object. */
export function createGatewayWrite(send: GatewayWrite, handlers: DesktopHandlers, internalIds: Set<string> = new Set()): GatewayWrite {
  return (frame) => {
    if ("id" in frame && internalIds.has(String(frame.id))) return
    if (!isRpcSuccess(frame) || !isInitializeResult(frame.result)) {
      send(frame)
      return
    }
    const capabilities = { ...frame.result.capabilities }
    if (handlers.contextPicker) capabilities["desktop-context-picker"] = ["1"]
    if (handlers.projectFiles) capabilities["desktop-project-files"] = ["1"]
    if (handlers.projectContentSearch) capabilities["desktop-project-content-search"] = ["1"]
    if (handlers.autoTitle) capabilities["desktop-auto-title"] = ["1"]
    if (handlers.codeSettings) capabilities["desktop-code-mode-settings"] = ["1"]
    if (handlers.contextSubsystems) capabilities["desktop-context-subsystems"] = ["1"]
    if (handlers.execution) capabilities["desktop-execution"] = ["1"]
    if (handlers.diagnostics) capabilities["desktop-environment-diagnostics"] = ["1"]
    if (handlers.agentProcesses) capabilities["desktop-agent-processes"] = ["1"]
    if (handlers.approvalRules) capabilities["desktop-approval-rules"] = ["1"]
    if (handlers.draftSession) capabilities["desktop-draft-create"] = ["1"]
    if (handlers.projects) capabilities["desktop-project-scope"] = ["1"]
    if (handlers.input) capabilities["desktop-input"] = ["1"]
    if (handlers.workflow) capabilities["desktop-workflow"] = ["1"]
    if (handlers.agentShell) capabilities["desktop-agent-shell"] = ["1"]
    if (handlers.wslSettings) capabilities["desktop-wsl-settings"] = ["1"]
    if (handlers.resources) capabilities["desktop-resources"] = ["1"]
    if (handlers.resources?.write) capabilities["desktop-resource-authoring"] = ["1"]
    if (handlers.mcp) capabilities["desktop-mcp"] = ["1"]
    if (handlers.hooks) capabilities["desktop-hooks"] = ["1"]
    if (handlers.hooks?.writeConfig) capabilities["desktop-hook-authoring"] = ["1"]
    if (handlers.subagents) capabilities["desktop-subagents"] = ["1"]
    if (handlers.sessionSubagents) capabilities["desktop-subagent-catalog"] = ["1"]
    if (handlers.agentSettings) capabilities["desktop-agent-settings"] = ["1"]
    if (handlers.terminal) capabilities["desktop-terminal"] = ["1"]
    if (handlers.schedules) capabilities["desktop-schedule"] = ["1"]
    if (handlers.workState) capabilities["desktop-work-state"] = ["1"]
    if (handlers.plugins) capabilities["desktop-plugins"] = ["1"]
    if (handlers.rewind) capabilities["desktop-rewind"] = ["1"]
    if (handlers.sessions) capabilities["desktop-sessions"] = ["1"]
    if (handlers.provider !== undefined) capabilities["desktop-provider"] = ["1"]
    if (handlers.memory !== undefined) capabilities["desktop-memory"] = ["1"]
    if (handlers.memory?.update) capabilities["desktop-memory-authoring"] = ["1"]
    if (handlers.compact !== undefined) capabilities["desktop-compaction"] = ["1"]
    if (handlers.sessionQuery !== undefined) capabilities["desktop-session-search"] = ["1"]
    if (handlers.sandboxState !== undefined) capabilities["desktop-sandbox"] = ["1"]
    if (handlers.interaction !== undefined) capabilities["desktop-interaction"] = ["1"]
    if (handlers.review !== undefined) capabilities["desktop-review"] = ["1"]
    send({ ...frame, result: { ...frame.result, capabilities } })
  }
}

function isInitializeResult(value: unknown): value is {
  name: string
  version: string
  protocolVersion: number
  capabilities: Record<string, string[]>
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.name === "string"
    && typeof record.version === "string"
    && typeof record.protocolVersion === "number"
    && record.capabilities !== null
    && typeof record.capabilities === "object"
    && !Array.isArray(record.capabilities)
}

export function createDesktopRouter(base: SdkServer, send: GatewayWrite, handlers: DesktopHandlers, internalIds: Set<string> = new Set()): {
  handleLine(line: string): Promise<void>
  close(): Promise<void>
} {
  let initialized = false
  let closed = false
  const activePrompts = new Map<string, number>()
  const compacting = new Map<string, AbortController>()
  const compactJobs = new Set<Promise<unknown>>()
  const probes = handlers.provider ? createProviderProbes(handlers.provider) : undefined
  const modelSwitches = new Map<string, Promise<unknown>>()

  return {
    async handleLine(line) {
      if (closed) return
      const message = decodeFrame(line)
      if (!message || !isRpcRequest(message)) return

      if (message.method === "initialize") {
        const replyLine = await base.handleLine(line)
        const reply = replyLine === null ? undefined : decodeFrame(replyLine)
        if (isRpcSuccess(reply)) initialized = true
        return
      }

      if (!message.method.startsWith("desktop/")) {
        if (message.method === "session/create" && asRecord(message.params)?.clientToken !== undefined && handlers.draftSession) {
          if (!initialized) { send(makeFailure(message.id, INVALID_REQUEST, "not initialized: send initialize first")); return }
          try { send(makeSuccess(message.id, await handlers.draftSession(asRecord(message.params)!.clientToken as string))) }
          catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
          return
        }
        if (message.method === "shutdown") for (const controller of compacting.values()) controller.abort()
        const scopedSessionId = asRecord(message.params)?.sessionId
        if (typeof scopedSessionId === "string" && modelSwitches.has(scopedSessionId)
          && ["session/prompt", "session/model/set", "session/rewind/execute"].includes(message.method)) {
          send(makeFailure(message.id, INVALID_REQUEST, "session model change is running", { reason: "session_busy" })); return
        }
        if (message.method === "session/cancel" && typeof scopedSessionId === "string" && compacting.has(scopedSessionId)) {
          compacting.get(scopedSessionId)!.abort()
          send(makeSuccess(message.id, { cancelled: true }))
          return
        }
        if ((message.method === "session/model/set" || message.method === "session/rewind/execute")
          && typeof scopedSessionId === "string" && compacting.has(scopedSessionId)) {
          send(makeFailure(message.id, INVALID_REQUEST, "session compaction is running", { reason: "session_busy" }))
          return
        }
        if (message.method === "session/model/set" && typeof scopedSessionId === "string") {
          if (activePrompts.has(scopedSessionId)) { send(makeFailure(message.id, INVALID_REQUEST, "session is busy", { reason: "session_busy" })); return }
          const job = Promise.resolve().then(() => base.handleLine(line))
          modelSwitches.set(scopedSessionId, job)
          try { await job } finally { modelSwitches.delete(scopedSessionId) }
          return
        }
        if (message.method === "session/prompt") {
          const sessionId = asRecord(message.params)?.sessionId
          if (typeof sessionId === "string" && compacting.has(sessionId)) {
            send(makeFailure(message.id, INVALID_REQUEST, "session compaction is running", { reason: "session_busy" }))
            return
          }
          if (typeof sessionId === "string" && sessionId !== "") activePrompts.set(sessionId, (activePrompts.get(sessionId) ?? 0) + 1)
          try { await base.handleLine(line) }
          finally {
            if (typeof sessionId === "string") {
              const remaining = (activePrompts.get(sessionId) ?? 1) - 1
              if (remaining > 0) activePrompts.set(sessionId, remaining)
              else activePrompts.delete(sessionId)
            }
          }
          return
        }
        await base.handleLine(line)
        if (message.method === "session/cancel") {
          const sessionId = asRecord(message.params)?.sessionId
          if (typeof sessionId === "string" && sessionId !== "") { handlers.interaction?.cancelSession?.(sessionId); await handlers.workflow?.cancel(sessionId) }
        }
        return
      }

      if (!initialized) {
        send(makeFailure(message.id, INVALID_REQUEST, "not initialized: send initialize first", {
          reason: "not_initialized",
        }))
        return
      }

      if (["desktop/context-subsystems/state","desktop/context-subsystems/configure","desktop/context-subsystems/action"].includes(message.method)) {
        try{
          if(!handlers.contextSubsystems)throw new Error("Context subsystem settings unavailable")
          const params=message.params as Record<string,unknown>
          const result=message.method.endsWith('/state')?await handlers.contextSubsystems.state():message.method.endsWith('/configure')?await handlers.contextSubsystems.configure(params.patch as import('./context-subsystems.ts').ContextSubsystemConfigure):await handlers.contextSubsystems.action(params.command as import('./context-subsystems.ts').ContextSubsystemAction)
          send(makeSuccess(message.id,result))
        }catch(error){send(makeFailure(message.id,INVALID_PARAMS,error instanceof Error?error.message:String(error)))}
        return
      }
      if (["desktop/auto-title/state", "desktop/auto-title/configure", "desktop/code-mode/state", "desktop/code-mode/configure", "desktop/environment/diagnostics", "desktop/session/execution/read", "desktop/session/execution/stop", "desktop/session/processes/read", "desktop/session/processes/control", "desktop/session/processes/job-output", "desktop/session/processes/terminal-output", "desktop/approval-rules/state", "desktop/approval-rules/add", "desktop/approval-rules/revoke", "desktop/session/batch"].includes(message.method)) {
        const params = asRecord(message.params)
        try {
          if (!params) throw new Error("Invalid Desktop parameters")
          if (params.sessionId !== undefined) {
            if (typeof params.sessionId !== "string" || !params.sessionId || params.sessionId.length > 256) throw new Error("Invalid session identity")
            await handlers.assertSession?.(params.sessionId)
          }
          const sessionId = params.sessionId as string
          let result: unknown
          switch (message.method) {
            case "desktop/auto-title/state": if (!handlers.autoTitle) throw new Error("Auto-title preferences unavailable"); result = handlers.autoTitle.state(); break
            case "desktop/auto-title/configure": if (!handlers.autoTitle) throw new Error("Auto-title preferences unavailable"); result = await handlers.autoTitle.configure(params.autoTitle); break
            case "desktop/code-mode/state": if (!handlers.codeSettings) throw new Error("Code Mode settings unavailable"); result = await handlers.codeSettings.state(sessionId); break
            case "desktop/code-mode/configure": if (!handlers.codeSettings) throw new Error("Code Mode settings unavailable"); result = await handlers.codeSettings.configure(params.patch, sessionId); break
            case "desktop/environment/diagnostics": if (!handlers.diagnostics) throw new Error("Diagnostics unavailable"); result = await handlers.diagnostics.read(sessionId, params.probe as boolean | undefined); break
            case "desktop/session/execution/read": if (!sessionId || !handlers.execution) throw new Error("Execution unavailable"); result = await handlers.execution.read(sessionId, { offset: params.offset as number | undefined, limit: params.limit as number | undefined }); break
            case "desktop/session/execution/stop": if (!sessionId || !handlers.execution || typeof params.cellId !== "string") throw new Error("Execution unavailable"); result = await handlers.execution.stop(sessionId, params.cellId); break
            case "desktop/session/processes/read": if (!sessionId || !handlers.agentProcesses) throw new Error("Processes unavailable"); result = await handlers.agentProcesses.read(sessionId); break
            case "desktop/session/processes/control": if (!sessionId || !handlers.agentProcesses) throw new Error("Processes unavailable"); result = await handlers.agentProcesses.control(sessionId, params.command); break
            case "desktop/session/processes/job-output": if (!sessionId || !handlers.agentProcesses || typeof params.id !== "string") throw new Error("Processes unavailable"); result = await handlers.agentProcesses.jobOutput(sessionId, params.id); break
            case "desktop/session/processes/terminal-output": if (!sessionId || !handlers.agentProcesses || typeof params.id !== "string") throw new Error("Processes unavailable"); result = await handlers.agentProcesses.terminalOutput(sessionId, params.id); break
            case "desktop/approval-rules/state": if (!handlers.approvalRules || !handlers.workspace) throw new Error("Approval rules unavailable"); result = handlers.approvalRules.state(handlers.workspace, handlers.interaction?.pending() ?? []); break
            case "desktop/approval-rules/revoke": if (!handlers.approvalRules || !handlers.workspace || typeof params.ruleId !== "string") throw new Error("Approval rules unavailable"); handlers.approvalRules.revoke(handlers.workspace, params.ruleId); result = { revoked: true }; break
            case "desktop/approval-rules/add": if (!sessionId || !handlers.interaction?.rememberPending || typeof params.requestId !== "string") throw new Error("Approval rules unavailable"); result = await handlers.interaction.rememberPending({ sessionId, requestId: params.requestId, remember: params.remember as import("./approval-rules.ts").RememberApprovalOptions }); break
            case "desktop/session/batch": if (!handlers.sessions) throw new Error("Session management unavailable"); result = await handlers.sessions.batch(params.command as import("./session-management.ts").SessionBatchCommand); break
          }
          send(makeSuccess(message.id, result))
        } catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }

      if (["desktop/session/subagents/list", "desktop/session/subagents/history", "desktop/session/subagents/control"].includes(message.method) && handlers.sessionSubagents) {
        const params = asRecord(message.params)
        try {
          if (typeof params?.sessionId !== "string" || !params.sessionId || params.sessionId.length > 256) throw new Error("Invalid parent session")
          let result: unknown
          if (message.method.endsWith("/list")) result = await handlers.sessionSubagents.list(params.sessionId)
          else {
            if (typeof params.childSessionId !== "string" || !params.childSessionId || params.childSessionId.length > 256) throw new Error("Invalid child session")
            if (message.method.endsWith("/history")) {
              if (params.afterSeq !== undefined && (typeof params.afterSeq !== "number" || !Number.isSafeInteger(params.afterSeq) || params.afterSeq < 0)) throw new Error("Invalid history cursor")
              if (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 1000)) throw new Error("Invalid history limit")
              result = await handlers.sessionSubagents.history(params.sessionId, params.childSessionId, { ...(params.afterSeq !== undefined ? { afterSeq: params.afterSeq as number } : {}), ...(params.limit !== undefined ? { limit: params.limit as number } : {}) })
            } else {
              if (!["followup", "message", "interrupt", "close"].includes(String(params.action)) || (params.text !== undefined && typeof params.text !== "string")) throw new Error("Invalid subagent control")
              result = await handlers.sessionSubagents.control(params.sessionId, params.childSessionId, { action: params.action as "followup" | "message" | "interrupt" | "close", ...(params.text !== undefined ? { text: params.text as string } : {}) })
            }
          }
          send(makeSuccess(message.id, result))
        } catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }

      if (message.method.startsWith("desktop/session/input/") && handlers.input) {
        const params = asRecord(message.params)
        const sessionId = params?.sessionId
        if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) { send(makeFailure(message.id, INVALID_PARAMS, "Invalid session")); return }
        if (compacting.has(sessionId) || modelSwitches.has(sessionId)) { send(makeFailure(message.id, INVALID_REQUEST, "Session is busy")); return }
        try {
          const operation = message.method.slice("desktop/session/input/".length)
          let result: unknown
          if (operation === "submit") {
            if (typeof params?.text !== "string" || !["queue", "steer"].includes(String(params.delivery))) throw new Error("Invalid input")
            result = await handlers.input.admit(sessionId, { text: params.text, delivery: params.delivery as "queue" | "steer", ...(params.context !== undefined ? { context: params.context as string } : {}), ...(params.images !== undefined ? { images: params.images as never } : {}), ...(params.clientToken !== undefined ? { clientToken: params.clientToken as string } : {}) })
          } else if (operation === "state") result = await handlers.input.state(sessionId)
          else if (operation === "resume") result = await handlers.input.resume(sessionId)
          else if (operation === "cancel" && typeof params?.inputId === "string") result = await handlers.input.cancel(sessionId, params.inputId)
          else throw new Error("Invalid input operation")
          send(makeSuccess(message.id, result))
        } catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }

      if (["desktop/project/sync", "desktop/project/configure", "desktop/project/revoke", "desktop/session/project/bind", "desktop/session/project/state"].includes(message.method) && handlers.projects) {
        const params = asRecord(message.params)
        try {
          const result = message.method === "desktop/project/sync" ? await handlers.projects.sync(params?.projects)
            : message.method === "desktop/project/configure" ? await handlers.projects.configure(params?.project)
              : message.method === "desktop/project/revoke" ? await handlers.projects.revoke(String(params?.projectId ?? ""))
                : message.method.endsWith("/state") ? await handlers.projects.state(String(params?.sessionId ?? ""))
                  : await handlers.projects.bind(String(params?.sessionId ?? ""), params?.projectId as string | undefined)
          send(makeSuccess(message.id, result))
        } catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if ((message.method === "desktop/agent-shell/state" || message.method === "desktop/agent-shell/configure") && handlers.agentShell) {
        try { send(makeSuccess(message.id, message.method.endsWith("/state") ? await handlers.agentShell.state() : await handlers.agentShell.configure(asRecord(message.params)?.patch))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/session/workflow/read", "desktop/session/workflow/mutate", "desktop/session/job/output"].includes(message.method) && handlers.workflow) {
        const params = asRecord(message.params)
        try {
          const id = params?.sessionId
          if (typeof id !== "string" || !id || id.length > 256) throw new Error("Invalid session id")
          const result = message.method.endsWith("/read") ? await handlers.workflow.read(id)
            : message.method.endsWith("/mutate") ? await handlers.workflow.mutate(id, params?.command)
              : await handlers.workflow.output(id, String(params?.id ?? ""))
          send(makeSuccess(message.id, result))
        } catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/project-files/content-search", "desktop/project-files/content-cancel", "desktop/project-files/search-preview", "desktop/project-files/external-read", "desktop/project-files/external-preview"].includes(message.method) && handlers.projectContentSearch) {
        try { send(makeSuccess(message.id, await dispatchGatewayContentSearch(message.method, message.params, handlers.projectContentSearch))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/project-files/list", "desktop/project-files/search", "desktop/project-files/read", "desktop/project-files/save"].includes(message.method) && handlers.projectFiles) {
        try { send(makeSuccess(message.id, await dispatchGatewayProjectFiles(message.method, message.params, handlers.projectFiles))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/resources/list", "desktop/resources/read"].includes(message.method) && handlers.resources) {
        const params = asRecord(message.params)
        if ((params?.resourceKind !== "skills" && params?.resourceKind !== "commands") || (message.method.endsWith("/list")
          ? typeof params.query !== "string" || params.query.length > 512 || typeof params.offset !== "number" || !Number.isSafeInteger(params.offset) || params.offset < 0
          : typeof params.name !== "string" || !params.name || params.name.length > 256 || /[\0\r\n]/.test(params.name))) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid resource request")); return
        }
        if ((params?.includeShadowed !== undefined && typeof params.includeShadowed !== "boolean")
          || (params?.source !== undefined && !["workspace", "global", "plugin"].includes(String(params.source)))
          || (params?.pluginId !== undefined && (typeof params.pluginId !== "string" || !params.pluginId || params.pluginId.length > 256))) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid resource source")); return
        }
        try { send(makeSuccess(message.id, message.method.endsWith("/list") ? await handlers.resources.list(params.resourceKind, params.query as string, params.offset as number, params.includeShadowed as boolean | undefined) : await handlers.resources.read(params.resourceKind, params.name as string, params.source as "workspace" | "global" | "plugin" | undefined, params.pluginId as string | undefined) ?? null)) }
        catch (error) { send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/resources/write", "desktop/resources/remove", "desktop/resources/import"].includes(message.method) && handlers.resources) {
        const params = asRecord(message.params)
        try {
          if (!params || (params.source !== "workspace" && params.source !== "global")) throw new Error("Invalid resource source")
          const result = message.method.endsWith("/import")
            ? await handlers.resources.importSkill(params.source, typeof params.selectedPath === "string" ? params.selectedPath : "")
            : message.method.endsWith("/remove")
              ? params.confirmed === true ? await handlers.resources.remove(params as unknown as import("./resources.ts").ResourceRemove) : (() => { throw new Error("Resource removal requires confirmation") })()
              : await handlers.resources.write(params as unknown as import("./resources.ts").ResourceWrite)
          send(makeSuccess(message.id, result))
        } catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/hooks/read-config", "desktop/hooks/write-config", "desktop/hooks/read-script", "desktop/hooks/write-script"].includes(message.method) && handlers.hooks) {
        const params = asRecord(message.params)
        try {
          if (!params || (params.source !== "workspace" && params.source !== "global")) throw new Error("Invalid hook source")
          const result = message.method.endsWith("/read-config") ? await handlers.hooks.readConfig(params.source)
            : message.method.endsWith("/read-script") ? await handlers.hooks.readScript(params.source, String(params.name ?? ""))
              : message.method.endsWith("/write-config") ? await handlers.hooks.writeConfig(params as unknown as import("./hook-authoring.ts").HookConfigWrite)
                : await handlers.hooks.writeScript(params as unknown as import("./hook-authoring.ts").HookScriptWrite)
          send(makeSuccess(message.id, result))
        } catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/mcp/state", "desktop/mcp/mutate", "desktop/mcp/refresh"].includes(message.method) && handlers.mcp) {
        try { send(makeSuccess(message.id, message.method.endsWith("/state") ? await handlers.mcp.state() : message.method.endsWith("/refresh") ? await handlers.mcp.refresh() : await handlers.mcp.mutate(message.params))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/hooks/state", "desktop/hooks/mutate", "desktop/hooks/refresh"].includes(message.method) && handlers.hooks) {
        try { send(makeSuccess(message.id, message.method.endsWith("/state") ? await handlers.hooks.state() : message.method.endsWith("/refresh") ? await handlers.hooks.refresh() : await handlers.hooks.mutate(message.params))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if ((message.method === "desktop/subagents/state" || message.method === "desktop/subagents/mutate") && handlers.subagents) {
        try { send(makeSuccess(message.id, message.method.endsWith("/state") ? await handlers.subagents.state() : await handlers.subagents.mutate(message.params))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/wsl/state", "desktop/wsl/diagnose", "desktop/wsl/repair"].includes(message.method)) {
        try {
          if (!handlers.wslSettings) throw new Error("WSL settings unavailable")
          const params = asRecord(message.params)
          if (params && Object.keys(params).length) throw new Error("Unknown WSL settings action parameter")
          const result = message.method.endsWith("/state") ? await handlers.wslSettings.state() : message.method.endsWith("/diagnose") ? await handlers.wslSettings.diagnose() : await handlers.wslSettings.repair()
          send(makeSuccess(message.id, result))
        } catch (error) { send(makeFailure(message.id, INVALID_REQUEST, error instanceof Error ? error.message : String(error))) }
        return
      }
      if ((message.method === "desktop/agent-settings/state" || message.method === "desktop/agent-settings/configure") && handlers.agentSettings) {
        try { send(makeSuccess(message.id, message.method.endsWith("/state") ? await handlers.agentSettings.state() : await handlers.agentSettings.configure(message.params))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (message.method.startsWith("desktop/rewind/") && handlers.rewind) {
        const params = asRecord(message.params)
        const sessionId = params?.sessionId
        const operation = message.method.slice("desktop/rewind/".length)
        if (typeof sessionId !== "string" || !sessionId || !["points", "plan", "execute"].includes(operation)
          || (operation !== "points" && (typeof params?.target !== "number" || !Number.isInteger(params.target) || params.target < 0 || !["all", "files", "conversation"].includes(String(params.mode))))
          || (operation === "execute" && (typeof params?.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(params.fingerprint)))) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid rewind request")); return
        }
        if (activePrompts.has(sessionId) || compacting.has(sessionId) || modelSwitches.has(sessionId)) {
          send(makeFailure(message.id, INVALID_REQUEST, "Session is busy")); return
        }
        const target = params?.target as number
        const mode = params?.mode as "all" | "files" | "conversation"
        const job = operation === "points" ? handlers.rewind.points(sessionId) : operation === "plan" ? handlers.rewind.plan(sessionId, target, mode) : handlers.rewind.execute(sessionId, target, mode, params!.fingerprint as string)
        modelSwitches.set(sessionId, job)
        try { send(makeSuccess(message.id, await job)) }
        catch (error) { send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))) }
        finally { modelSwitches.delete(sessionId) }
        return
      }
      if (message.method.startsWith("desktop/terminal/") && handlers.terminal) {
        try { send(makeSuccess(message.id, await handlers.terminal.request(message.method, message.params))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/schedule/list", "desktop/schedule/create", "desktop/schedule/delete"].includes(message.method) && handlers.schedules) {
        const params = asRecord(message.params)
        const sessionId = params?.sessionId
        if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid schedule session")); return
        }
        let command: { prompt: string; after_seconds?: number; at?: string; every_seconds?: number } | undefined
        let deleteId: string | undefined
        if (message.method === "desktop/schedule/create") {
          const raw = asRecord(params?.command)
          const fields = raw ? Object.keys(raw) : []
          const selectors = [raw?.after_seconds, raw?.at, raw?.every_seconds].filter((value) => value !== undefined)
          if (!raw || fields.some((field) => !["prompt", "after_seconds", "at", "every_seconds"].includes(field))
            || typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.length > 4096 || selectors.length !== 1
            || (raw.after_seconds !== undefined && (typeof raw.after_seconds !== "number" || !Number.isSafeInteger(raw.after_seconds) || raw.after_seconds < 1))
            || (raw.every_seconds !== undefined && (typeof raw.every_seconds !== "number" || !Number.isSafeInteger(raw.every_seconds) || raw.every_seconds < 300))
            || (raw.at !== undefined && (typeof raw.at !== "string" || raw.at.length > 40))) {
            send(makeFailure(message.id, INVALID_PARAMS, "Invalid schedule rule")); return
          }
          command = { prompt: raw.prompt, ...(raw.after_seconds !== undefined ? { after_seconds: raw.after_seconds as number } : {}), ...(raw.at !== undefined ? { at: raw.at as string } : {}), ...(raw.every_seconds !== undefined ? { every_seconds: raw.every_seconds as number } : {}) }
        }
        if (message.method === "desktop/schedule/delete") {
          if (typeof params?.id !== "string" || !/^schedule-[1-9]\d*$/.test(params.id)) {
            send(makeFailure(message.id, INVALID_PARAMS, "Invalid schedule id")); return
          }
          deleteId = params.id
        }
        if (message.method !== "desktop/schedule/list" && (activePrompts.has(sessionId) || compacting.has(sessionId) || modelSwitches.has(sessionId))) {
          send(makeFailure(message.id, INVALID_REQUEST, "Session is busy")); return
        }
        const schedules = handlers.schedules
        const job = message.method === "desktop/schedule/list" ? schedules.list(sessionId)
          : message.method === "desktop/schedule/create" ? schedules.create(sessionId, command!) : schedules.delete(sessionId, deleteId!)
        if (message.method !== "desktop/schedule/list") modelSwitches.set(sessionId, job)
        try { send(makeSuccess(message.id, await job)) }
        catch (error) {
          const code = error instanceof ScheduleInputError ? INVALID_PARAMS
            : error instanceof ModelUnavailableError || (error instanceof Error && error.message === "session is busy") ? INVALID_REQUEST : INTERNAL_ERROR
          send(makeFailure(message.id, code, error instanceof Error ? error.message : String(error)))
        } finally { if (message.method !== "desktop/schedule/list") modelSwitches.delete(sessionId) }
        return
      }
      if ((message.method === "desktop/session/work-state" || message.method === "desktop/session/todo/write") && handlers.workState) {
        const params = asRecord(message.params)
        const sessionId = params?.sessionId
        if (!params || Object.keys(params).some((key) => !["sessionId", ...(message.method.endsWith("/write") ? ["input"] : [])].includes(key)) || typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid work-state session")); return
        }
        try { send(makeSuccess(message.id, message.method.endsWith("/write") ? await handlers.workState.writeTodos(sessionId, params.input as never) : await handlers.workState.read(sessionId))) }
        catch (error) { send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/plugins/state", "desktop/plugins/mutate", "desktop/plugins/commands", "desktop/plugins/refresh"].includes(message.method) && handlers.plugins) {
        try {
          const result = message.method.endsWith("/state") ? await handlers.plugins.state() : message.method.endsWith("/commands") ? await handlers.plugins.commands() : message.method.endsWith("/refresh") ? (await handlers.plugins.refresh(), { ok: true }) : await handlers.plugins.mutate(message.params)
          send(makeSuccess(message.id, result))
        }
        catch (error) { send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (message.method === "desktop/session/navigation/state" && handlers.sessions) {
        try { send(makeSuccess(message.id, await handlers.sessions.navigation())) }
        catch (error) { send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (message.method === "desktop/session/archived" && handlers.sessions) {
        try { send(makeSuccess(message.id, await handlers.sessions.archived())) }
        catch { send(makeFailure(message.id, INTERNAL_ERROR, "Archived sessions unavailable")) }
        return
      }
      if (message.method === "desktop/session/manage" && handlers.sessions) {
        const params = asRecord(message.params)
        const sessionId = params?.sessionId
        const action = params?.action
        const navigationOnly = ["pin", "unpin", "read", "unread"].includes(String(action))
        if (typeof sessionId !== "string" || !sessionId || !["rename", "archive", "restore", "fork", "pin", "unpin", "read", "unread"].includes(String(action))
          || (action === "rename" && (typeof params?.title !== "string" || !params.title.trim() || params.title.length > 256))) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid session management request")); return
        }
        if (!navigationOnly && (activePrompts.has(sessionId) || compacting.has(sessionId) || modelSwitches.has(sessionId))) {
          send(makeFailure(message.id, INVALID_REQUEST, "Session is busy")); return
        }
        const job = handlers.sessions.mutate(sessionId, action as import("./session-management.ts").SessionManagementAction, params?.title as string | undefined)
        if (!navigationOnly) modelSwitches.set(sessionId, job)
        try { send(makeSuccess(message.id, await job)) }
        catch (error) { send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))) }
        finally { if (!navigationOnly) modelSwitches.delete(sessionId) }
        return
      }
      if ((message.method === "desktop/provider/probe" || message.method === "desktop/provider/probe/cancel") && probes) {
        const params = asRecord(message.params)
        if (typeof params?.token !== "string" || !params.token || params.token.length > 128
          || (message.method === "desktop/provider/probe" && (typeof params.id !== "string" || !params.id || params.id.length > 128))) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid provider probe parameters")); return
        }
        try { send(makeSuccess(message.id, message.method.endsWith("/cancel") ? probes.cancel(params.token) : await probes.start(params.id as string, params.token))) }
        catch { send(makeFailure(message.id, INTERNAL_ERROR, "Provider probe failed or was cancelled. Check endpoint, protocol and credentials.")) }
        return
      }
      if (message.method === "desktop/provider/directory" && handlers.provider !== undefined) {
        try { send(makeSuccess(message.id, await handlers.provider.directory())) }
        catch { send(makeFailure(message.id, INTERNAL_ERROR, "provider directory unavailable")) }
        return
      }
      if (message.method === "desktop/provider/mutate" && handlers.provider !== undefined) {
        try { send(makeSuccess(message.id, await providerCommand(handlers.provider, message.params))) }
        catch { send(makeFailure(message.id, INVALID_PARAMS, "Provider change failed. Check the fields, credential source and configuration file permissions.")) }
        return
      }
      if (message.method.startsWith("desktop/memory/") && handlers.memory !== undefined) {
        try { send(makeSuccess(message.id, memoryRequest(handlers.memory, message.method, message.params))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (message.method === "desktop/session/compact" && handlers.compact !== undefined) {
        const params = asRecord(message.params)
        if (typeof params?.sessionId !== "string" || !params.sessionId
          || (params.instructions !== undefined && (typeof params.instructions !== "string" || params.instructions.length > 4096))) {
          send(makeFailure(message.id, INVALID_PARAMS, "sessionId is required and instructions must be at most 4096 characters"))
          return
        }
        const sessionId = params.sessionId
        if (activePrompts.has(sessionId) || compacting.has(sessionId) || modelSwitches.has(sessionId)) {
          send(makeFailure(message.id, INVALID_REQUEST, "session is busy", { reason: "session_busy" }))
          return
        }
        const controller = new AbortController()
        compacting.set(sessionId, controller)
        const compact = handlers.compact
        const job = Promise.resolve().then(() => compact(sessionId, params.instructions as string | undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(120000)])))
        compactJobs.add(job)
        try {
          send(makeSuccess(message.id, await job))
        } catch (error) {
          send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
        } finally {
          compacting.delete(sessionId)
          compactJobs.delete(job)
        }
        return
      }

      if ((message.method === "desktop/context/search" || message.method === "desktop/context/read") && handlers.contextPicker) {
        try { send(makeSuccess(message.id, await (message.method.endsWith("/search") ? handlers.contextPicker.search(message.params) : handlers.contextPicker.read(message.params)))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (message.method === "desktop/session/search" && handlers.sessionQuery !== undefined) {
        const params = asRecord(message.params)
        if (typeof params?.query !== "string" || !params.query.trim() || params.query.length > 4096
          || (params.sessionId !== undefined && (typeof params.sessionId !== "string" || !params.sessionId))
          || (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100))) {
          send(makeFailure(message.id, INVALID_PARAMS, "query must contain 1-4096 characters and limit must be 1-100"))
          return
        }
        try {
          const hits = await handlers.sessionQuery.search(params.query, {
            ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
          })
          send(makeSuccess(message.id, boundSearchHits(hits)))
        } catch (error) {
          send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
        }
        return
      }

      if (message.method === "desktop/sandbox/state" && handlers.sandboxState !== undefined) {
        try {
          send(makeSuccess(message.id, await handlers.sandboxState()))
        } catch (error) {
          send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
        }
        return
      }

      if (message.method === "desktop/interaction/pending" && handlers.interaction !== undefined) {
        const params = asRecord(message.params)
        if (params === undefined || (params.sessionId !== undefined && (typeof params.sessionId !== "string" || params.sessionId === ""))) {
          send(makeFailure(message.id, INVALID_PARAMS, "sessionId must be a non-empty string when provided"))
          return
        }
        send(makeSuccess(message.id, handlers.interaction.pending(params.sessionId as string | undefined)))
        return
      }

      if ((message.method === "desktop/interaction/reply" || message.method === "desktop/interaction/reply/trusted-human") && handlers.interaction !== undefined) {
        const params = asRecord(message.params)
        const decision = asRecord(params?.decision)
        if (typeof params?.requestId !== "string" || params.requestId === ""
          || typeof params.sessionId !== "string" || params.sessionId === ""
          || decision === undefined
          || !(decision.kind === "approval" && typeof decision.approved === "boolean"
            || decision.kind === "question" && typeof decision.answer === "string")) {
          send(makeFailure(message.id, INVALID_PARAMS, "invalid interaction reply"))
          return
        }
        try {
          await handlers.assertSession?.(params.sessionId)
          const trusted = message.method.endsWith("/trusted-human")
          if (trusted && !handlers.interaction.replyTrustedHuman) throw new Error("Trusted human reply unavailable")
          if (!trusted && decision.remember !== undefined) throw new Error("Remembering requires a trusted human reply")
          const reply = await (trusted ? handlers.interaction.replyTrustedHuman! : handlers.interaction.reply)({
            requestId: params.requestId,
            sessionId: params.sessionId,
            decision: decision.kind === "approval"
              ? { kind: "approval", approved: decision.approved as boolean, ...(decision.remember === undefined ? {} : { remember: decision.remember as import("./approval-rules.ts").RememberApprovalOptions }) }
              : { kind: "question", answer: decision.answer as string },
          })
          send(makeSuccess(message.id, reply))
        } catch (error) {
          send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error)))
        }
        return
      }

      if (["desktop/review/file/save", "desktop/review/stage", "desktop/review/unstage", "desktop/review/commit"].includes(message.method) && handlers.review) {
        const params = asRecord(message.params)
        try {
          let result: unknown
          if (message.method.endsWith("/commit")) {
            if (typeof params?.message !== "string" || !params.message.trim() || params.message.length > 4096) throw new Error("Invalid commit message")
            result = await handlers.review.commit(params.message)
          } else {
            if (typeof params?.path !== "string" || !params.path) throw new Error("Invalid file path")
            if (message.method.endsWith("/save")) {
              if (typeof params.text !== "string" || typeof params.expectedRevision !== "string") throw new Error("Invalid file edit")
              result = await handlers.review.saveFile(params.path, params.text, params.expectedRevision)
            } else result = message.method.endsWith("/unstage") ? await handlers.review.unstage(params.path) : await handlers.review.stage(params.path)
          }
          send(makeSuccess(message.id, result))
        } catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (message.method === "desktop/review/changes" && handlers.review !== undefined) {
        try {
          send(makeSuccess(message.id, await handlers.review.changes()))
        } catch (error) {
          send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
        }
        return
      }

      if ((message.method === "desktop/review/diff" || message.method === "desktop/review/file") && handlers.review !== undefined) {
        const params = asRecord(message.params)
        const maxBytes = params?.maxBytes
        if (typeof params?.path !== "string" || params.path === ""
          || (maxBytes !== undefined && (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1))) {
          send(makeFailure(message.id, INVALID_PARAMS, "path must be text and maxBytes a positive integer"))
          return
        }
        try {
          const result = message.method === "desktop/review/diff"
            ? await handlers.review.diff(params.path, maxBytes as number | undefined)
            : await handlers.review.file(params.path, maxBytes as number | undefined)
          send(makeSuccess(message.id, result))
        } catch (error) {
          send(makeFailure(message.id, error instanceof ReviewPathError ? INVALID_PARAMS : INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error)))
        }
        return
      }

      send(makeFailure(message.id, METHOD_NOT_FOUND, `unknown method: ${message.method}`))
    },
    async close() {
      await handlers.projectContentSearch?.close()
      if (closed) return
      closed = true
      await probes?.close()
      await Promise.allSettled(modelSwitches.values())
      for (const controller of compacting.values()) controller.abort()
      for (const sessionId of activePrompts.keys()) {
        const id = `desktop-internal-${randomUUID()}`
        internalIds.add(id)
        try { await base.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method: "session/cancel", params: { sessionId } })) }
        finally { internalIds.delete(id) }
      }
      await Promise.allSettled([...compactJobs])
      await base.close()
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
