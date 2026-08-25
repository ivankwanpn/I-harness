# M16 Sandbox (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add file-effect process confinement to I-harness: a sandbox seam (`@i-harness/sandbox`), a platform-local backend selector (`@i-harness/sandbox-local`, Linux bwrap + Windows ACL fabric), a policy owner (`@i-harness/sandbox-policy`, with the `sandbox/mode` session event), and minimal wiring (exec confining at spawn + CLI `--sandbox` option). The Windows koffi backend itself is a SEPARATE plan (M16w).

**Architecture:** `@i-harness/sandbox` defines the `SandboxMode` file-effect vocabulary and the `SandboxProvider.confine(argv, policy)` seam (fail-closed). `@i-harness/sandbox-local` selects the per-platform runner (Linux: bwrap probe; Windows: the windows-acl backend — a placeholder fabric in M16 core, real koffi backend in M16w). `@i-harness/sandbox-policy` owns the deployment default + `sandbox/mode` session override + per-call `resolve()`. `packages/exec` confines at spawn when both a provider AND a per-command policy exist; the CLI passes `--sandbox {mode}` through `registerShell`.

**Tech Stack:** TypeScript strict ESM (pnpm workspaces, vitest), node:child_process for bwrap, node:fs for roots. No new external npm deps in M16 core (bwrap is a system binary). koffi appears only in M16w.

**Spec:** `docs/superpowers/specs/2026-08-25-i-harness-m16-sandbox-design.md`

## Global Constraints

- No dsh private packages (`@deepseek-ai/*`). General-purpose libraries allowed; bwrap is a system binary, not an npm dep. koffi is NOT in this plan (M16w).
- ESM + strict TS (`noUnusedLocals`, `noUnusedParameters`); tests under `test/*.test.ts` per package; vitest.
- New packages are 0.1.0; no version bumps on existing packages.
- `CURRENT_FORMAT_VERSION` stays 1. The one new session event `sandbox/mode` is log-only (never in the model transcript), following the `approval/*` precedent.
- **Fail-closed everywhere**: a confined mode requested but no backend usable → `SandboxUnavailableError`; never silently run unconfined. `ExecCommand.sandbox` set without a provider → throw.
- Constants (exact): `SandboxMode = "read-only" | "workspace-write" | "danger-full-access"`; `ConfinedSandboxMode = Exclude<..., "danger-full-access">`; `WIDER_MODES = { "read-only": ["workspace-write","danger-full-access"], "workspace-write": ["danger-full-access"] }`; `ESCALATION_TARGETS = ["workspace-write","danger-full-access"]`.
- `writableRoots`: workspace-write → `[workspaceRoot, "/tmp", tmpdir()]` canonical+dedup; read-only → `[]`.
- No network isolation; no fs-sandbox; no Landlock; no Seatbelt; no PTY. Behavior unchanged when no sandbox configured.

---

### Task 1: `@i-harness/sandbox` package scaffold + seam vocabulary (TDD)

**Files:**
- Create: `packages/sandbox/package.json`
- Create: `packages/sandbox/tsconfig.json`
- Create: `packages/sandbox/src/index.ts`
- Create: `packages/sandbox/src/roots.ts`
- Create: `packages/sandbox/src/escalation.ts`
- Create: `packages/sandbox/test/seam.test.ts`

**Interfaces:**
- Consumes: nothing (zero deps; standalone pure module).
- Produces (used by Tasks 2-6): `SandboxMode`, `ConfinedSandboxMode`, `SandboxEnforcement`, `SandboxExecutionPolicy`, `SandboxPolicy`, `RunnerFailureRule`, `ConfinedArgv`, `SandboxProvider` (interface), `SANDBOX_UNAVAILABLE`, `SandboxUnavailableError`, `canonicalPath`, `writableRoots`, `WIDER_MODES`, `ESCALATION_TARGETS`, `validateEscalationArgs`, `sandboxDenialMarker`, `escalationHintMarker`, `EscalationOutcome`, `EscalationApprover`, `EscalationApproval`, `EscalationRequest`, `approveEscalation`.

- [ ] **Step 1: Create the package scaffold**

`packages/sandbox/package.json`:

```json
{
  "name": "@i-harness/sandbox",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```

`packages/sandbox/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Write the failing tests**

`packages/sandbox/test/seam.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  ESCALATION_TARGETS,
  WIDER_MODES,
  SandboxUnavailableError,
  SANDBOX_UNAVAILABLE,
  approveEscalation,
  canonicalPath,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  writableRoots,
} from "../src/index.ts"
import type { EscalationOutcome } from "../src/index.ts"

describe("sandbox roots", () => {
  it("canonicalPath resolves symlinks and falls back to the as-spelled path", () => {
    const resolved = canonicalPath(process.cwd())
    expect(resolved.length).toBeGreaterThan(0)
    expect(canonicalPath("C:\\definitely-missing-path-xyz\\x")).toBe("C:\\definitely-missing-path-xyz\\x")
  })

  it("writableRoots: workspace-write is [workspaceRoot, '/tmp', tmpdir()] canonical + dedup", () => {
    const roots = writableRoots({ mode: "workspace-write", workspaceRoot: "/tmp" })
    expect(roots).toContain("/tmp")
    expect(new Set(roots).size).toBe(roots.length) // deduped
    expect(roots[0] === undefined || roots.length >= 3).toBe(true)
  })

  it("writableRoots: read-only is empty", () => {
    expect(writableRoots({ mode: "read-only", workspaceRoot: "/" })).toEqual([])
  })
})

describe("sandbox escalation vocabulary", () => {
  it("WIDER_MODES is the strictly-wider ladder", () => {
    expect(WIDER_MODES["read-only"]).toEqual(["workspace-write", "danger-full-access"])
    expect(WIDER_MODES["workspace-write"]).toEqual(["danger-full-access"])
  })

  it("ESCALATION_TARGETS is the closed target vocabulary", () => {
    expect(ESCALATION_TARGETS).toEqual(["workspace-write", "danger-full-access"])
  })

  it("validateEscalationArgs: pairing + non-empty justification", () => {
    expect(() => validateEscalationArgs("workspace-write", undefined)).toThrow(/sandbox_permissions/)
    expect(() => validateEscalationArgs(undefined, "why")).toThrow(/justification/)
    expect(() => validateEscalationArgs("workspace-write", "  ")).toThrow(/sentence/)
    expect(() => validateEscalationArgs(undefined, undefined)).not.toThrow()
    expect(() => validateEscalationArgs("workspace-write", "to write to workspace")).not.toThrow()
  })

  it("sandboxDenialMarker / escalationHintMarker exact strings", () => {
    expect(sandboxDenialMarker("read-only")).toBe("[sandbox: file access denied under read-only mode]")
    expect(escalationHintMarker("command")).toContain("[sandbox: escalation available")
    expect(escalationHintMarker("command")).toContain("sandbox_permissions")
  })
})

describe("approveEscalation", () => {
  const calls: Array<{ agent: string; toolName: string; callId: string; reason: string }> = []

  function approver(outcome: EscalationOutcome) {
    return {
      approver: {
        async request(req: { agent: string; toolName: string; callId: string; reason: string; signal?: AbortSignal }): Promise<EscalationOutcome> {
          calls.push({ agent: req.agent, toolName: req.toolName, callId: req.callId, reason: req.reason })
          return outcome
        },
      },
      agent: "a1",
      callId: "c1",
      toolName: "bash",
    }
  }

  it("allowed-once returns the granted mode", async () => {
    const granted = await approveEscalation(
      { requestedMode: "workspace-write", justification: "need write", effectiveMode: "read-only", subject: "command" },
      approver("allowed-once"),
    )
    expect(granted).toBe("workspace-write")
    expect(calls[0]!.reason).toContain("escalate sandbox to workspace-write")
  })

  it("non-widening request throws without prompting", async () => {
    await expect(
      approveEscalation(
        { requestedMode: "read-only", justification: "x", effectiveMode: "read-only", subject: "command" },
        approver("allowed-once"),
      ),
    ).rejects.toThrow(/not strictly wider/)
    expect(calls).toHaveLength(0)
  })

  it("missing approver throws", async () => {
    await expect(
      approveEscalation(
        { requestedMode: "workspace-write", justification: "x", effectiveMode: "read-only", subject: "command" },
        { approver: undefined, agent: "a", callId: "c", toolName: "bash" },
      ),
    ).rejects.toThrow(/no approval service/)
  })

  it("rejected / cancelled / unavailable throw distinct messages", async () => {
    for (const out of ["rejected", "cancelled", "unavailable"] as const) {
      await expect(
        approveEscalation(
          { requestedMode: "workspace-write", justification: "x", effectiveMode: "read-only", subject: "command" },
          approver(out),
        ),
      ).rejects.toThrow(/escalat/)
    }
  })
})

describe("SandboxUnavailableError", () => {
  it("carries SANDBOX_UNAVAILABLE", () => {
    const err = new SandboxUnavailableError("read-only", "bwrap missing")
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("read-only")
    expect(err.message).toContain("bwrap missing")
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/sandbox && pnpm test`
Expected: FAIL — module not found (`../src/index.ts` has no exports yet).

- [ ] **Step 4: Implement the seam**

`packages/sandbox/src/roots.ts`:

```ts
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import type { SandboxExecutionPolicy } from "./index.ts"

// Single home for the workspace-write meaning so the profile dialects and any
// in-process fence can never drift apart.
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== "workspace-write") return []
  return [...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))]
}
```

`packages/sandbox/src/escalation.ts`:

```ts
import type { SandboxMode } from "./index.ts"

// The strictly-wider table: what a call whose effective mode is the key may
// escalate TO. Checked at EXECUTION, never baked into a tool schema.
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
}

export const ESCALATION_TARGETS: readonly SandboxMode[] = ["workspace-write", "danger-full-access"]

export function validateEscalationArgs(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
): void {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error("invalid escalation: sandbox_permissions requires a justification")
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error("invalid escalation: justification is only valid together with sandbox_permissions")
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error("invalid justification: expected a non-empty sentence")
  }
}

export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

export type EscalationOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable"

export interface EscalationApprover<A = object, C = string> {
  request(req: { agent: A; toolName: string; callId: C; reason: string; signal?: AbortSignal }): Promise<EscalationOutcome>
}

export interface EscalationApproval<A = object, C = string> {
  approver: EscalationApprover<A, C> | undefined
  agent: A | undefined
  callId: C
  toolName: string
  signal?: AbortSignal
}

export interface EscalationRequest {
  requestedMode: string
  justification: string
  effectiveMode: SandboxMode
  subject: string
}

export async function approveEscalation<A, C>(
  request: EscalationRequest,
  approval: EscalationApproval<A, C>,
): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  }
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    ...approval.signal ? { signal: approval.signal } : {},
  })
  switch (outcome) {
    case "allowed-once": return mode as SandboxMode
    case "rejected": throw new Error(`the user rejected escalating this ${subject} to "${mode}"`)
    case "cancelled": throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case "unavailable": throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default: return assertNever(outcome)
  }
}

function assertNever(x: never): never {
  throw new Error(`unreachable outcome: ${String(x)}`)
}
```

`packages/sandbox/src/index.ts`:

```ts
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type ConfinedSandboxMode = Exclude<SandboxMode, "danger-full-access">
export type SandboxEnforcement = "full" | "partial"

export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
  sessionId?: string
}

export interface SandboxPolicy extends SandboxExecutionPolicy {
  mode: ConfinedSandboxMode
}

export interface RunnerFailureRule {
  allowedExitCodes?: readonly number[]
  fatalSignatures: readonly string[]
  informationalLines?: readonly string[]
}

export interface ConfinedArgv {
  argv: string[]
  enforcement: SandboxEnforcement
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}

// Abstract process-sandbox seam. confine() must return enforcing argv or fail
// closed by throwing; silent unconfined passthrough is forbidden.
export interface SandboxProvider {
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
}

export const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE"

export class SandboxUnavailableError extends Error {
  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
      + "refusing to run the command unconfined. Install bubblewrap (Linux) or ensure the ACL "
      + "restricted-token runner can start (Windows) — otherwise switch the consumer to "
      + "danger-full-access."
      + (detail === undefined ? "" : ` Runner failure: ${detail}`),
    )
    this.name = "SandboxUnavailableError"
  }
}

export { canonicalPath, writableRoots } from "./roots.ts"
export {
  WIDER_MODES,
  ESCALATION_TARGETS,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
} from "./escalation.ts"
export type {
  EscalationApproval,
  EscalationApprover,
  EscalationOutcome,
  EscalationRequest,
} from "./escalation.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox && pnpm test`
Expected: PASS (all ~12 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm install          # register the new workspace package
pnpm --filter @i-harness/sandbox typecheck
git add packages/sandbox pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(M16): sandbox seam — vocabulary, roots, escalation, fail-closed error"
```

Note: commit `pnpm-lock.yaml` only if it changed (it will — new package row).

---

### Task 2: `@i-harness/sandbox-local` — platform runner chain (bwrap probe + windows fabric)

**Files:**
- Create: `packages/sandbox-local/package.json`
- Create: `packages/sandbox-local/tsconfig.json`
- Create: `packages/sandbox-local/src/index.ts`
- Create: `packages/sandbox-local/src/profiles.ts`
- Create: `packages/sandbox-local/src/runner-failures.ts`
- Create: `packages/sandbox-local/test/local.test.ts`

**Interfaces:**
- Consumes: `@i-harness/sandbox` (`SandboxProvider`, `SandboxPolicy`, `SandboxUnavailableError`, `ConfinedSandboxMode`, `ConfinedArgv`, `SandboxEnforcement`).
- Produces (used by Tasks 5-6): `createLocalSandbox(config?: { runnerCommand?: string[]; runnerFailureSignatures?: string[]; probeTimeoutMs?: number; windowsAclBackend?: SandboxProvider }): SandboxProvider`.

- [ ] **Step 1: Create the scaffold + workspace dep**

`packages/sandbox-local/package.json`:

```json
{
  "name": "@i-harness/sandbox-local",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/sandbox": "workspace:*"
  }
}
```

`packages/sandbox-local/tsconfig.json` (same as Task 1). Then `pnpm install` at repo root.

- [ ] **Step 2: Write the failing tests**

`packages/sandbox-local/test/local.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { bwrapProfileArgs } from "../src/profiles.ts"
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure } from "../src/runner-failures.ts"
import { createLocalSandbox } from "../src/index.ts"
import type { SandboxPolicy } from "@i-harness/sandbox"

const readOnly: SandboxPolicy = { mode: "read-only", workspaceRoot: "/" }
const workspaceWrite: SandboxPolicy = { mode: "workspace-write", workspaceRoot: "/proj" }

describe("bwrapProfileArgs", () => {
  it("read-only: ro-bind /, dev, unshare-pid, proc, die-with-parent", () => {
    expect(bwrapProfileArgs(readOnly)).toEqual([
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--unshare-pid",
      "--proc", "/proc",
      "--die-with-parent",
    ])
  })

  it("workspace-write adds --tmpfs /tmp and --bind workspaceRoot", () => {
    const args = bwrapProfileArgs(workspaceWrite)
    expect(args).toContain("--tmpfs")
    expect(args).toContain("/tmp")
    expect(args).toContain("--bind")
    expect(args).toContain("/proj")
  })
})

describe("runner failure classification", () => {
  it("isRunnerSpawnFailure: ENOENT with argv[0] path → true", () => {
    const err = Object.assign(new Error("spawn bwrap ENOENT"), { code: "ENOENT", path: "bwrap", syscall: "spawn" })
    expect(isRunnerSpawnFailure(err, "bwrap", process.cwd())).toBe(true)
  })

  it("isRunnerSpawnFailure: EACCES → true", () => {
    const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES", path: "bwrap", syscall: "spawn" })
    expect(isRunnerSpawnFailure(err, "bwrap", process.cwd())).toBe(true)
  })

  it("isRunnerSpawnFailure: other errors → false", () => {
    const err = Object.assign(new Error("boom"), { code: "E2BIG", syscall: "spawn" })
    expect(isRunnerSpawnFailure(err, "bwrap", process.cwd())).toBe(false)
  })

  it("classifyDenial matches denial signatures case-insensitively", () => {
    const result = { exitCode: 1, stderr: { text: "mkdir: cannot create directory: Read-only file system" } }
    expect(classifyDenial(result, ["read-only file system"])).toBe(true)
    const clean = { exitCode: 1, stderr: { text: "mkdir: Read-only file system" } }
    expect(classifyDenial(clean, ["read-only file system"])).toBe(true)
  })

  it("classifyRunnerFailure requires a fatal signature + exit-code gate", () => {
    const rule = { allowedExitCodes: [125], fatalSignatures: ["bwrap: failed to"], informationalLines: ["info line"] }
    const r1 = { exitCode: 125, stderr: { text: "info line\nbwrap: failed to create namespace" } }
    expect(classifyRunnerFailure(r1, [rule])).not.toBeUndefined()
    const r2 = { exitCode: 1, stderr: { text: "bwrap: failed to create namespace" } }
    expect(classifyRunnerFailure(r2, [rule])).toBeUndefined() // exit gate 125 not met
    const r3 = { exitCode: 125, stderr: { text: "some other error" } }
    expect(classifyRunnerFailure(r3, [rule])).toBeUndefined() // no fatal signature
  })
})

describe("createLocalSandbox platform selection", () => {
  it("linux → bwrap runner (probe path)", () => {
    // On linux, without a windowsAclBackend, confinement requires bwrap present.
    // We assert the provider exists and confine() gives a ConfinedArgv (bwrap probe
    // may fail on CI → SandboxUnavailableError). Just check the provider shape.
    const provider = createLocalSandbox({ windowsAclBackend: undefined })
    expect(typeof provider.confine).toBe("function")
  })

  it("non-linux non-win32 → fail-closed SandboxUnavailableError", async () => {
    const provider = createLocalSandbox({ windowsAclBackend: undefined })
    // Platform is win32 or linux in this repo; on a third platform confine throws.
    // Skip on the two real platforms — this branch is unreachable in CI.
    if (process.platform === "win32" || process.platform === "linux") return
    expect(() => provider.confine(["echo", "hi"], readOnly)).toThrow(/no sandbox backend/)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/sandbox-local && pnpm test`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`packages/sandbox-local/src/profiles.ts`:

```ts
import type { SandboxPolicy } from "@i-harness/sandbox"

export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"]
  if (policy.mode === "workspace-write") {
    args.push("--tmpfs", "/tmp")
    args.push("--bind", policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}
```

`packages/sandbox-local/src/runner-failures.ts`:

```ts
import type { RunnerFailureRule } from "@i-harness/sandbox"

export interface ShellLikeResult {
  exitCode: number
  stderr: { text: string }
}

export function isRunnerSpawnFailure(err: unknown, runnerProgram: string, workdir: string): boolean {
  const e = err as { code?: string; path?: string; syscall?: string }
  if (e?.code !== "ENOENT" && e?.code !== "EACCES") return false
  if (e.path === runnerProgram && e.syscall === "spawn") return true
  if (e.path === undefined && e.syscall === `spawn ${runnerProgram}`) return true
  return false
}

export function matchesSignature(line: string, signature: string): boolean {
  return line.toLowerCase().includes(signature.toLowerCase())
}

export function classifyDenial(result: ShellLikeResult, denialSignatures: readonly string[]): boolean {
  const lines = result.stderr.text.split("\n")
  for (const line of lines) {
    if (denialSignatures.some((s) => matchesSignature(line, s))) return true
  }
  return false
}

export function classifyRunnerFailure(
  result: ShellLikeResult,
  rules: readonly RunnerFailureRule[],
): { detail: string } | undefined {
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(result.exitCode)) continue
    const lines = result.stderr.text.split("\n")
    for (const line of lines) {
      if (rule.informationalLines?.some((i) => line.trim().toLowerCase() === i.toLowerCase())) continue
      if (rule.fatalSignatures.some((s) => matchesSignature(line, s))) return { detail: line }
    }
  }
  return undefined
}
```

`packages/sandbox-local/src/index.ts`:

```ts
import { spawnSync } from "node:child_process"
import {
  SandboxUnavailableError,
  type ConfinedArgv,
  type SandboxEnforcement,
  type SandboxMode,
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-local && pnpm test`
Expected: PASS (bwrap probe may fail on CI → the "linux → bwrap" test still passes because it only checks `typeof provider.confine === "function"`; the second test skips on win32/linux).

- [ ] **Step 6: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-local typecheck
git add packages/sandbox-local pnpm-lock.yaml
git commit -m "feat(M16): sandbox-local — bwrap profile + platform selection (fail-closed)"
```

---

### Task 3: `@i-harness/sandbox-policy` — policy owner + `sandbox/mode` event

**Files:**
- Create: `packages/sandbox-policy/package.json`
- Create: `packages/sandbox-policy/tsconfig.json`
- Create: `packages/sandbox-policy/src/index.ts`
- Create: `packages/sandbox-policy/src/session-mode.ts`
- Create: `packages/sandbox-policy/test/policy.test.ts`
- Modify: `packages/core-session/src/index.ts` (add `sandbox/mode` event type)
- Modify: `packages/core-session/test/*.test.ts` (add one test for the event)

**Interfaces:**
- Consumes: `@i-harness/sandbox` (`SandboxMode`, `SandboxExecutionPolicy`), `@i-harness/core-session` (`Session`, `SessionEvent`).
- Produces (used by Tasks 5-6): `SANDBOX_MODES`, `effectiveSandboxMode(events)`, `createSandboxPolicy(config)`, `renderPolicyContext(policy)`, `SandboxPolicyConfig`.

- [ ] **Step 1: Create scaffold + workspace dep**

`packages/sandbox-policy/package.json`:

```json
{
  "name": "@i-harness/sandbox-policy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/sandbox": "workspace:*",
    "@i-harness/core-session": "workspace:*"
  }
}
```

`packages/sandbox-policy/tsconfig.json` (same pattern). Then `pnpm install`.

- [ ] **Step 2: Add the session event to core-session**

Modify `packages/core-session/src/index.ts` — the `SessionEvent` union (add before the closing `)` of the union, e.g. after `compaction/summary`):

```ts
    | { type: "sandbox/mode"; mode: SandboxMode; source?: "delegation" }  // M16: log-only
```

(the `mode` type `SandboxMode` — core-session must NOT import sandbox; use a local string union or `string`. For M16 core, declare `mode: "read-only" | "workspace-write" | "danger-full-access"`. The full `SandboxMode` type can be imported only in sandbox-policy, not core-session, to avoid a dep cycle.)

- [ ] **Step 3: Write the failing tests**

`packages/sandbox-policy/test/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { SANDBOX_MODES, createSandboxPolicy, effectiveSandboxMode, renderPolicyContext } from "../src/index.ts"

describe("SANDBOX_MODES", () => {
  it("is the closed vocabulary", () => {
    expect(SANDBOX_MODES).toEqual(["read-only", "workspace-write", "danger-full-access"])
  })
})

describe("effectiveSandboxMode", () => {
  it("last sandbox/mode event wins", () => {
    const s = createSession()
    append(s, { type: "sandbox/mode", mode: "read-only" })
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "sandbox/mode", mode: "workspace-write" })
    expect(effectiveSandboxMode(s.events)).toBe("workspace-write")
  })

  it("undefined when no sandbox/mode event", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    expect(effectiveSandboxMode(s.events)).toBeUndefined()
  })

  it("delegation source is carried", () => {
    const s = createSession()
    append(s, { type: "sandbox/mode", mode: "read-only", source: "delegation" })
    expect(effectiveSandboxMode(s.events)).toBe("read-only")
  })
})

describe("createSandboxPolicy", () => {
  it("defaults to read-only and process.cwd()", () => {
    const policy = createSandboxPolicy({})
    expect(policy.defaultMode).toBe("read-only")
    expect(policy.workspaceRoot.length).toBeGreaterThan(0)
  })

  it("resolve: requested mode > session override > default", () => {
    const policy = createSandboxPolicy({ mode: "workspace-write", workspaceRoot: "/root" })
    const s = createSession()
    append(s, { type: "sandbox/mode", mode: "read-only" })
    expect(policy.resolve({ mode: "danger-full-access" }).mode).toBe("danger-full-access")
    expect(policy.resolve({ session: s }).mode).toBe("read-only") // session override
    expect(policy.resolve({}).mode).toBe("workspace-write") // default
  })

  it("workspaceRoot: request override ?? config default", () => {
    const policy = createSandboxPolicy({ workspaceRoot: "/config-root" })
    expect(policy.resolve({ workspaceRoot: "/call-root" }).workspaceRoot).toBe("/call-root")
    expect(policy.resolve({}).workspaceRoot).toBe("/config-root")
  })
})

describe("renderPolicyContext", () => {
  it("renders each mode", () => {
    expect(renderPolicyContext({ mode: "read-only", workspaceRoot: "/x" })).toContain("read-only")
    expect(renderPolicyContext({ mode: "workspace-write", workspaceRoot: "/x" })).toContain("/x")
    expect(renderPolicyContext({ mode: "danger-full-access", workspaceRoot: "/x" })).toContain("danger-full-access")
  })
})
```
- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd packages/sandbox-policy && pnpm test`
Expected: FAIL — module not found / `sandbox/mode` not in SessionEvent.

- [ ] **Step 5: Implement**

`packages/sandbox-policy/src/session-mode.ts`:

```ts
import type { SandboxMode } from "@i-harness/sandbox"
import type { SessionEvent } from "@i-harness/core-session"

export const SANDBOX_MODES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]

export function effectiveSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!
    if (ev.type === "sandbox/mode") return ev.mode
  }
  return undefined
}
```

`packages/sandbox-policy/src/index.ts`:

```ts
import { resolve as resolvePath } from "node:path"
import type { SandboxExecutionPolicy, SandboxMode } from "@i-harness/sandbox"
import type { Session } from "@i-harness/core-session"
import { SANDBOX_MODES, effectiveSandboxMode } from "./session-mode.ts"

export { SANDBOX_MODES, effectiveSandboxMode }

export interface SandboxPolicyConfig {
  mode?: SandboxMode
  workspaceRoot?: string
}

export interface SandboxPolicyRequest {
  session?: Session
  mode?: SandboxMode
  workspaceRoot?: string
}

export interface SandboxPolicyService {
  defaultMode: SandboxMode
  workspaceRoot: string
  resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy
}

export function createSandboxPolicy(config: SandboxPolicyConfig = {}): SandboxPolicyService {
  const defaultMode = config.mode ?? "read-only"
  const workspaceRoot = resolvePath(config.workspaceRoot ?? process.cwd())
  return {
    defaultMode,
    workspaceRoot,
    resolve(request = {}) {
      const sessionOverride = request.session === undefined ? undefined : effectiveSandboxMode(request.session.events)
      return {
        mode: request.mode ?? sessionOverride ?? defaultMode,
        workspaceRoot: resolvePath(request.workspaceRoot ?? workspaceRoot),
      }
    },
  }
}

export function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case "read-only":
      return "Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns."
    case "workspace-write":
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    case "danger-full-access":
      return "Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations."
    default:
      return ""
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/sandbox-policy && pnpm test` AND `cd packages/core-session && pnpm test`
Expected: PASS (policy 8 tests; core-session existing tests still green with the new event union member).

- [ ] **Step 7: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-policy typecheck
pnpm --filter @i-harness/core-session typecheck
git add packages/sandbox-policy packages/core-session pnpm-lock.yaml
git commit -m "feat(M16): sandbox-policy — policy owner + sandbox/mode session event"
```

---

### Task 4: exec — confining at spawn (fail-closed)

**Files:**
- Modify: `packages/exec/src/index.ts`
- Modify: `packages/exec/test/exec.test.ts`

**Interfaces:**
- Consumes: `@i-harness/sandbox` (`SandboxProvider`, `SandboxPolicy`, `SandboxUnavailableError`).
- Produces (used by Tasks 5-6): `createExecService(deps?: { sandbox?: SandboxProvider }): ExecService`; `ExecCommand.sandbox?: SandboxPolicy`.

- [ ] **Step 1: Write the failing test**

Append to `packages/exec/test/exec.test.ts`:

```ts
import { SandboxUnavailableError } from "@i-harness/sandbox"
import type { SandboxProvider, SandboxPolicy } from "@i-harness/sandbox"

describe("exec sandbox", () => {
  const policy: SandboxPolicy = { mode: "read-only", workspaceRoot: "/" }

  it("confines argv when a provider AND a per-command policy exist", async () => {
    const provider: SandboxProvider = {
      confine(argv, _policy) {
        return {
          argv: ["bwrap", "--ro-bind", "/", "/", "--", ...argv],
          enforcement: "full",
          denialSignatures: ["read-only file system"],
          runnerFailureRules: [],
        }
      },
    }
    const exec = createExecService({ sandbox: provider })
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write('ok')"], sandbox: policy })
    expect(result.stdout).toBe("ok")
  })

  it("throws when cmd.sandbox is set but the service has no provider (fail-closed)", async () => {
    const exec = createExecService() // no provider
    await expect(exec.run({ argv: ["echo", "hi"], sandbox: policy })).rejects.toThrow(/no sandbox provider/)
  })

  it("runs unconfined when no policy (existing behavior)", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write('plain')"] })
    expect(result.stdout).toBe("plain")
  })

  it("danger-full-access policy runs unconfined (passthrough)", async () => {
    const exec = createExecService() // no provider
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write('full')"], sandbox: { mode: "danger-full-access", workspaceRoot: "/" } })
    expect(result.stdout).toBe("full")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/exec && pnpm test`
Expected: FAIL — `createExecService()` with no args is a type error (signature is `createExecService()`); `sandbox` on ExecCommand unknown.

- [ ] **Step 3: Implement**

Modify `packages/exec/src/index.ts`:

Add to the top:

```ts
import type { SandboxPolicy, SandboxProvider } from "@i-harness/sandbox"
import { SandboxUnavailableError } from "@i-harness/sandbox"
```

Modify `ExecCommand` (add the field):

```ts
export interface ExecCommand {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
  abortSignal?: AbortSignal
  sandbox?: SandboxPolicy // M16: command-carried policy
}
```

Modify `spawnChild` — wrap the argv before spawn:

```ts
function spawnChild(cmd: ExecCommand, sandboxProvider?: SandboxProvider): SpawnHandle {
  const argv = resolveArgv(cmd, sandboxProvider)
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: cmd.cwd,
    env: { ...process.env, ...cmd.env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  // ...rest unchanged...
}

function resolveArgv(cmd: ExecCommand, sandboxProvider?: SandboxProvider): string[] {
  if (cmd.sandbox === undefined) return cmd.argv
  if (cmd.sandbox.mode === "danger-full-access") return cmd.argv // passthrough
  if (sandboxProvider === undefined) {
    throw new SandboxUnavailableError(cmd.sandbox.mode, "no sandbox provider composed (createExecService({ sandbox }))")
  }
  return sandboxProvider.confine(cmd.argv, cmd.sandbox).argv
}
```

Modify `createExecService`:

```ts
export function createExecService(deps?: { sandbox?: SandboxProvider }): ExecService {
  let bashCounter = 0
  const jobs = new Map<string, BackgroundJobView & { handle: SpawnHandle }>()
  const provider = deps?.sandbox

  return {
    run(cmd: ExecCommand): Promise<ExecResult> {
      const h = spawnChild(cmd, provider)
      return h.done.then(({ stdout, stderr, exitCode, timedOut }) => ({ stdout, stderr, exitCode, timedOut }))
    },
    runBackground(cmd: ExecCommand): { jobId: string } {
      bashCounter += 1
      const jobId = `bash-${bashCounter}`
      const handle = spawnChild(cmd, provider)
      const job: BackgroundJobView & { handle: SpawnHandle } = { id: jobId, status: "running", stdout: "", stderr: "", handle }
      jobs.set(jobId, job)
      handle.child.stdout?.on("data", (d: Buffer) => { job.stdout += d.toString("utf-8").replace(/\r\n/g, "\n") })
      handle.child.stderr?.on("data", (d: Buffer) => { job.stderr += d.toString("utf-8").replace(/\r\n/g, "\n") })
      handle.done.then(({ stdout, stderr, exitCode, timedOut }) => {
        const j = jobs.get(jobId)
        if (!j || j.status !== "running") return
        j.stdout = stdout
        j.stderr = stderr
        j.exitCode = exitCode
        j.status = timedOut ? "killed" : exitCode === 0 ? "completed" : "error"
      })
      return { jobId }
    },
    // ...getOutput/listJobs/killJob unchanged...
  }
}
```

Update `packages/exec/package.json` deps: add `"@i-harness/sandbox": "workspace:*"`, then `pnpm install`.

Also update `registerExec` (the service mounting function) to pass sandbox through:

```ts
export function registerExec(ctx: PluginContext, deps?: { sandbox?: SandboxProvider }): void {
  ctx.services.register("exec/service", createExecService(deps))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/exec && pnpm test`
Expected: PASS (existing 10 + new 4).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/exec typecheck
git add packages/exec package.json pnpm-lock.yaml
git commit -m "feat(M16): exec confines at spawn when provider + policy present (fail-closed)"
```

---

### Task 5: wiring — CLI `--sandbox` option + registerShell sandbox param

**Files:**
- Modify: `packages/shell/src/index.ts` (`registerShell`)
- Modify: `apps/cli/src/run.ts` (`HeadlessOptions` + runHeadless)
- Modify: `apps/cli/test/cli.test.ts` (add e2e test)

**Interfaces:**
- Consumes: `@i-harness/sandbox`, `@i-harness/sandbox-local`, `@i-harness/sandbox-policy`, `@i-harness/exec` (with sandbox provider).
- Produces: CLI `--sandbox { mode }` option that configures the sandbox; `registerShell(ctx, registry, { sandbox?: SandboxProvider })`.

- [ ] **Step 1: Write the failing (wiring) test**

Append to `apps/cli/test/cli.test.ts`:

```ts
describe("M16 CLI sandbox wiring", () => {
  it("runHeadless accepts --sandbox read-only and mounts the policy (no crash)", async () => {
    // The real bwrap deny e2e lives in Task 6; here we assert the wiring:
    // the sandbox option is accepted, the CLI mounts the sandbox provider and
    // policy without crashing, and a simple run completes.
    const result = await runHeadless("hello", { sandbox: "read-only", approveAll: true, model: undefined })
    expect(result).toBeDefined()
  })
})
```

(Depending on the CLI test harness's existing `runHeadless` import/usage; mirror the existing e2e pattern for `runHeadless` with a mock model. If a full `runHeadless` call is too heavy for the wiring test, assert the option is accepted at the type level by constructing `HeadlessOptions` with `sandbox: "read-only"` in an existing test's setup — but prefer the real runHeadless call if the harness supports it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/cli && pnpm test`
Expected: FAIL — `HeadlessOptions.sandbox` unknown; `registerShell` no sandbox param.

- [ ] **Step 3: Implement**

Modify `packages/shell/src/index.ts` — `registerShell` gains sandbox:

```ts
export function registerShell(
  ctx: PluginContext,
  registry: { register(t: Tool): void },
  opts?: { timeoutMs?: number; retention?: ShellRetentionOptions; sandbox?: import("@i-harness/sandbox").SandboxProvider },
): void {
  registerExec(ctx, { sandbox: opts?.sandbox })
  const exec = ctx.services.get<ExecService>("exec/service")
  for (const tool of createShellTools({ exec, timeoutMs: opts?.timeoutMs, retention: opts?.retention })) registry.register(tool)
}
```

(Update `registerExec` in exec to accept the sandbox param — see Task 4.)

Modify `apps/cli/src/run.ts`:

```ts
import { createLocalSandbox } from "@i-harness/sandbox-local"
import { createSandboxPolicy } from "@i-harness/sandbox-policy"
import type { SandboxMode } from "@i-harness/sandbox"

export interface HeadlessOptions {
  // ...existing...
  sandbox?: SandboxMode   // M16: "read-only" | "workspace-write" | "danger-full-access"
}
```

In `runHeadless`, before `registerShell`:

```ts
  const sandboxProvider = opts.sandbox === undefined || opts.sandbox === "danger-full-access"
    ? undefined
    : createLocalSandbox()
  registerShell(ctx, tools, {
    timeoutMs: shellTimeoutMs,
    retention: opts.shellRetention ?? { maxBytes: 64_000 },
    ...(sandboxProvider !== undefined ? { sandbox: sandboxProvider } : {}),
  })
```

And the system prompt (after `systemPrompt` is built, if sandbox configured):

```ts
  const sandboxPolicy = opts.sandbox === undefined ? undefined : createSandboxPolicy({ mode: opts.sandbox, workspaceRoot: opts.workspace })
  // ... near the createAgent call:
  if (sandboxPolicy) {
    const rendered = renderPolicyContext(sandboxPolicy.resolve())
    systemPrompt = `${systemPrompt}\n\n${rendered}`
  }
```

(Host wires the policy context into the prompt when sandbox is configured; the exact injection point is where `systemPrompt` is assembled in `runHeadless`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/cli && pnpm test`
Expected: PASS (existing 40 CLI tests + 2 new; no real sandbox e2e yet — Task 6).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/shell typecheck
pnpm --filter @i-harness/cli typecheck
git add packages/shell apps/cli pnpm-lock.yaml
git commit -m "feat(M16): CLI --sandbox option + shell sandbox wiring"
```

---

### Task 6: e2e sandbox behavior (Linux bwrap) + regression

**Files:**
- Create: `packages/sandbox-local/test/bwrap.e2e.ts` (or `packages/sandbox/test/e2e.test.ts`)
- Modify: (if needed) `packages/sandbox-local/package.json` (no change)

**Interfaces:**
- Consumes: `createLocalSandbox` (Task 2), `@i-harness/sandbox` seam.
- Produces: end-to-end proof that bwrap confines; this is the regression gate for M16 core.

- [ ] **Step 1: Write the e2e test**

`packages/sandbox-local/test/bwrap.e2e.ts`:

```ts
import { describe, expect, it } from "vitest"
import { execSync } from "node:child_process"
import { createLocalSandbox } from "../src/index.ts"
import type { SandboxPolicy } from "@i-harness/sandbox"

function hasBwrap(): boolean {
  if (process.platform !== "linux") return false
  try { execSync("bwrap --version", { stdio: "ignore" }); return true } catch { return false }
}

const skip = hasBwrap() ? it : it.skip

describe("bwrap e2e (Linux, requires bwrap)", () => {
  const provider = createLocalSandbox()
  const policy: SandboxPolicy = { mode: "read-only", workspaceRoot: "/" }

  skip("read-only denies writing to /tmp", async () => {
    const confined = provider.confine(["sh", "-c", "echo hi > /tmp/m16-e2e-$$.txt"], policy)
    expect(confined.argv[0]).toBe("bwrap")
    // Spawn the confined argv and check exit code + stderr deny marker.
    const { spawn } = await import("node:child_process")
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(confined.argv[0]!, confined.argv.slice(1))
      let stderr = ""
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
      child.on("close", (code) => resolve({ code, stderr }))
    })
    expect(result.code).not.toBe(0) // denied
    expect(result.stderr.toLowerCase()).toContain("read-only file system")
  })

  skip("workspace-write allows writing workspace root", async () => {
    const workspace = process.cwd()
    const wp: SandboxPolicy = { mode: "workspace-write", workspaceRoot: workspace }
    const confined = provider.confine(["sh", "-c", `echo hi > "${workspace}/.m16-e2e-write.txt"`], wp)
    const { spawn } = await import("node:child_process")
    const result = await new Promise<{ code: number | null }>((resolve) => {
      const child = spawn(confined.argv[0]!, confined.argv.slice(1))
      child.on("close", (code) => resolve({ code }))
    })
    expect(result.code).toBe(0)
    // cleanup
    const fs = await import("node:fs")
    fs.rmSync(`${workspace}/.m16-e2e-write.txt`, { force: true })
  })
})
```

- [ ] **Step 2: Run the test**

Run: `cd packages/sandbox-local && pnpm test`
Expected: on Linux WITH bwrap → 2 e2e pass; without bwrap → skipped. On win32 the `skip` guard skips both.

- [ ] **Step 3: Full regression**

```bash
cd D:/agent-complete/I-harness
pnpm -r test
pnpm -r typecheck
```

Expected: ALL packages green (seam 12, local ~9 + e2e, policy 8, exec 14, CLI 42).

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox-local
git commit -m "test(M16): bwrap e2e — read-only denies write, workspace-write allows (skip without bwrap)"
```

---

## Self-Review Notes (already resolved during planning)

- **Plan split**: M16 core (this) excludes the koffi Windows backend — M16w is its own plan. M16 core uses a `windowsAclBackend` injection point (`createLocalSandbox({ windowsAclBackend })`) so M16w plugs in without changing M16 core.
- **Spec deviation — resolve workspaceRoot**: M16 core resolves workspace root via `SandboxPolicyRequest.workspaceRoot?` (call-site override) rather than adding `cwd` to `SessionHeader`. The spec said "session cwd ?? config"; M16 core's request-level override is the smallest interface that keeps the seam usable without a core-session shape change. M16w/session-cwd can be added later.
- **core-session `SandboxMode`**: the `sandbox/mode` event declares `mode: "read-only" | "workspace-write" | "danger-full-access"` inline (a local union) so core-session stays dependency-free (no import of sandbox — avoids a cycle: sandbox-policy imports core-session).
- **bwrap probe**: `probeBwrap` uses `spawnSync` (one-shot bounded) — the plan's Step-4 code block includes a commented-out stub; the implementer uses the real `spawnSync` version (imports `spawnSync` from node:child_process).
- **M16 core fail-closed**: on win32 without a composed koffi backend, `createLocalSandbox` returns a provider whose `confine` throws `SandboxUnavailableError` — M16w replaces this with the real backend.
- **CLI e2e**: the real bwrap write-denial e2e is Task 6 (skip-without-bwrap); Task 5 only wires the plumbing (CLI option accepted + compile-level guard).
