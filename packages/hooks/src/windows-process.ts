import { createHash, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { isAbsolute, join, resolve, win32 } from "node:path"
import { createWindowsUnrestrictedBackend } from "@i-harness/sandbox-windows-psec"
import { HOOK_OUTPUT_CAP_BYTES, HookOutputError, HookOwnerAbortError } from "./types.ts"

type Backend = ReturnType<typeof createWindowsUnrestrictedBackend>
type Handle = Awaited<ReturnType<Awaited<ReturnType<Backend["prepare"]>>["commit"]>>

export interface WindowsHookInput {
  id: string
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input: Uint8Array
  timeoutMs: number
  signal?: AbortSignal
  validate(): void
}

function environment(source: NodeJS.ProcessEnv): Record<string, string> {
  const values = new Map<string, { name: string; value: string }>()
  for (const [name, value] of Object.entries(source)) if (typeof value === "string") values.set(name.toLowerCase(), { name, value })
  return Object.fromEntries([...values.values()].map(({ name, value }) => [name, value]))
}

function executable(command: string, cwd: string, env: Record<string, string>): string {
  if (isAbsolute(command)) return command
  if (command.includes("/") || command.includes("\\")) return resolve(cwd, command)
  const field = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1]
  const path = field("path") ?? ""
  const extensions = win32.extname(command) ? [""] : ["", ...(field("pathext") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
  for (const folder of [cwd, ...path.split(";")]) {
    const directory = folder.trim().replace(/^"|"$/g, "")
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(resolve(cwd, directory), command + extension)
      try { if (statSync(candidate).isFile()) return candidate }
      catch { /* A missing or inaccessible candidate does not stop PATH search. */ }
    }
  }
  throw new HookOutputError(`hook executable ${command} was not found on PATH; install its native prerequisite or configure an absolute command`)
}

/** Explicit reviewed-host-script rights, not inferred from a model sandbox. */
export async function runWindowsHook(input: WindowsHookInput): Promise<{ stdout: Buffer; stderr: string; exitCode: number | null }> {
  const cwd = resolve(input.cwd)
  const backend = createWindowsUnrestrictedBackend()
  const owned = new AbortController()
  let handle: Handle | undefined
  let failure: HookOutputError | undefined
  let cancellation: Promise<unknown> | undefined
  let cleanupFailure: Error | undefined
  const stop = (error: HookOutputError, reason: "cancelled" | "timeout" | "output-limit" = "cancelled"): void => {
    if (failure) return
    failure = error
    owned.abort(error)
    if (handle) cancellation = handle.cancel(reason).then(settlement => {
      if (settlement.kind !== "settled") cleanupFailure ??= new Error(`hook tree cleanup incomplete: ${settlement.detail}`)
    }, error => { cleanupFailure ??= error instanceof Error ? error : new Error(String(error)) })
  }
  const onAbort = () => stop(new HookOwnerAbortError(input.id))
  input.signal?.addEventListener("abort", onAbort, { once: true })
  if (input.signal?.aborted) onAbort()
  const timer = setTimeout(() => stop(new HookOutputError(`hook ${input.id}: timed out after ${input.timeoutMs} ms`), "timeout"), input.timeoutMs)
  timer.unref?.()
  try {
    if (failure) throw failure
    const env = environment(input.env)
    const owner = Object.freeze({ sessionId: `hook-${randomUUID()}` })
    const fingerprint = createHash("sha256").update(owner.sessionId).update(input.id).digest("hex")
    const policy = Object.freeze({ mode: "danger-full-access" as const, owner,
      authorityRevision: fingerprint, authorityKind: "unbound" as const, primaryRoot: cwd,
      readable: "caller" as const, authorityRoots: Object.freeze([cwd]), writeRoots: Object.freeze([]),
      referenceRoots: Object.freeze([]), fingerprint,
    })
    const prepared = await backend.prepare(Object.freeze({ argv: Object.freeze([executable(input.argv[0]!, cwd, env), ...input.argv.slice(1)]), cwd,
      // Retain ownership after the launcher exits so normal descendant output
      // survives; this call still awaits the entire tree and never backgrounds.
      env: Object.freeze(env), owner, transport: "pipe" as const, lifetime: "retain-tree" as const, argumentEncoding: "crt" as const,
    }), policy, owned.signal)
    try { handle = await prepared.commit(input.validate) } catch (error) { await prepared.rollback(); throw error }
    if (failure) {
      cancellation = handle.cancel("cancelled").then(settlement => {
        if (settlement.kind !== "settled") cleanupFailure ??= new Error(`hook tree cleanup incomplete: ${settlement.detail}`)
      }, error => { cleanupFailure ??= error instanceof Error ? error : new Error(String(error)) })
    }
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let stdoutBytes = 0, stderrBytes = 0
    const execution = handle
    const output = (async () => {
      for await (const frame of execution.io.output) {
        const bytes = Buffer.from(frame.data)
        if (frame.channel === "stdout") {
          stdoutBytes += bytes.byteLength
          if (stdoutBytes > HOOK_OUTPUT_CAP_BYTES) { stop(new HookOutputError(`hook ${input.id}: stdout exceeds ${HOOK_OUTPUT_CAP_BYTES} bytes`), "output-limit"); continue }
          stdout.push(bytes)
        } else if (stderrBytes < HOOK_OUTPUT_CAP_BYTES) {
          const part = bytes.subarray(0, HOOK_OUTPUT_CAP_BYTES - stderrBytes)
          stderr.push(part); stderrBytes += part.byteLength
        }
      }
    })().catch(error => stop(new HookOutputError(`hook ${input.id}: output failed: ${error instanceof Error ? error.message : String(error)}`)))
    const send = (async () => {
      for (let offset = 0; offset < input.input.byteLength; offset += 16384) {
        if (failure) return
        await execution.io.write(input.input.subarray(offset, offset + 16384))
      }
      if (!failure) await execution.io.endInput()
    })().catch(error => stop(new HookOutputError(`hook ${input.id}: cannot send input: ${error instanceof Error ? error.message : String(error)}`)))
    const settlement = await execution.settled
    if (settlement.kind !== "settled") {
      cleanupFailure = new Error(`hook tree cleanup incomplete: ${settlement.detail}`)
      // A failed attempt does not release native ownership or necessarily end
      // pending input/output. Request real release before joining their drains.
      try {
        const released = await execution.release()
        if (released.kind !== "settled" && released.detail !== settlement.detail) {
          cleanupFailure = new Error(`${cleanupFailure.message}; release incomplete: ${released.detail}`)
        }
      } catch (error) {
        cleanupFailure = new Error(`${cleanupFailure.message}; release failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await Promise.all([send, output])
    await cancellation
    if (cleanupFailure) throw cleanupFailure
    if (failure) throw failure
    const root = await execution.rootExited
    return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: root.exitCode }
  } catch (error) {
    if (cleanupFailure) throw cleanupFailure
    if (failure) throw failure
    throw error instanceof HookOutputError ? error : new HookOutputError(`hook ${input.id}: cannot run owned process: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", onAbort)
    await backend.dispose()
  }
}
