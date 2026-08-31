import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolCall, ToolDecision } from "@i-harness/core-tools"
import type {
  HandlerMatcher,
  HookContext,
  HookEventName,
  HookHandlerSpec,
  HookOutput,
} from "./types.ts"
import {
  HOOK_EVENTS,
  HookBlockedError,
  HookConfigError,
  HookTrustError,
} from "./types.ts"
import { verifyHandlerTrust } from "./trust.ts"
import { assertAllowed, runHookHandler } from "./runner.ts"

export * from "./types.ts"
export { sha256File, trustScriptPath, verifyHandlerTrust } from "./trust.ts"
export { runHookHandler, validateHookOutput, assertAllowed } from "./runner.ts"

const CONFIG_FILE = "hooks.json"

/** @i-harness/settings config-home convention (no cross-package import). */
export function resolveHooksConfigPath(configDir?: string): string {
  if (configDir !== undefined) return resolve(configDir, CONFIG_FILE)
  const dir = process.env.IH_CONFIG_DIR ?? join(homedir(), ".i-harness")
  return join(dir, CONFIG_FILE)
}

export interface HookRegistryOptions {
  /** Explicit config file path; default <configDir|$IH_CONFIG_DIR|~/.i-harness>/hooks.json. */
  configPath?: string
  /** Base dir for relative trust.script paths; defaults to the config's dirname. */
  configDir?: string
  /** Subprocess env additions/overrides. */
  env?: NodeJS.ProcessEnv
  /** Observer-side failure reporter (trust/config/output errors on non-gate events). Default console.warn. */
  report?: (error: unknown) => void
}

/** One loaded handler with its load-time trust verdict. */
export interface LoadedHandler {
  spec: HookHandlerSpec
  /** false = trust mismatch at load (gates deny, observers skipped). */
  valid: boolean
  trustError?: string
}

export interface HookRegistry {
  /**
   * Programmatic events only: session/start, session/end, subagent/stop
   * (sessionId) and notification (message). Tool/prompt/stop events are
   * fired by the mounted seams — fire() rejects them as not programmatic.
   */
  fire(event: HookEventName, input: { sessionId?: string; message?: string }): Promise<void>
  beginSession(sessionId: string): Promise<void>
  endSession(sessionId: string): Promise<void>
  /** Loaded handlers (config order) with their trust verdicts. */
  handlers(): LoadedHandler[]
}

interface InternalRegistry {
  loaded: LoadedHandler[]
  opts: Required<Pick<HookRegistryOptions, "report" | "env">> & { configDir: string }
}

const TOOL_EVENTS = new Set<HookEventName>(["pre-tool", "post-tool", "permission"])

function compileMatcher(matcher: HandlerMatcher | undefined): (name: string) => boolean {
  if (matcher === undefined) return () => true
  const exact = matcher.tool !== undefined
    ? (name: string): boolean => name === matcher.tool
    : undefined
  const regex = matcher.toolRegex !== undefined
    ? new RegExp(matcher.toolRegex, "i")
    : undefined
  if (exact === undefined && regex === undefined) throw new HookConfigError("handler matcher must define tool and/or toolRegex")
  return (name: string): boolean => (exact !== undefined ? exact(name) : regex!.test(name))
}

/** Strict config load: version 1, every handler's fields validated. */
export async function loadHooksConfig(configPath: string, configDir: string): Promise<LoadedHandler[]> {
  let text: string
  try {
    text = await readFile(configPath, "utf8")
  } catch (err) {
    throw new HookConfigError(`hooks config ${configPath} unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new HookConfigError(`hooks config ${configPath} is not valid JSON`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HookConfigError("hooks config must be a JSON object")
  }
  const cfg = raw as Record<string, unknown>
  if (cfg.version !== 1) throw new HookConfigError("hooks config version must be 1")
  if (!Array.isArray(cfg.handlers)) throw new HookConfigError("hooks config must carry a handlers array")
  const loaded: LoadedHandler[] = []
  for (const entry of cfg.handlers) {
    const spec = validateSpec(entry, configPath)
    compileMatcher(spec.matcher) // regex validity is a config error
    let trustError: string | undefined
    try {
      await verifyHandlerTrust(spec, configDir)
    } catch (err) {
      trustError = err instanceof Error ? err.message : String(err)
    }
    loaded.push({ spec, valid: trustError === undefined, trustError })
  }
  return loaded
}

function validateSpec(entry: unknown, configPath: string): HookHandlerSpec {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new HookConfigError(`hook handler entry must be an object (${configPath})`)
  }
  const e = entry as Record<string, unknown>
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
  return spec
}

function matches(handler: LoadedHandler, event: HookEventName, toolName?: string): boolean {
  if (handler.spec.event !== event) return false
  if (!TOOL_EVENTS.has(event)) return true
  if (toolName === undefined) return true
  return compileMatcher(handler.spec.matcher)(toolName)
}

/**
 * Run the handlers for one event in config order. gate:true — every failure
 * becomes assertAllowed (deny/ask/block/continue:false → HookBlockedError)
 * and every handler error (trust/output/exit/timeout) also throws
 * fail-closed. gate:false — observer semantics: errors + broken-trust handlers
 * are reported, never fatal.
 */
async function runHandlers(
  registry: InternalRegistry,
  event: HookEventName,
  context: HookContext,
  toolName?: string,
  gate = false,
): Promise<void> {
  for (const handler of registry.loaded) {
    if (!matches(handler, event, toolName)) continue
    if (!handler.valid) {
      const message = handler.trustError ?? "handler failed trust verification"
      if (gate) throw new HookBlockedError(handler.spec.id, message)
      registry.opts.report(new HookTrustError(handler.spec.id, handler.spec.trust.sha256, message))
      continue
    }
    let output: HookOutput
    try {
      output = await runHookHandler(handler.spec, context, registry.opts.configDir, { env: registry.opts.env })
    } catch (err) {
      if (!gate) {
        registry.opts.report(err)
        continue
      }
      throw new HookBlockedError(handler.spec.id, `handler failed closed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (gate) assertAllowed(output, handler.spec.id)
  }
}

/** Permission handlers → ToolDecision | undefined (undefined = no decision). */
async function permissionDecision(
  registry: InternalRegistry,
  call: ToolCall,
): Promise<ToolDecision | undefined> {
  for (const handler of registry.loaded) {
    if (!matches(handler, "permission", call.name)) continue
    if (!handler.valid) {
      return { kind: "deny", reason: `hook handler ${handler.spec.id} failed trust verification` }
    }
    let output: HookOutput
    try {
      output = await runHookHandler(
        handler.spec,
        { event: "permission", tool: { name: call.name, args: call.args } },
        registry.opts.configDir,
        { env: registry.opts.env },
      )
    } catch (err) {
      return { kind: "deny", reason: `hook handler ${handler.spec.id} failed closed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (output.decision === undefined) continue
    if (output.decision === "allow") return { kind: "allow" }
    // ask is not wired to a question seam on main yet — fail closed as deny.
    return { kind: "deny", reason: output.reason ?? output.stopReason ?? `hook handler ${handler.spec.id} requires approval` }
  }
  return undefined
}

/**
 * Create + mount the hooks registry on the running PluginContext:
 *   - pre-tool/post-tool → `tools/execute` cascade wrap (gate);
 *   - permission         → `tools/pre-execute` plain listener producing a
 *     ToolDecision (merged by core-tools' own closed-vocabulary waterfall);
 *   - prompt/submit      → `agent/pre-step` waterfall (block ⇔ throw);
 *   - stop               → `agent/stop` listener (block ⇔ throw).
 * The config is loaded up front: an EXPLICIT configPath that is unreadable
 * throws (fail-closed); a missing DEFAULT config simply yields zero handlers
 * (the host may not use hooks at all).
 */
export async function createHookRegistry(
  ctx: PluginContext,
  opts: HookRegistryOptions = {},
): Promise<HookRegistry> {
  const explicitConfigPath = opts.configPath !== undefined
  const configPath = opts.configPath ?? resolveHooksConfigPath(opts.configDir)
  const configDir = opts.configDir ?? dirname(configPath)
  const registry: InternalRegistry = {
    loaded: [],
    opts: {
      report: opts.report ?? ((err: unknown) => console.warn(`[hooks] ${err instanceof Error ? err.message : String(err)}`)),
      env: opts.env ?? {},
      configDir,
    },
  }
  // Missing file: an EXPLICIT configPath fails closed (the caller named a
  // config — its absence is a hard error); a DEFAULT-derived path simply
  // yields zero handlers (a host that never configured hooks).
  if (existsSync(configPath)) {
    registry.loaded = await loadHooksConfig(configPath, configDir)
  } else if (explicitConfigPath) {
    throw new HookConfigError(`hooks config ${configPath} does not exist (explicit configPath)`)
  }

  // 1+2. pre-tool / post-tool around the real tool body (tools/execute cascade).
  ctx.onCascade("tools/execute", async (input, next) => {
    const call = input as { name: string; args: unknown }
    await runHandlers(
      registry,
      "pre-tool",
      { event: "pre-tool", tool: { name: call.name, args: call.args } },
      call.name,
      true,
    )
    const output = await next()
    await runHandlers(
      registry,
      "post-tool",
      { event: "post-tool", tool: { name: call.name, args: call.args } },
      call.name,
      true,
    )
    return output
  })

  // 3. permission: seed the pre-execute chain with a ToolDecision.
  ctx.on("tools/pre-execute", async (payload) => {
    return permissionDecision(registry, payload as ToolCall)
  })

  // 4. prompt/submit: waterfall on agent/pre-step (block ⇔ throw).
  ctx.waterfall("agent/pre-step", async (payload, next) => {
    const resolved = await next(payload)
    const p = resolved as { task?: string }
    await runHandlers(
      registry,
      "prompt/submit",
      { event: "prompt/submit", prompt: typeof p.task === "string" ? p.task : "" },
      undefined,
      true,
    )
    return resolved
  })

  // 5. stop: plain listener on agent/stop (block ⇔ throw).
  ctx.on("agent/stop", async (payload) => {
    const p = payload as { sessionId?: string; finalText?: string; turns?: number }
    await runHandlers(
      registry,
      "stop",
      {
        event: "stop",
        sessionId: typeof p.sessionId === "string" ? p.sessionId : "",
        finalText: typeof p.finalText === "string" ? p.finalText : "",
        turns: typeof p.turns === "number" ? p.turns : 0,
      },
      undefined,
      true,
    )
  })

  return {
    async fire(event, input) {
      if (event === "session/start" || event === "session/end" || event === "subagent/stop") {
        if (typeof input.sessionId !== "string") {
          throw new HookConfigError(`hooks fire(${event}) requires sessionId`)
        }
        await runHandlers(registry, event, { event, sessionId: input.sessionId })
      } else if (event === "notification") {
        await runHandlers(registry, "notification", { event: "notification", message: input.message ?? "" })
      } else {
        throw new HookConfigError(`hooks fire(${event}) is not a programmatic event`)
      }
    },
    async beginSession(sessionId) {
      await runHandlers(registry, "session/start", { event: "session/start", sessionId })
    },
    async endSession(sessionId) {
      await runHandlers(registry, "session/end", { event: "session/end", sessionId })
    },
    handlers: () => registry.loaded.map((h) => ({ ...h, spec: structuredClone(h.spec) })),
  }
}
