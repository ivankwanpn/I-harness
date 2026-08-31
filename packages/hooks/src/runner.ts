import { spawn } from "node:child_process"
import { dirname } from "node:path"
import type { HookContext, HookHandlerSpec, HookOutput } from "./types.ts"
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_OUTPUT_CAP_BYTES,
  HookBlockedError,
  HookConfigError,
  HookOutputError,
  HookTrustError,
} from "./types.ts"
import { trustScriptPath, verifyHandlerTrust } from "./trust.ts"

export interface RunHookOptions {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
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
  return new Promise<HookOutput>((resolvePromise, rejectPromise) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    let child: ReturnType<typeof spawn>
    const timer = setTimeout(() => {
      child.kill()
      finish(() => rejectPromise(new HookOutputError(`hook ${spec.id}: timed out after ${timeoutMs} ms`)))
    }, timeoutMs)
    timer.unref?.()

    child = spawn(spec.command.cmd, spec.command.args ?? [], {
      cwd: spec.command.cwd ?? dirname(handlerFile),
      windowsHide: true,
      env: { ...process.env, ...opts.env, IH_HOOK_EVENT: context.event, IH_HOOK_ID: spec.id },
      stdio: ["pipe", "pipe", "pipe"],
    })
    // (plan draft used a `{ current: string }` wrapper object per chunk — the
    // captured bytes were discarded, so a junk-stdout handler parsed as `{}`
    // and passed; capture into the live strings under the same byte cap.)
    child.stdout!.on("data", (chunk: Buffer) => { if (stdout.length < HOOK_OUTPUT_CAP_BYTES) stdout += chunk.toString("utf8") })
    child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < HOOK_OUTPUT_CAP_BYTES) stderr += chunk.toString("utf8") })
    child.on("error", (err) => {
      finish(() => rejectPromise(new HookOutputError(`hook ${spec.id}: cannot start ${spec.command.cmd}: ${err.message}`)))
    })
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          const tail = stderr.trim().split(/\r?\n/).slice(-3).join("\n")
          rejectPromise(
            new HookOutputError(`hook ${spec.id}: exited with code ${code}${tail !== "" ? `: ${tail}` : ""}`),
          )
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(stdout.trim() === "" ? "{}" : stdout.trim())
        } catch {
          rejectPromise(new HookOutputError(`hook ${spec.id}: stdout is not valid JSON: ${stdout.trim().slice(0, 120)}`))
          return
        }
        try {
          resolvePromise(validateHookOutput(parsed, spec.id))
        } catch (err) {
          rejectPromise(err)
        }
      })
    })
    try {
      child.stdin!.end(JSON.stringify(context))
    } catch (err) {
      finish(() => rejectPromise(err instanceof Error ? err : new HookOutputError(String(err))))
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
