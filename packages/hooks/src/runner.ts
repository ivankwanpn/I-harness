import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import type { HookContext, HookHandlerSpec, HookOutput } from "./types.ts"
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_OUTPUT_CAP_BYTES,
  HookBlockedError,
  HookConfigError,
  HookOutputError,
  HookOwnerAbortError,
  HookTrustError,
} from "./types.ts"
import { trustScriptPath, verifyHandlerTrust } from "./trust.ts"
import { claudeHookPayload, claudeShellEnvironment, normalizeClaudeHookOutput, resolveClaudeShell, sha256ClaudePluginTreeSync, type ClaudeRuntimeInput } from "./claude.ts"
import type { ClaudeSessionSource } from "./types.ts"
import { runWindowsHook } from "./windows-process.ts"

export interface RunHookOptions extends ClaudeRuntimeInput {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  source?: ClaudeSessionSource
  signal?: AbortSignal
  validateCurrent?(): boolean
}

/** The subprocess is created here; terminate only its owned process tree. */
async function terminateHookTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined) return
  // This detached POSIX group stays owned after its launcher exits.
  try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
}

function decodeHookOutput(spec: HookHandlerSpec, stdout: string, stderr: string, code: number | null): HookOutput {
  if (code === 2 && spec.claude !== undefined) {
    const reason = stderr.trim() || `hook ${spec.id} blocked ${spec.claude.event}`
    const event = spec.claude.event
    return event === "Stop" || event === "SubagentStop" ? { continuation: reason }
      : event === "PostToolUse" ? { additionalContext: reason } : { block: true, reason }
  }
  if (code !== 0) {
    const tail = stderr.trim().split(/\r?\n/).slice(-3).join("\n")
    throw new HookOutputError(`hook ${spec.id}: exited with code ${code}${tail ? `: ${tail}` : ""}`)
  }
  if (spec.claude !== undefined) return normalizeClaudeHookOutput(stdout, spec.id, spec.claude.event)
  let parsed: unknown
  try { parsed = JSON.parse(stdout.trim() === "" ? "{}" : stdout.trim()) }
  catch { throw new HookOutputError(`hook ${spec.id}: stdout is not valid JSON: ${stdout.trim().slice(0, 120)}`) }
  return validateHookOutput(parsed, spec.id)
}

/**
 * Strict validation of one parsed handler stdout value: an object whose
 * known fields have the declared types. Anything else throws HookOutputError
 * (fail-closed — never interpreted loosely).
 */
export function validateHookOutput(raw: unknown, handlerId: string): HookOutput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HookOutputError(`hook ${handlerId}: output must be one JSON object`)
  }
  const out = raw as Record<string, unknown>
  const result: HookOutput = {}
  for (const [key, value] of Object.entries(out)) {
    switch (key) {
      case "continue":
      case "block":
        if (typeof value !== "boolean") throw badType(handlerId, key, value)
        result[key] = value
        break
      case "stopReason":
      case "reason":
        if (typeof value !== "string") throw badType(handlerId, key, value)
        result[key] = value
        break
      case "decision":
        if (value !== "allow" && value !== "deny" && value !== "ask") throw badType(handlerId, key, value)
        result.decision = value
        break
      default:
        throw new HookOutputError(`hook ${handlerId}: unknown output field "${key}"`)
    }
  }
  if (result.block === true && result.reason === undefined) {
    throw new HookOutputError(`hook ${handlerId}: block:true requires a reason`)
  }
  return result
}

function badType(handlerId: string, key: string, value: unknown): HookOutputError {
  const expected = key === "decision"
    ? '"allow" | "deny" | "ask"'
    : key === "continue" || key === "block"
      ? "a boolean"
      : "a string"
  return new HookOutputError(`hook ${handlerId}: "${key}" must be ${expected}, got ${JSON.stringify(value)}`)
}

/**
 * Run ONE handler: trust-check → spawn (`cmd args`, no shell, windowsHide,
 * timeout) → stdin = JSON HookContext → stdout must be a single JSON object
 * HookOutput. Every abnormal outcome throws the typed error — gating callers
 * convert it into a fail-closed deny; observer callers report + continue.
 */
export async function runHookHandler(
  spec: HookHandlerSpec,
  context: HookContext,
  configDir: string,
  opts: RunHookOptions = {},
): Promise<HookOutput> {
  if (opts.signal?.aborted) throw new HookOwnerAbortError(spec.id)
  const handlerFile = trustScriptPath(spec, configDir)
  try {
    await verifyHandlerTrust(spec, configDir)
  } catch (err) {
    if (err instanceof HookTrustError) throw err
    throw new HookConfigError(
      `hook handler ${spec.id}: cannot read trust artifact ${handlerFile}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const timeoutMs = spec.timeoutMs ?? opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  if (opts.signal?.aborted) throw new HookOwnerAbortError(spec.id)
  const cwd = spec.command.cwd ?? opts.cwd ?? (spec.claude ? process.cwd() : dirname(handlerFile))
  let executable = spec.command.cmd
  let env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, IH_HOOK_EVENT: context.event, IH_HOOK_ID: spec.id }
  if (spec.claude !== undefined) {
    executable = resolveClaudeShell(spec.claude.shell, env)
    env = claudeShellEnvironment(spec, cwd, env, executable)
  }
  if (process.platform === "win32") {
    let serialized: string
    try { serialized = JSON.stringify(spec.claude !== undefined ? claudeHookPayload(spec, context, cwd, opts) : context) }
    catch (error) { throw new HookOutputError(`hook ${spec.id}: cannot serialize/send context: ${error instanceof Error ? error.message : String(error)}`) }
    const captured = await runWindowsHook({ id: spec.id, argv: [executable, ...(spec.command.args ?? [])], cwd, env,
      input: Buffer.from(serialized), timeoutMs, signal: opts.signal,
      validate: () => {
        if (opts.signal?.aborted) throw new HookOwnerAbortError(spec.id)
        if (opts.validateCurrent?.() === false) throw new HookTrustError(spec.id, spec.trust.sha256, "handler grant changed before dispatch")
        const actual = spec.claude !== undefined ? sha256ClaudePluginTreeSync(spec.claude.pluginRoot)
          : createHash("sha256").update(readFileSync(handlerFile)).digest("hex")
        if (actual !== spec.trust.sha256) throw new HookTrustError(spec.id, spec.trust.sha256, actual)
      },
    })
    return decodeHookOutput(spec, captured.stdout.toString("utf8"), captured.stderr, captured.exitCode)
  }
  return new Promise<HookOutput>((resolvePromise, rejectPromise) => {
    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0
    const startupChunks: Buffer[] = []
    let startupCaptureError: HookOutputError | undefined
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", cancel)
      fn()
    }
    let child: ReturnType<typeof spawn>
    let termination: Promise<void> | undefined
    let terminationError: HookOutputError | undefined
    const terminate = (error: HookOutputError): void => {
      if (settled || termination !== undefined) return
      terminationError = error
      clearTimeout(timer)
      termination = terminateHookTree(child)
    }
    const cancel = (): void => { terminate(new HookOwnerAbortError(spec.id)) }
    const timer = setTimeout(() => {
      terminate(new HookOutputError(`hook ${spec.id}: timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()

    child = spawn(executable, spec.command.args ?? [], {
      cwd,
      windowsHide: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(process.platform !== "win32" ? { detached: true } : {}),
    })
    if (opts.signal?.aborted) cancel()
    else opts.signal?.addEventListener("abort", cancel, { once: true })
    child.stdin!.on("error", (error) => terminate(new HookOutputError(`hook ${spec.id}: cannot send input: ${error.message}`)))
    // (plan draft used a `{ current: string }` wrapper object per chunk — the
    // captured bytes were discarded, so a junk-stdout handler parsed as `{}`
    // and passed; capture into the live strings under the same byte cap.)
    child.stdout!.on("data", (chunk: Buffer) => {
      if (spec.claude !== undefined) {
        if (settled || startupCaptureError !== undefined) return
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > HOOK_OUTPUT_CAP_BYTES) {
          startupCaptureError = new HookOutputError(`hook ${spec.id}: startup stdout exceeds ${HOOK_OUTPUT_CAP_BYTES} bytes`)
          startupChunks.length = 0
          terminate(startupCaptureError)
          return
        }
        startupChunks.push(chunk)
      } else if (stdout.length < HOOK_OUTPUT_CAP_BYTES) stdout += chunk.toString("utf8")
    })
    child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < HOOK_OUTPUT_CAP_BYTES) stderr += chunk.toString("utf8") })
    child.on("error", (err) => {
      finish(() => rejectPromise(new HookOutputError(`hook ${spec.id}: cannot start ${spec.command.cmd}: ${err.message}`)))
    })
    child.on("close", async (code) => {
      if (termination !== undefined) await termination
      finish(() => {
        if (terminationError !== undefined) { rejectPromise(terminationError); return }
        if (startupCaptureError !== undefined) { rejectPromise(startupCaptureError); return }
        try { resolvePromise(decodeHookOutput(spec, spec.claude !== undefined ? Buffer.concat(startupChunks).toString("utf8") : stdout, stderr, code)) }
        catch (error) { rejectPromise(error) }
      })
    })
    try {
      child.stdin!.end(JSON.stringify(spec.claude !== undefined
        ? claudeHookPayload(spec, context, cwd, opts)
        : context))
    } catch (err) {
      terminate(new HookOutputError(`hook ${spec.id}: cannot serialize/send context: ${err instanceof Error ? err.message : String(err)}`))
    }
  })
}

/** The fail-closed gate interpretation of one handler run: a veto → throw. */
export function assertAllowed(output: HookOutput, handlerId: string): void {
  if (output.decision === "deny" || output.decision === "ask") {
    throw new HookBlockedError(
      handlerId,
      output.reason ?? (output.decision === "ask" ? "hook asked (ask unavailable — fail-closed deny)" : "hook denied the action"),
    )
  }
  if (output.block === true || output.continue === false) {
    throw new HookBlockedError(
      handlerId,
      output.reason ?? output.stopReason ?? "hook blocked the action",
    )
  }
}

export { HookBlockedError, HookOutputError, HookTrustError }
