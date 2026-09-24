# Desktop Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one SDK-compatible local backend host for Desktop that reuses I-harness's existing sandbox, supports fail-closed approval/question replies, and serves bounded read-only workspace review.

**Architecture:** `packages/desktop-gateway` composes existing settings/provider/session services and delegates all existing `session/*` methods to `createSdkServer`. A namespaced router handles `desktop/*` on the same bounded NDJSON stream. Interaction answerers attach through `SessionService.onAssembly`; review reads a canonical workspace with bounded Git/file operations. No existing backend package or CLI file is changed.

**Tech Stack:** TypeScript 5.9, Node ≥22.18, pnpm ≥10, Vitest 3.2, existing `@i-harness/*` workspace packages and Node standard library. No external private dependency.

**Spec:** `docs/superpowers/specs/2026-09-25-desktop-gateway-design.md`

## Global Constraints

- Work only in `D:\frontend-test` on `codex/desktop-workbench`. Do not push or create a PR; `origin.pushurl` stays `no-push://disabled`. Do not touch `D:\I-harness-main`.
- The user approved **one new backend package** `packages/desktop-gateway`. Do not edit `packages/sdk`, `apps/cli`, `packages/sandbox*`, `packages/session-executor`, or other existing backend source. If that becomes unavoidable, stop with a concrete proposal rather than silently expanding scope.
- Existing sandbox already works in `i-harness run`: load SettingsStore before reading `sandboxMode`, then pass it through `createSessionService({ sandbox: mode })`. Do not build a new policy or silently fall back to `danger-full-access`.
- Existing SDK v3 methods retain their request/reply shapes; only namespaced Desktop methods and additive capability rows are new. Exactly one output frame per request, with one shared bounded writer.
- Fail closed on absent/late/duplicate interaction reply, connection loss and unavailable confinement. Review operations are read-only, workspace-bound and byte-capped; no arbitrary shell interpolation.
- Every behavioral task begins with a failing test. Before each local commit run its targeted tests, package typecheck, and any named e2e; after the final task run `pnpm verify:all`.

---

## File map and stable wire

| File | Responsibility |
|---|---|
| `packages/desktop-gateway/package.json`, `tsconfig.json` | One private internal backend package and normal workspace scripts |
| `src/router.ts` | Initialize gate, SDK delegation, additive capability reply and namespaced method dispatch |
| `src/host.ts` | Existing provider/settings/coordinator/service assembly with configured sandbox |
| `src/interaction.ts` | Per-session pending request map and approval/question answerer adapters |
| `src/review.ts` | Workspace-level, bounded, read-only Git/file views |
| `src/cli.ts` | stdio line loop, bounded writer, shutdown and process cleanup |
| `src/types.ts` | Wire DTOs for new Desktop methods only |
| `test/*.test.ts` | Contract, sandbox, interaction, review and process lifecycle evidence |

The namespaced method/notification set is fixed for this plan:

```ts
type DesktopMethod =
  | "desktop/sandbox/state"
  | "desktop/interaction/pending"
  | "desktop/interaction/reply"
  | "desktop/review/changes"
  | "desktop/review/diff"
  | "desktop/review/file"
type DesktopNotification = "desktop/interaction/request" | "desktop/interaction/closed"
type SandboxState = { mode: "read-only" | "workspace-write" | "danger-full-access"; source: "settings"; wired: true }
```

## Task 1: SDK-compatible router and one outbound path

**Files:** Create `packages/desktop-gateway/package.json`, `tsconfig.json`, `src/types.ts`, `src/router.ts`, `test/router.test.ts`.

**Interfaces:** `createDesktopRouter(base: SdkServer, send: (frame: RpcMessage) => void, extra: DesktopHandlers): { handleLine(line: string): Promise<void>; close(): Promise<void> }`. `DesktopHandlers` initially has `sandboxState(): SandboxState`; later tasks add interaction/review methods. All outgoing frames go through `send`; never write the string returned by `base.handleLine()`.

- [ ] **Step 1: Create a package scaffold and failing router tests.** `package.json` declares `@i-harness/desktop-gateway`, `private:true`, `type:"module"`, scripts `test: "vitest run"`, `typecheck: "tsc --noEmit"`, with workspace dependencies `@i-harness/sdk`, `@i-harness/session-executor`, `@i-harness/session-persistence`, `@i-harness/session-persistence-jsonl`, `@i-harness/provider-runtime`, `@i-harness/settings`, `@i-harness/credentials`, `@i-harness/interaction`, `@i-harness/sandbox`. Test an `initialize` request: one `onWrite` response with protocolVersion 3 and three additive Desktop capability rows; a pre-initialize `desktop/sandbox/state` gets INVALID_REQUEST; a delegated `session/status` produces exactly one frame; a malformed line produces none.
- [ ] **Step 2: Run** `pnpm install` at repo root, then `pnpm --filter @i-harness/desktop-gateway test -- test/router.test.ts`. Expected: failure because `createDesktopRouter` is absent.
- [ ] **Step 3: Implement minimal router.** Construct `createSdkServer(service,{onWrite: gatewayWrite})` in `host.ts` later; `gatewayWrite` clones a successful `initialize` result and adds only advertised Desktop capability rows. `handleLine` uses `decodeFrame` and handles recognized `desktop/*` requests after its own `initialized` flag; delegates every other line to `base.handleLine()` and ignores the encoded return. Own replies use `makeSuccess`/`makeFailure` and the same `send` function. Preserve `shutdown` delegation even before init.

```ts
async function handleLine(line: string): Promise<void> {
  const message = decodeFrame(line)
  if (!message || !isRpcRequest(message)) return
  if (message.method === "initialize") {
    const replyLine = await base.handleLine(line) // base.onWrite is the sole writer
    const reply = replyLine === null ? undefined : decodeFrame(replyLine)
    if (isRpcSuccess(reply)) initialized = true
    return
  }
  if (!message.method.startsWith("desktop/")) {
    await base.handleLine(line)
    return
  }
  if (!initialized) return send(makeFailure(message.id, INVALID_REQUEST, "initialize first"))
  send(await dispatchDesktop(message, handlers))
}
```

`gatewayWrite` must not mutate the object returned by the base SDK server. Its `initialize` clone adds `desktop-interaction`, `desktop-sandbox` and `desktop-review` to `result.capabilities`, leaving all pre-existing rows untouched.
- [ ] **Step 4: Run** router tests and package typecheck. Expected: pass; one response per request and no stdout duplication.
- [ ] **Step 5: Commit** Task 1 files plus lockfile with `feat(desktop-gateway): add SDK-compatible router`.

## Task 2: Host composition and existing sandbox wiring

**Files:** Create `src/host.ts`, `test/host.test.ts`, `test/sandbox.e2e.test.ts`; modify `src/router.ts` to use the real sandbox-state handler.

**Interfaces:** `createDesktopHost({ workspace, sessionDir, settingsPath?, credentialsPath?, onWrite }): Promise<{ handleLine(line): Promise<void>; close(): Promise<void> }>`; host owns `SettingsStore`, `ProviderRuntime`, `SessionCoordinator`, `SessionService` and SDK server. Exposes `desktop/sandbox/state` only after settings are loaded and `sandbox` is passed to service options.

- [ ] **Step 1: Add failing host tests.** With temporary settings containing `sandboxMode:"read-only"`, create host and request `desktop/sandbox/state`; assert `{mode:"read-only",source:"settings",wired:true}` and that a new session's log contains `sandbox/mode: read-only` after assembly. With `sandboxMode:"workspace-write"`, assert that mode instead. A corrupt settings file must not answer `wired:true`.
- [ ] **Step 2: Run** `pnpm --filter @i-harness/desktop-gateway test -- test/host.test.ts test/sandbox.e2e.test.ts`. Expected: fail because the host does not exist.
- [ ] **Step 3: Implement composition from package-level APIs, not CLI imports.** Load settings before reading `sandboxMode`, create credential store and provider runtime, create JSONL coordinator, build `modelBindingFor` by forwarding `runtime.resolveModel` and mapping ready `client` to `model`. Create service with `workspace`, `sandbox: settings.get().sandboxMode`, `modelPolicy:"required"`, `coordinator`, `sessionFor:createDurableSessionLoader(coordinator)`, and `outputSpill:{}`. Supply `createSession` and `listSessions` seams to `createSdkServer`; list rows may omit optional turn count but must use real id/title. Keep the exact chosen mode in a closed-over `SandboxState`, never re-read an unloaded store.

```ts
const resolvedSettingsPath = resolveSettingsPath(settingsPath ? { path: settingsPath } : {})
const settings = new SettingsStore({ path: resolvedSettingsPath })
await settings.load()
const mode = settings.get().sandboxMode
const credentials = createCredentialStore(credentialsPath ?? join(dirname(resolvedSettingsPath), "credentials.json"))
const runtime = createProviderRuntime({ settings, credentials })
const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true, lockRoot: sessionDir } })
const service = createSessionService({
  workspace, sandbox: mode, modelPolicy: "required", coordinator,
  sessionFor: createDurableSessionLoader(coordinator), outputSpill: {},
  modelBindingFor: async (_sessionId, meta) => {
    const state = await runtime.resolveModel(meta?.modelSelection ? { sessionSelection: meta.modelSelection } : {})
    if (state.status !== "ready") return state
    const { client, ...binding } = state.binding
    return { status: "ready", binding: { model: client, ...binding } }
  },
})
```

If a required role-model or rewind seam is omitted, do not advertise its optional SDK capability. Add the needed seam in this new package only when the task's real-host tests require it; do not copy `runHeadless` or import `apps/cli`.
- [ ] **Step 4: Run** host tests, targeted real sandbox tests and package typecheck. The e2e must execute a real tool under read-only and workspace-write and verify actual refusal/allowance, including a denied outside-workspace write on Windows; mode echo alone is insufficient. Expected: all pass or record the actual platform limitation and keep Send gated.
- [ ] **Step 5: Commit** with `feat(desktop-gateway): reuse configured sandbox`.

## Task 3: Fail-closed approval and question round-trips

**Files:** Create `src/interaction.ts`, `test/interaction.test.ts`, `test/interaction.e2e.test.ts`; modify `src/host.ts`, `src/router.ts`, `src/types.ts`.

**Interfaces:** `createInteractionBridge(emit): { attach(assembly: SessionAssembly): void; pending(sessionId?:string): PendingInteraction[]; reply(input): {accepted:true}; close(): void }`. `PendingInteraction` includes stable `requestId`, `sessionId`, `kind`, display payload and `openedAt`; `reply` checks session and kind.

- [ ] **Step 1: Add failing tests.** Trigger two requests in two sessions; verify `pending` contains correct owners and request notification is emitted after map insertion. A reply with wrong session, unknown id, duplicate id, wrong decision kind or answer to an approval must reject. Approval false settles as denial; a question answer returns the entered string. Closing the bridge or 24-hour timer settles approval false and question with `NO_PROVIDER`-style failure; a late reply cannot reopen either.
- [ ] **Step 2: Run** `pnpm --filter @i-harness/desktop-gateway test -- test/interaction.test.ts test/interaction.e2e.test.ts`. Expected: fail because bridge/routes do not exist.
- [ ] **Step 3: Implement** one Map per host and install existing answerers in `service.onAssembly`:

```ts
function attach(assembly: SessionAssembly): void {
  if (!assembly.sessionId) return
  registerApprovalAnswerer(assembly.ctx, (request) =>
    interaction.waitForApproval(assembly.sessionId!, request))
  registerQuestionProvider(assembly.ctx, {
    ask: (question) => interaction.waitForAnswer(assembly.sessionId!, question),
  })
}
service.onAssembly(attach)
```

`waitForApproval` registers a resolver and 24-hour timer before `desktop/interaction/request` notification; `waitForAnswer` does likewise. `reply` removes and clears timer before resolving. Emit `desktop/interaction/closed` on accepted reply, timeout or host close. The router validates exact `{requestId,sessionId,decision}` shape and returns `INVALID_PARAMS` for mismatches; it never treats a truthy object as approval. `pending` is an in-memory snapshot and is not persisted across process crash.
- [ ] **Step 4: Run** targeted tests and package typecheck. Expected: pass; then run the real SessionService interaction e2e with no `approveAll` option and prove an unanswered request cannot execute a guarded tool.
- [ ] **Step 5: Commit** with `feat(desktop-gateway): bridge human interaction`.

## Task 4: Bounded, read-only workspace review

**Files:** Create `src/review.ts`, `test/review.test.ts`; modify `src/router.ts`, `src/types.ts`, `src/host.ts`.

**Interfaces:** `createWorkspaceReview(root): { changes():Promise<ChangesResult>; diff(path,maxBytes?):Promise<DiffResult>; file(path,maxBytes?):Promise<FileResult> }`. `ChangesResult` is `unavailable` or up to 500 workspace-relative rows plus `truncated`. Diff default/hard caps are 512 KiB/2 MiB; file default/hard caps are 256 KiB/1 MiB.

- [ ] **Step 1: Add failing tests** in a temporary Git repo: tracked unstaged and staged edits appear in one `HEAD` diff; untracked is listed but has no fabricated diff; no Git repo returns unavailable; 501 rows yields 500 + truncated; binary and deleted files return distinct status; `..`, absolute paths, symlink outside root and a symlink swapped during open are refused; a 3 MiB diff and 2 MiB file return bounded bytes + truncated. Snapshot the repo status and file hashes before/after to prove no write.
- [ ] **Step 2: Run** `pnpm --filter @i-harness/desktop-gateway test -- test/review.test.ts`. Expected: fail because review API does not exist.
- [ ] **Step 3: Implement** `git` through `spawn`/`execFile` with argument arrays and explicit `cwd`, never a shell string. For tracked diff use `git diff --no-ext-diff HEAD -- <validated-relative-path>` and reject missing HEAD separately. For file preview: reject non-relative or traversing segments; `realpath` the workspace; inspect path components with `lstat`; open read-only; check canonical path again and compare opened handle `fstat` identity to the final path `stat` before reading; reject any mismatch. Read no more than cap + 1 byte and close the handle. Output statuses are discriminated unions, not empty strings. For a cap, use a bounded streaming collector that aborts the Git child after cap + 1 byte.

```ts
const max = Math.min(requestedMaxBytes ?? 512 * 1024, 2 * 1024 * 1024)
const child = spawn("git", ["diff", "--no-ext-diff", "HEAD", "--", relativePath], { cwd: root, shell: false })
const bytes = await collectAtMost(child.stdout, max + 1)
if (bytes.length > max) child.kill()
return { kind: "text", text: bytes.subarray(0, max).toString("utf8"), truncated: bytes.length > max }
```

Handle UTF-8 truncation without inserting a replacement character mid-sequence; preserve a raw byte count. `changes()` uses `git status --porcelain=v1 -z` parsing, not line splitting. Ensure race test uses a controllable hook between initial validation and open.
- [ ] **Step 4: Run** targeted tests and package typecheck. Expected: pass. Perform a read-only manual check on a throwaway repo and verify `git status --porcelain` unchanged.
- [ ] **Step 5: Commit** with `feat(desktop-gateway): expose bounded workspace review`.

## Task 5: stdio process, bounded writer and full compatibility gate

**Files:** Create `src/cli.ts`, `test/gateway.e2e.test.ts`, `test/lifecycle.test.ts`; modify `package.json` to expose a local `desktop-gateway` bin entry or explicit source runner. No existing CLI file changes.

**Interfaces:** CLI arguments are `--session-dir <absolute-dir>` with workspace = `process.cwd()`; `desktop-gateway` is launched by the Desktop main process. stdout is NDJSON frames only, stderr holds diagnostics. Termination closes bridge, SDK server, SessionService and coordinator in that order.

- [ ] **Step 1: Add failing real-process tests** using the existing `packages/sdk/test/e2e.test.ts` loopback provider precedent. Spawn this package's CLI from a temporary workspace and settings directory, initialize with `HarnessClient`, verify protocolVersion 3 and additive Desktop capabilities, then create/list/prompt/history/cancel through **unchanged** SDK method names. Send malformed input and an unknown method, ensure process survives; confirm each request has one response; close stdin and verify no lingering child. Trigger an interaction and verify pending/reply/closed notification across renderer-style reconnect to the same host. Test bounded writer's single overload frame and shutdown.
- [ ] **Step 2: Run** `pnpm --filter @i-harness/desktop-gateway test -- test/gateway.e2e.test.ts test/lifecycle.test.ts`. Expected: fail because the CLI entry is absent.
- [ ] **Step 3: Implement** a `readline` loop, one `router.handleLine(line)` per input line and idempotent `close()`. Use the bounded writer below; on EOF/SIGINT/SIGTERM close pending interactions first (fail closed), then SDK server, service, coordinator, diagnostics. Use `console.error`/diagnostics for stderr, never stdout logging. Validate arguments before creating session store. Keep package source runnable with the repo's absolute `tsx` loader for dev; distribution bundling is a later Desktop stage.

```ts
const writer = createBoundedWriter({
  write: (chunk) => process.stdout.write(chunk),
  end: () => process.stdout.end(),
  onDrain: (callback) => {
    process.stdout.once("drain", callback)
    return () => process.stdout.off("drain", callback)
  },
  boundBytes: DEFAULT_WRITE_BOUND_BYTES,
})
```
- [ ] **Step 4: Run** package test/typecheck and `pnpm verify:all` from repo root. Expected: all exit 0; if not, investigate rather than claim completion. Run a Windows real sandbox probe separately and record its actual result.
- [ ] **Step 5: Commit** with `feat(desktop-gateway): expose local SDK-compatible host`.

## Completion and stop line

This plan yields the **approved new backend package only**. Do not modify `packages/sdk`, `apps/cli`, existing sandbox code or `D:\I-harness-main`; do not push. Before the Desktop renderer enables Send, verify `desktop/sandbox/state` reports `wired:true` **and** the real confinement e2e passed on the target Windows machine. The result-review UI and approval UI are implemented under the separate Desktop frontend plan after this host is verified.
