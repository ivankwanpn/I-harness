# M16 Design — Sandbox (file-effect confinement)

Date: 2026-08-25. Milestone: M16. Status: implemented (complete).

## 1. Framing

### 1.1 Problem

I-harness's runtime design explicitly deferred OS sandboxing ("pluggable
later"). Today the only execution safety is `guard-approval` (pre-execution
approval policy) — a human-gated authorization seam, NOT an OS-level
confinement boundary. The dsh parity audit names this gap directly:
"Sandbox — the runtime-design explicitly deferred OS sandbox ('pluggable
later'); guard-approval is the safety today." It also records dsh's
architecture (T26: a per-platform pluggable sandbox seam — one interface,
three real backends, zero Linux leakage into call sites) and its Windows
contract weakness (T27: write-only, partial-enforcement, console-constrained).

dsh ships `packages/sandbox/*` (four packages: seam, local platform
selector, Windows ACL restricted-token backend, policy owner) with a
`SandboxMode` file-effect vocabulary (`read-only | workspace-write |
danger-full-access`) and the **same vocabulary is used by the model-facing
tool layer** (bash/pwsh tools teach `sandbox_permissions` escalation).

M16 builds the I-harness sandbox as the natural next step after M15
(token meter + context catalog): a file-effect confinement seam around
`exec` subprocesses, dual-platform (Linux bwrap / Windows ACL
restricted-token), independent from but complementary to `guard-approval`
(defense-in-depth).

### 1.2 Goal

Add file-effect process confinement to I-harness at the smallest coherent
scope that is genuinely usable:

1. **A sandbox seam package** (`@i-harness/sandbox`): the file-effect
   vocabulary (`SandboxMode`), policy types, the abstract
   `SandboxProvider.confine(argv, policy)` interface, the fail-closed
   `SandboxUnavailableError`, the writable-roots helper, and the shared
   escalation choreography (`WIDER_MODES`, `approveEscalation`, denial
   marker, escalation hint).
2. **A platform-local backend** (`@i-harness/sandbox-local`): per-platform
   runner chain — Linux bwrap, Windows ACL restricted-token — with
   functional probes and per-runner enforcement/denial facts.
3. **A Windows restricted-token backend** (`@i-harness/sandbox-windows-acl`):
   koffi-based Win32 implementation of the WRITE_RESTRICTED token sandbox
   (workspace/temp capability SIDs, standing grants, fail-closed).
4. **A sandbox policy owner** (`@i-harness/sandbox-policy`): deployment
   default mode + per-session override via a new log-only `sandbox/mode`
   session event + per-call `resolve()` (requested-mode > session override >
   deployment default) + system-prompt context injection.
5. **Minimal wiring**: CLI sandbox option, shell tools run through exec's
   sandbox, guard-approval escalation integration.

### 1.3 Non-goals (out of scope for M16)

- **Network isolation**: dsh's sandbox is explicitly file-effect only
  ("Network and process visibility are outside this vocabulary"; its Linux
  profile uses no `--unshare-net`; Windows docs say network is NOT
  restricted). M16 follows: no network sandboxing.
- **`fs-sandbox`** (dsh's in-process filesystem fence for the write tool):
  I-harness has no fs-sandbox; fs tools are not part of M16.
- **Linux Landlock**: dsh implements it via a native addon
  (`@deepseek-ai/node-addon-landlock-run`). I-harness does not use dsh's
  private npm packages; M16 ships bwrap only on Linux (fail-closed when
  bwrap is unavailable). Landlock is a later enhancement.
- **macOS Seatbelt**: out of M16's dual-platform scope (Linux + Windows).
- **Remote/Virtualized sandboxing** (containers, microVMs, E2B): out.
- **Persistent PTY / terminal sandboxing**: `exec` only (no PTY in M16).
- **No new `CURRENT_FORMAT_VERSION` change; no `KNOWN_EVENT_TYPES` handling
  changes** beyond adding the one log-only `sandbox/mode` event (M16's
  session-mode requires it; it follows the `approval/*` log-only precedent).
- **No version bumps for existing packages** (new packages are 0.1.0).

## 2. Confirmed decisions (brainstorm 2026-08-25)

| Decision | Choice |
|---|---|
| Scope | File-effect sandbox seam + dual-platform backend + policy owner + minimal wiring |
| Platform | Linux (bwrap) + Windows (ACL restricted token via koffi) |
| Safety model | Sandbox + existing guard-approval (defense-in-depth; separate seams) |
| Integration point | Wrap exec subprocess spawn (argv-in/argv-out, dsh T26) — NOT tool-level interception |
| Policy carrier | Command carries SandboxMode (dsh SandboxMode vocabulary) |
| Network | NOT included (follow dsh: file-effect only) |
| Session-mode | Full: `sandbox/mode` event + fold + policy owner resolve + system-prompt injection + delegation seed |
| Linux backend | bwrap only (probe-first); Landlock deferred (needs native addon — excluded per "no dsh private packages") |
| Windows backend | koffi-based WRITE_RESTRICTED restriction (general-purpose FFI allowed; dsh private packages excluded) |
| Fail-closed | Never silently degrade to unconfined — throw SandboxUnavailableError |
| Wiring | Minimal: CLI option + shell tools via exec + escalation via guard-approval + system prompt (NO fs-sandbox) |

## 3. `@i-harness/sandbox` — the seam

### 3.1 Vocabulary & types (exact)

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
```

### 3.2 `SandboxProvider` (abstract seam)

```ts
export interface SandboxProvider {
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
}
```

- `confine` must return enforcing argv or fail closed by throwing.
  Silent unconfined passthrough is forbidden.
- The caller spawns the returned argv in place of its own.

### 3.3 Fail-closed error

```ts
export const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE"
export class SandboxUnavailableError extends Error {
  constructor(mode: ConfinedSandboxMode, detail?: string) { ... }
}
```

Thrown when no backend can enforce the requested mode. The message names
the mode and what to do (install bubblewrap / use the Windows ACL runner /
switch to danger-full-access).

### 3.4 Root derivation (shared by every enforcement dialect)

```ts
export function canonicalPath(path: string): string {
  // realpathSync.native, fall back to the as-spelled path on failure
}

export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  // workspace-write → [workspaceRoot, "/tmp", tmpdir()] (canonical, deduped)
  // read-only → []
}
```

Single home for the workspace-write meaning so the profile dialects and any
in-process fence can never drift apart.

### 3.5 Escalation choreography (shared by bash/pwsh)

```ts
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
}
export const ESCALATION_TARGETS: readonly SandboxMode[] = ["workspace-write", "danger-full-access"]

export function validateEscalationArgs(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
): void // sandbox_permissions ⇔ justification travel together; justification non-empty sentence

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
): Promise<SandboxMode> // fail-closed ordered sequence: strict widening check → approver? → agent? → request() → map outcome
```

Outcome mapping: `allowed-once` → granted mode; `rejected`/`cancelled`/
`unavailable` → distinct throw; non-widening request never prompts a human.

## 4. `@i-harness/sandbox-local` — platform runner chain

### 4.1 Selection (per platform, probes second)

```ts
const PLATFORM_CHAINS: Record<string, readonly Runner[]> = {
  linux: ["bwrap"],       // Landlock deferred (native addon excluded)
  win32: ["windows-acl"], // sole candidate — no probe; execution-time refusal fails closed
}
// other platforms → fail closed at confine()
```

bwrap is preferred on Linux (its mount profile is closest to the mode
vocabulary). Windows ACL is a sole candidate selected without a probe: its
execution-time refusal (stderr `windows-acl-run:` signature + exit 127)
fails closed.

### 4.2 Enforcement claims

```ts
const ENFORCEMENT: Record<Runner, SandboxEnforcement> = {
  bwrap: "full",
  "windows-acl": "partial", // WRITE_RESTRICTED + Everyone restricting lists + NTFS hard links
}
```

### 4.3 Denial dialects (case-insensitive stderr substrings)

```ts
const DENIAL_SIGNATURES = {
  bwrap: ["read-only file system"],
  "windows-acl": ["access is denied", "access to the path", "permission denied"],
}
```

### 4.4 Probe

bwrap probe: `spawnSync("bwrap", [...bwrapProfileArgs({mode:"read-only",
workspaceRoot:"/"}), "--", "true"])` exit 0 → selected; else fail closed.

### 4.5 Profiles (`profiles.ts`)

```ts
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  // read-only:
  //   --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
  // workspace-write adds:
  //   --tmpfs /tmp --bind workspaceRoot workspaceRoot
}
```

## 5. `@i-harness/sandbox-windows-acl` — koffi-based backend

### 5.1 Interfaces (exact)

```ts
export interface AclSandboxOptions {
  writableDirs: readonly string[]
  tempDir?: string | null
  writeSid?: string
  tempWriteSid?: string
  mode: "read-only" | "workspace-write"
  manageDacls?: boolean
}

export function createWindowsAclSandbox(options: AclSandboxOptions): SandboxProvider
export function workspaceWriteSid(path: string): string
export function tempWriteSid(...): string
export function quoteArg(arg: string): string           // Windows argv quoting
export class Win32Error extends Error { api: string; win32Code: number }
export class AclWriteGrant { ... }
```

### 5.2 Mechanism (from dsh's windows-acl, koffi-based)

- WRITE_RESTRICTED token: write access intersected with the restricting
  SIDs' ACL grants — the core mechanism (dsh `WRITE_RESTRICTED`).
- Restricting SIDs: keep-alive logon SID + Everyone + the capability SIDs.
- Workspace SID (`workspaceWriteSid`): deterministic per-workspace identity,
  so the workspace-root ACE materializes once per workspace and STANDS.
- Temp SID (`tempWriteSid`): per-session private temp dir, revocable on
  dispose; siblings cannot enter each other's temp trees.
- `manageDacls: false` → caller owns DACLs (skips grant/revoke).
- Fail-closed: a child is NEVER spawned unrestricted.
- Known boundaries (inherent to restricted tokens, NOT this port):
  - writes are restricted; reads, network, process visibility are NOT;
  - console isolation unavailable (CREATE_NO_WINDOW / CREATE_NEW_CONSOLE
    children die with STATUS_DLL_INIT_FAILED);
  - writable dirs must be caller-owned (owner-implicit WRITE_DAC).

### 5.3 Files

```
src/index.ts          # createWindowsAclSandbox + AclSandboxOptions
src/token.ts          # createRestrictedToken, openCurrentProcessToken, SID helpers
src/spawn.ts          # spawnSandboxed, waitForExit, drainPipe, quoteArg
src/acl.ts            # grantWrite, revokeWrite
src/ffi.ts            # lazy koffi bindings (Win32 API)
src/win32-abi.ts      # ABI constants + struct layouts
src/errors.ts         # Win32Error
src/path-boundary.ts  # assertTempRootOutsideWorkspace
src/workspace-sid.ts  # workspaceWriteSid, tempWriteSid
src/grant.ts          # AclWriteGrant
```

## 6. `@i-harness/sandbox-policy` — policy owner

### 6.1 Session-mode event (new, log-only)

```ts
// packages/core-session/src/index.ts — SessionEvent union addition:
| { type: "sandbox/mode"; mode: SandboxMode; source?: "delegation" }
```

Log-only (the `approval/*` precedent): durable and replayable, never in the
model transcript. NOT a surface event.

### 6.2 Fold

```ts
export const SANDBOX_MODES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]

export function effectiveSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  // last "sandbox/mode" event wins; undefined if none
}
```

### 6.3 Service

```ts
export interface SandboxPolicyConfig {
  mode?: SandboxMode             // default "read-only" (fail-safe default)
  workspaceRoot?: string         // default process.cwd()
}

export function createSandboxPolicy(config: SandboxPolicyConfig): {
  defaultMode: SandboxMode
  workspaceRoot: string
  resolve(request?: { session?: Session; mode?: SandboxMode }): SandboxExecutionPolicy
  // precedence: request.mode > session override (> deployment default)
  // workspaceRoot: session cwd ?? config workspaceRoot
}
```

### 6.4 System-prompt context

```ts
export function renderPolicyContext(policy: SandboxExecutionPolicy): string
// read-only: "Current DSH file policy: read-only ..."
// workspace-write: "... may modify files under the session workspace: <root> ..."
// danger-full-access: "... does not restrict file modifications ..."
```

## 7. Wiring (I-harness minimal)

### 7.1 exec integration

`packages/exec/src/index.ts`:

```ts
export interface ExecCommand {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
  abortSignal?: AbortSignal
  sandbox?: SandboxPolicy          // M16: command-carried policy
}
```

`spawnChild` wraps the argv when `sandbox` is present:
`const confined = sandboxProvider.confine(cmd.argv, cmd.sandbox)` → spawn
`confined.argv`. When `sandbox.mode === "danger-full-access"`, passthrough
(no confine).

**Provider placement (decided):** `createExecService({ sandbox })` holds the
`SandboxProvider` — the service is constructed with the platform backend,
and per-command `ExecCommand.sandbox` is a policy. Confining happens only
when BOTH exist: `cmd.sandbox` set + service has a provider → confine;
`cmd.sandbox` set + NO provider → throw (fail-closed, never unconfined);
no `cmd.sandbox` → passthrough (existing behavior).

### 7.2 CLI option

`apps/cli/src/run.ts`:

```ts
export interface HeadlessOptions {
  // ...existing...
  sandbox?: { mode: SandboxMode; workspaceRoot?: string }   // M16
}
```

When present: `createSandboxPolicy({ mode, workspaceRoot })` +
`createLocalSandbox()` (platform runner chain) → exec service with the
provider. When absent: no sandbox (existing behavior).

### 7.3 Shell tools

`packages/shell/src/index.ts`: tools keep their existing signatures — the
exec service (already carrying the provider) does the confining. No
shell-tool schema change in M16 (escalation schema fields are a later
refinement; the fail-closed seam is the M16 deliverable). The CLI passes
the sandbox-configured exec service into `createShellTools({ exec })`.

### 7.4 System prompt

The host (CLI) injects `renderPolicyContext(policy)` into the system prompt
when sandbox is configured. Not surfaced as a core-agent API change.

### 7.5 guard-approval

`guard-approval` stays as-is (its pre-execution approval is unchanged).
The sandbox escalation path is a separate seam: the tool result carries
`sandbox: { mode, denied }` markers; escalation is a tool-layer retry
(refinement in M17, not M16).

## 8. Error handling

| Situation | Behavior |
|---|---|
| `confine()` no backend usable | `throw SandboxUnavailableError` (fail-closed) |
| runner spawn ENOENT/EACCES | throw (runner failure, not a denial) |
| runner execution refusal (stderr fatal + exit code) | throw |
| `danger-full-access` | passthrough (no confine) |
| escalation non-widening | throw (no prompt) |
| escalation no approver / no agent | throw |
| escalation rejected/cancelled/unavailable | throw (distinct text) |
| exec `sandbox` field without provider | throw (never unconfined passthrough) |
| invalid policy numbers (probe timeout) | throw (positive finite) |

## 9. Testing

1. **sandbox seam** (`packages/sandbox/test/*.test.ts`):
   - vocabulary (`SandboxMode`/`ConfinedSandboxMode`/`SandboxEnforcement`).
   - `canonicalPath` (realpath, symlink, missing → as-spelled).
   - `writableRoots` (workspace-write = workspaceRoot+/tmp/tmpdir, dedup;
     read-only = []).
   - `approveEscalation`: allowed-once returns granted mode; each throw path
     (non-widening, no approver, no agent, rejected/cancelled/unavailable);
     `validateEscalationArgs` pairing + non-empty justification.
   - `sandboxDenialMarker`/`escalationHintMarker` exact strings.
2. **sandbox-local** (`packages/sandbox-local/test/*.test.ts`):
   - platform chain selection (linux bwrap; win32 windows-acl; else fail-closed).
   - `bwrapProfileArgs` (read-only vs workspace-write args, exact).
   - probe (bwrap running → selected; absent → fail-closed).
   - enforcement claims (bwrap full; windows partial).
   - denial signature matching per runner.
3. **sandbox-windows-acl** (koffi, e2e on Windows):
   - token creation, SID grants (workspace/temp), fail-closed (exit 127),
     console limitation documented; reader-only on other platforms.
4. **sandbox-policy** (`packages/sandbox-policy/test/*.test.ts`):
   - `effectiveSandboxMode` fold (last event wins, undefined when none).
   - `resolve()` precedence (request.mode > session override > default).
   - workspaceRoot (session cwd ?? config).
   - `renderPolicyContext` exact strings.
5. **core-session** (`packages/core-session/test/*.test.ts`):
   - `append` accepts `sandbox/mode` event (log-only, no surface).
6. **wiring / e2e** (`apps/cli/test/cli.test.ts`):
   - CLI `--sandbox read-only` → command writing to workspace fails (denied),
     read-only command succeeds; `workspace-write` → write succeeds.
   - fail-closed: sandbox configured but no backend → run throws
     `SANDBOX_UNAVAILABLE` (never silent unconfined).
   - exec: `ExecCommand.sandbox` set without a provider → throws (fail-closed).
7. **Regression**: full `pnpm -r test` + `pnpm -r typecheck` green.

## 10. Files touched

- Create: `packages/sandbox/` (seam: index/escalation/roots + tests)
- Create: `packages/sandbox-local/` (index/profiles/runner-failures + tests)
- Create: `packages/sandbox-windows-acl/` (index/token/spawn/acl/ffi/
  win32-abi/errors/path-boundary/workspace-sid/grant + tests)
- Create: `packages/sandbox-policy/` (index/session-mode + tests)
- Modify: `packages/core-session/src/index.ts` (add `sandbox/mode` event type)
- Modify: `packages/exec/src/index.ts` (sandbox confining at spawn)
- Modify: `packages/shell/src/index.ts` (sandbox wiring, if provider carried)
- Modify: `apps/cli/src/run.ts` (sandbox option + mount)
- New workspace deps: `@i-harness/sandbox`, `@i-harness/sandbox-local`,
  `@i-harness/sandbox-windows-acl`, `@i-harness/sandbox-policy`.
- **koffi**: the one new EXTERNAL (general-purpose FFI) dependency, in
  `sandbox-windows-acl` only. bwrap is a system binary (not an npm dep).

## 11. Global constraints (binding)

- No dsh private packages (`@deepseek-ai/*`). General-purpose libraries
  (koffi) are allowed. bwrap is a system binary, not a dependency.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- New packages are 0.1.0; no version bumps on existing packages.
- `CURRENT_FORMAT_VERSION` stays 1; the one new session event (`sandbox/mode`)
  is log-only (never in the model transcript), following `approval/*`.
- Fail-closed everywhere: never silently run unconfined when a confined
  mode was requested.
- No network isolation; no fs-sandbox; no Landlock; no Seatbelt; no PTY.
- Behavior unchanged when no sandbox is configured (byte-identical M15 path).

## Appendix A — dsh reference sandbox design (from source)

- **Seam** (`packages/sandbox/sandbox/src/index.ts`): `SandboxMode` =
  `read-only | workspace-write | danger-full-access`; `SandboxPolicy extends
  SandboxExecutionPolicy`; abstract `SandboxProvider.confine(argv, policy) →
  ConfinedArgv`; `SANDBOX_UNAVAILABLE` code + `SandboxUnavailableError`;
  doc line: "Network and process visibility are outside this vocabulary."
- **Local** (`sandbox-local`): `PLATFORM_CHAINS` = `{linux: ['bwrap',
  'landlock'], darwin: ['seatbelt'], win32: ['windows-acl']}`; bwrap probe;
  `STATIC_ENFORCEMENT` (bwrap/landlock/seatbelt `full`, windows-acl
  `partial`); `DENIAL_SIGNATURES` (bwrap `read-only file system`, landlock
  `permission denied`, seatbelt `operation not permitted`, windows
  `access is denied`/`access to the path`/`permission denied`); runner
  failure rules with `allowedExitCodes`/`fatalSignatures`/
  `informationalLines`.
- **Windows ACL** (`sandbox-windows-acl`): koffi-based
  (`import koffi from 'koffi'`, lazy); WRITE_RESTRICTED token; workspace
  SID standing grant + temp SID revocable grant; `manageDacls` option;
  doc: "writes are restricted; reads, network, and process visibility are
  NOT"; console isolation unavailable; exit 127 + `windows-acl-run:` stderr
  signature → runner failure.
- **Policy** (`sandbox-policy`): deployment default (read-only fail-safe) +
  `sandbox/mode` session event + `effectiveSandboxMode` fold + `resolve()`
  precedence (`request.mode > session override > deployment default`) +
  system-prompt injection (policy title 110) + delegation `source:
  'delegation'`.
- **Tool consumption** (`tool-bash`): schema `sandbox_permissions` +
  `justification` (paired validation); description teaches the denial
  marker + escalation hint; `approveEscalation` with
  `requestedMode`/`justification`/`effectiveMode`/`subject`; result carries
  `sandbox: { mode, denied, enforcement, runnerFailed }`.
