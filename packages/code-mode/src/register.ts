import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { append } from "@i-harness/core-session"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { CodeModeExecInput, CodeModeMount, CodeModeMountOptions, CodeModeObservation, CodeModeWaitInput } from "./types.ts"
import { createCodeModeRuntime } from "./runtime.ts"
import { createCodeModeBroker } from "./broker.ts"
import { codeModeDescription } from "./catalog.ts"

function observationOutput(out: CodeModeObservation) {
  if (out.policyRefusal) throw Object.assign(new Error(out.error || "Code Mode policy refusal"), { policyRefusal: true as const })
  const images = out.items.flatMap(item => item.type === "image" ? [item.image] : [])
  return {
    cellId: out.cellId, cell_id: out.cellId, status: out.status, text: out.text, truncated: out.truncated,
    ...(out.error ? { error: out.error } : {}),
    items: out.items.map(item => item.type === "text" ? { type: "text", length: item.text.length }
      : item.type === "image" ? { type: "image", mediaType: item.image.mediaType, name: item.image.name }
        : { type: "audio", bytes: Math.ceil(item.audioUrl.length * .75) }),
    ...(images.length ? { images } : {}),
  }
}

/** Assembly-owned orchestration capability. Nested authority is registry-owned. */
export function registerCodeMode(ctx: PluginContext, tools: ToolRegistry, options: CodeModeMountOptions): CodeModeMount {
  const mode = options.config?.mode ?? "off"
  if (!["off", "mixed", "only"].includes(mode)) throw new Error("Invalid Code Mode mode")
  const broker = createCodeModeBroker(ctx, tools, options)
  const liveCells = new Set<string>()
  const open = new Map<string, string | undefined>()
  for (const event of options.session.events) if (event.type === "code/cell" && event.sessionId === options.sessionId) {
    if (event.state === "started" || event.state === "running") open.set(event.cellId, event.parentCallId)
    else open.delete(event.cellId)
  }
  for (const [cellId, parentCallId] of open) append(options.session, { type: "code/cell", cellId, sessionId: options.sessionId, parentCallId, state: "interrupted", error: "Code Mode execution was interrupted; restart does not restore its continuation" })
  const runtime = createCodeModeRuntime({
    config: options.config,
    tools: () => broker.definitions(),
    invoke: call => broker.invoke(call),
    onEvent(event) {
      if (event.type === "started") {
        broker.startCell(event.cellId)
        liveCells.add(event.cellId)
        append(options.session, { type: "code/cell", cellId: event.cellId, sessionId: options.sessionId ?? event.origin.sessionId, parentCallId: event.origin.callId, state: "started", source: event.source })
      } else if (event.type === "output") append(options.session, { type: "code/output", cellId: event.cellId, content: event.item })
      else {
        liveCells.delete(event.cellId)
        broker.retireCell(event.cellId)
        append(options.session, { type: "code/cell", cellId: event.cellId, sessionId: options.sessionId ?? event.origin.sessionId, parentCallId: event.origin.callId, state: event.status, ...(event.error ? { error: event.error } : {}) })
      }
    },
  })
  let disposed = false
  const execTool: Tool = {
    name: "code_exec", description: "Execute isolated JavaScript to compose the session's tools.", isReadOnly: true,
    inputSchema: { type: "object", properties: { code: { type: "string" }, yield_time_ms: { type: "integer", minimum: 0, maximum: 60_000 }, max_output_tokens: { type: "integer", minimum: 0, maximum: 4096 } }, required: ["code"], additionalProperties: false },
    async execute(args, exec) {
      if (disposed || mode === "off") throw new Error("Code Mode unavailable")
      const out = await runtime.exec(args as CodeModeExecInput, { ...exec, sessionId: options.sessionId ?? exec.sessionId, callId: exec.callId ?? randomUUID() })
      return observationOutput(out)
    },
  }
  const waitTool: Tool = {
    name: "code_wait", description: "Read new output from a running code_exec cell. Use its cell_id; terminate=true stops it. One observer at a time. Saved cells from a previous process cannot be resumed.", isReadOnly: true,
    inputSchema: { type: "object", properties: { cell_id: { type: "string" }, yield_time_ms: { type: "integer", minimum: 0, maximum: 60_000 }, max_tokens: { type: "integer", minimum: 0, maximum: 4096 }, terminate: { type: "boolean" } }, required: ["cell_id"], additionalProperties: false },
    async execute(args, exec) {
      if (disposed || mode === "off") throw new Error("Code Mode unavailable")
      return observationOutput(await runtime.wait(args as CodeModeWaitInput, exec.abortSignal))
    },
  }
  const waitDescription = waitTool.description
  if (mode !== "off") {
    if (tools.get("code_exec") || tools.get("code_wait")) throw new Error("Code Mode tool names are already registered")
    tools.register(execTool); tools.register(waitTool)
  }
  return {
    schemas() {
      if (disposed || mode === "off") return tools.schemas()
      execTool.description = codeModeDescription(tools)
      waitTool.description = liveCells.size ? `${waitDescription}\nCurrently active cell IDs in this session: ${JSON.stringify([...liveCells])}` : waitDescription
      const all = tools.schemas()
      return mode === "only" ? all.filter(s => s.name === "code_exec" || s.name === "code_wait") : all
    },
    async cancel(reason) { await runtime.cancel(reason) },
    async dispose() {
      if (disposed) return
      disposed = true
      try { await runtime.dispose() } finally { await broker.dispose() }
      if (tools.get("code_exec") === execTool) tools.unregister("code_exec")
      if (tools.get("code_wait") === waitTool) tools.unregister("code_wait")
    },
  }
}
