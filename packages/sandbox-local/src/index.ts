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
  if (process.platform === "win32") {
    if (!config.windowsAclBackend) {
      // M16 core: silent absence of the koffi backend means fail-closed
      // (the real backend ships in M16w).
      return {
        confine(_argv, policy) {
          throw new SandboxUnavailableError(policy.mode, "no windows ACL backend composed (M16w)")
        },
      }
    }
    const backend = config.windowsAclBackend
    return {
      // M22: honest capability declaration — the Windows ACL backend has no
      // read isolation (WRITE_RESTRICTED is read-visible on Windows).
      capabilities: { readIsolation: false },
      confine(argv, policy) {
        if (policy.requireReadIsolation === true) {
          throw new SandboxUnavailableError(policy.mode, "local sandbox backends provide no read isolation (capability: none)")
        }
        // On win32, delegate to the injected backend.
        return { ...backend.confine(argv, policy), enforcement: STATIC_ENFORCEMENT["windows-acl"] }
      },
    }
  }

  if (process.platform === "linux") {
    const probe = probeBwrap(config.probeTimeoutMs)
    if (!probe) {
      return {
        confine(_argv, policy) {
          throw new SandboxUnavailableError(policy.mode, "bwrap probe failed")
        },
      }
    }
    return {
      // M22: honest capability declaration — bwrap isolates the filesystem
      // for writes but does not hide/read-block filesystem content, so it has
      // no read isolation either.
      capabilities: { readIsolation: false },
      confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
        const runner = config.runnerCommand ?? ["bwrap"]
        if (runner[0] !== "bwrap") {
          throw new SandboxUnavailableError(policy.mode, `runner override must be bwrap (got ${runner[0]})`)
        }
        if (policy.requireReadIsolation === true) {
          throw new SandboxUnavailableError(policy.mode, "local sandbox backends provide no read isolation (capability: none)")
        }
        return {
          argv: [...runner, ...bwrapProfileArgs(policy), "--", ...argv],
          enforcement: STATIC_ENFORCEMENT.bwrap,
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
    confine(_argv, policy) {
      throw new SandboxUnavailableError(policy.mode, "unsupported platform")
    },
  }
}

// M16 final-review (I2): exported so tests/e2e guards probe the SAME gate
// that createLocalSandbox actually uses (bwrap --version alone passes on hosts
// where user namespaces are blocked, so the e2e would run RED instead of SKIP).
export function probeBwrap(timeoutMs?: number): boolean {
  // spawnSync is correct here: a one-shot bounded probe, not a long-lived process.
  const probe = spawnSync("bwrap", [...bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/" }), "--", "true"], {
    timeout: timeoutMs ?? 5000,
    stdio: "ignore",
  })
  return probe.status === 0
}
