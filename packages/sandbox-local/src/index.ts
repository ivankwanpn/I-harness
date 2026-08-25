import { spawnSync } from "node:child_process"
import {
  SandboxUnavailableError,
  type ConfinedArgv,
  type SandboxEnforcement,
  type SandboxPolicy,
  type SandboxProvider,
} from "@i-harness/sandbox"
import { bwrapProfileArgs } from "./profiles.ts"

export interface LocalSandboxConfig {
  runnerCommand?: string[]
  runnerFailureSignatures?: string[]
  probeTimeoutMs?: number
  // M16 core: the Windows backend is injected as an opaque SandboxProvider
  // (the real koffi backend lands in M16w). When present it is used on win32.
  windowsAclBackend?: SandboxProvider
}

type Runner = "bwrap" | "windows-acl"

const STATIC_ENFORCEMENT: Record<Runner, SandboxEnforcement> = {
  bwrap: "full",
  "windows-acl": "partial",
}

const DENIAL_SIGNATURES: Record<Runner, readonly string[]> = {
  bwrap: ["read-only file system"],
  "windows-acl": ["access is denied", "access to the path", "permission denied"],
}

export function createLocalSandbox(config: LocalSandboxConfig = {}): SandboxProvider {
  let selected: { runner: Runner; enforcement: SandboxEnforcement } | undefined

  if (process.platform === "win32") {
    if (!config.windowsAclBackend) {
      // M16 core: silent absence of the koffi backend means fail-closed
      // (the real backend ships in M16w).
      return {
        confine() {
          throw new SandboxUnavailableError(modeOf(), "no windows ACL backend composed (M16w)")
        },
      }
    }
    selected = { runner: "windows-acl", enforcement: STATIC_ENFORCEMENT["windows-acl"] }
    const backend = config.windowsAclBackend
    return {
      confine(argv, policy) {
        // On win32, delegate to the injected backend.
        return { ...backend.confine(argv, policy), enforcement: STATIC_ENFORCEMENT["windows-acl"] }
      },
    }
  }

  if (process.platform === "linux") {
    const probe = probeBwrap(config.probeTimeoutMs)
    selected = probe ? { runner: "bwrap", enforcement: STATIC_ENFORCEMENT.bwrap } : undefined
    if (!selected) {
      return {
        confine() {
          throw new SandboxUnavailableError("read-only", "bwrap probe failed")
        },
      }
    }
    return {
      confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
        const runner = config.runnerCommand ?? ["bwrap"]
        if (config.runnerCommand === undefined && runner[0] !== "bwrap") {
          throw new SandboxUnavailableError(policy.mode, "runner override must be bwrap")
        }
        return {
          argv: [...runner, ...bwrapProfileArgs(policy), "--", ...argv],
          enforcement: selected!.enforcement,
          denialSignatures: DENIAL_SIGNATURES.bwrap,
          runnerFailureRules: [
            { allowedExitCodes: [125], fatalSignatures: ["bwrap: failed to"] },
          ],
        }
      },
    }
  }

  // Other platforms: fail closed.
  return {
    confine() {
      throw new SandboxUnavailableError("read-only", "unsupported platform")
    },
  }
}

function modeOf(): "read-only" | "workspace-write" {
  return "read-only"
}

function probeBwrap(timeoutMs?: number): boolean {
  // spawnSync is correct here: a one-shot bounded probe, not a long-lived process.
  const probe = spawnSync("bwrap", [...bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/" }), "--", "true"], {
    timeout: timeoutMs ?? 5000,
    stdio: "ignore",
  })
  return probe.status === 0
}
