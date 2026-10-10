import type { CompiledSandboxPolicy, ExecutionTransport, TransportExecutionBackend, ProcessSpec } from "@i-harness/sandbox"
import { createWslExecutionBackend, type WslExecutionOptions } from "@i-harness/sandbox-wsl"
import { createWindowsPsecBackend, createWindowsUnrestrictedBackend } from "@i-harness/sandbox-windows-psec"
import type { WindowsExecutionBackend } from "@i-harness/sandbox-windows-psec"
import { createWindowsAclSandbox } from "@i-harness/sandbox-windows-acl"
import { createLegacyWindowsBackend } from "./windows-legacy.ts"
import { createPosixExecutionBackend } from "./posix-execution.ts"
import type { PosixExecutionBackend } from "./posix-execution.ts"

export interface LocalExecutionBackends {
  /** Select exactly once before preparation. The caller retains the returned backend. */
  select(policy: CompiledSandboxPolicy, transport: ExecutionTransport, spec?: ProcessSpec): TransportExecutionBackend
  /** Release native owners before any legacy grants are revoked. Failed teardown is retryable. */
  dispose(): Promise<void>
}
export interface LocalExecutionOptions {
  platform?: NodeJS.Platform
  windowsSelection?: "legacy" | "psec" | "wsl"
  wslExecution?: WslExecutionOptions & { networkAccess: boolean; workspaceDependencies: boolean }
  windowsWslBackend?: TransportExecutionBackend & { dispose(): Promise<void> }
  windowsPsecBackend?: WindowsExecutionBackend
  windowsUnrestrictedBackend?: WindowsExecutionBackend
  /** Hidden-console native Job owner for the trusted restricted-token runner. */
  windowsLegacyNativeBackend?: WindowsExecutionBackend
  windowsLegacyBackend?: TransportExecutionBackend & { dispose(): void | Promise<void> }
  /** Existing trusted location only; legacy composition disables private temp writes. */
  legacyPrivateTempRoot?: string
  posixBackend?: PosixExecutionBackend
}

export function createLocalExecutionBackends(options: LocalExecutionOptions = {}): LocalExecutionBackends {
  const platform = options.platform ?? process.platform
  const selection = options.windowsSelection ?? "legacy"
  if (selection !== "legacy" && selection !== "psec" && selection !== "wsl") throw new Error("invalid Windows backend selection")
  const wslOptions = Object.freeze({ distribution: options.wslExecution?.distribution ?? "Ubuntu", networkAccess: options.wslExecution?.networkAccess ?? false,
    ...(options.wslExecution?.runtimePath === undefined ? {} : { runtimePath: Object.freeze([...options.wslExecution.runtimePath]) }) })
  const wsl = platform === "win32" && selection === "wsl" ? options.windowsWslBackend ?? createWslExecutionBackend(wslOptions) : undefined
  const psec = platform === "win32" ? options.windowsPsecBackend ?? createWindowsPsecBackend() : undefined
  const unrestricted = platform === "win32" ? options.windowsUnrestrictedBackend ?? createWindowsUnrestrictedBackend() : undefined
  const legacyNative = platform === "win32" && options.legacyPrivateTempRoot !== undefined
    && options.windowsLegacyBackend === undefined
    ? options.windowsLegacyNativeBackend ?? createWindowsUnrestrictedBackend({ consoleMode: "hidden-console" }) : undefined
  const legacy = platform === "win32" ? options.windowsLegacyBackend
    ?? (options.legacyPrivateTempRoot === undefined ? undefined
      : createLegacyWindowsBackend(createWindowsAclSandbox({ writableDirs: [], mode: "read-only",
          privateTempRoot: options.legacyPrivateTempRoot, disablePrivateTempWrites: true, hideChildWindows: true }), legacyNative!)) : undefined
  const posix = platform === "linux" || platform === "darwin" ? options.posixBackend ?? createPosixExecutionBackend() : undefined
  let disposed = false
  return {
    select(policy, transport, spec) {
      if (disposed) throw new Error("local execution backends disposed")
      if (spec?.executionTarget === "wsl") {
        if (!wsl) throw new Error("WSL target requires an explicitly selected Windows WSL backend")
        return wsl
      }
      if (platform === "win32") {
        if (policy.mode === "danger-full-access") return unrestricted!
        if (selection === "psec") return psec!
        // Choose the native surface before preparation. WSL capabilities never
        // grant capabilities to a Windows helper or trigger fallback on error.
        if (selection === "wsl") return transport === "pipe" && policy.referenceRoots.length === 0 && legacy ? legacy : psec!
        if (transport === "pty") throw new Error("legacy Windows PTY is unsupported")
        if (!legacy) throw new Error("legacy Windows adapter is unavailable")
        return legacy
      }
      if (posix) {
        if (policy.mode !== "danger-full-access" && platform !== "linux") throw new Error("confined POSIX requires Linux bwrap")
        return posix
      }
      throw new Error(`execution backend unavailable on ${platform}`)
    },
    async dispose() {
      disposed = true
      const outcomes = await Promise.allSettled([psec?.dispose(), unrestricted?.dispose(), legacyNative?.dispose(), wsl?.dispose()]
        .filter((value): value is Promise<void> => value !== undefined))
      const nativeErrors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      if (nativeErrors.length) throw new AggregateError(nativeErrors.map(outcome => outcome.reason), "native backend teardown incomplete")
      await posix?.dispose()
      await legacy?.dispose()
    },
  }
}
