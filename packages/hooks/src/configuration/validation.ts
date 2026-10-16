import type { HandlerMatcher, HookEventName, HookHandlerSpec } from "../types.ts"
import { HOOK_EVENTS, HookConfigError } from "../types.ts"

export function validateSpec(entry: unknown, configPath: string): HookHandlerSpec {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new HookConfigError(`hook handler entry must be an object (${configPath})`)
  }
  const e = entry as Record<string, unknown>
  if (Object.hasOwn(e, "claude")) throw new HookConfigError("native hook declarations cannot supply runtime Claude metadata")
  if (typeof e.id !== "string" || e.id.trim() === "") throw new HookConfigError("hook handler id must be a non-blank string")
  if (!(HOOK_EVENTS as readonly string[]).includes(e.event as string)) {
    throw new HookConfigError(`hook handler ${e.id}: unknown event ${JSON.stringify(e.event)}`)
  }
  if (e.type !== "command" && e.type !== "mcpTool" && e.type !== "prompt" && e.type !== "agent") {
    throw new HookConfigError(`hook handler ${e.id}: type must be command|mcpTool|prompt|agent`)
  }
  const command = e.command as Record<string, unknown> | undefined
  if (typeof command !== "object" || command === null || typeof command.cmd !== "string" || command.cmd === "") {
    throw new HookConfigError(`hook handler ${e.id}: command.cmd must be a non-blank string`)
  }
  if (command.args !== undefined && (!Array.isArray(command.args) || !command.args.every((a) => typeof a === "string"))) {
    throw new HookConfigError(`hook handler ${e.id}: command.args must be an array of strings`)
  }
  const trust = e.trust as Record<string, unknown> | undefined
  if (typeof trust !== "object" || trust === null
    || typeof trust.script !== "string" || trust.script === ""
    || typeof trust.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(trust.sha256)) {
    throw new HookConfigError(`hook handler ${e.id}: trust.script (non-blank) and trust.sha256 (64 hex chars) are required`)
  }
  const spec: HookHandlerSpec = {
    id: e.id,
    event: e.event as HookEventName,
    type: e.type as HookHandlerSpec["type"],
    command: {
      cmd: command.cmd,
      ...(command.args !== undefined ? { args: [...command.args as string[]] } : {}),
      ...(typeof command.cwd === "string" ? { cwd: command.cwd } : {}),
    },
    trust: { script: trust.script, sha256: trust.sha256.toLowerCase() },
  }
  if (e.matcher !== undefined) {
    const m = e.matcher as Record<string, unknown>
    if (typeof m !== "object" || m === null) throw new HookConfigError(`hook handler ${e.id}: matcher must be an object`)
    const matcher: HandlerMatcher = {}
    if (typeof m.tool === "string") matcher.tool = m.tool
    if (typeof m.toolRegex === "string") matcher.toolRegex = m.toolRegex
    if (matcher.tool === undefined && matcher.toolRegex === undefined) {
      throw new HookConfigError(`hook handler ${e.id}: matcher must define tool and/or toolRegex`)
    }
    spec.matcher = matcher
  }
  if (e.timeoutMs !== undefined && (typeof e.timeoutMs !== "number" || !Number.isInteger(e.timeoutMs) || e.timeoutMs <= 0)) {
    throw new HookConfigError(`hook handler ${e.id}: timeoutMs must be a positive integer`)
  }
  if (typeof e.timeoutMs === "number") spec.timeoutMs = e.timeoutMs
  return spec
}
