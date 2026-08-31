# i-harness C-region (Service/API surface) Implementation Plan — M26

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give i-harness an engine-owned service layer on m26: a reusable `SessionExecutor` (the runHeadless assembly sunk into a package, minus glue) and a `web-host` package (HTTP unary + ws mux) exposing session operations, live event streams, seq replay + paged history, dsh-shape auth, model catalog/probe/per-session selection, and an expanded telemetry code manifest — ported from the abandoned `frontend-web` branch's web-host mechanisms.

**Architecture:** R-C0 posture = **engine-owned**. The assembly currently duplicated by the branch's 1,598-line glue (`apps/cli/src/web.ts` + `apps/cli/src/live-agent.ts`) sinks into `packages/session-executor` (`createSessionAssembly` = one environment once per session; `createSessionExecutor` = per-session registry + per-session serial turn chains). `packages/web-host` is rewritten to take a `SessionExecutor` (not a `sessionRunner` callback) and is transport-only: mux protocol frames, live stream generators, approval/question bridges, paged events, model catalog folds, auth fence. The CLI `web` command becomes a thin composition (~200 lines; the branch's 1,598 lines of glue are never recreated).

**Tech Stack:** TypeScript strict ESM, Node ≥ 22.18 (node:http, node:crypto, node:stream), `ws@^8.18.0` for the WebSocket mux (the **second** documented new external dependency — see Global Constraints), vitest, pnpm workspace. No other new dependencies.

**Spec:** `docs/roadmap/2026-08-31-roadmap-C-service.md` (取捨紀錄 §6: R-C0 engine-owned; R-C1/C2/C3/C6 M26 immediate; R-C5 M26随手补; R-C4 後補; R-C7 後補; R-C8 遠期).

**Reference (read-only) branch source:** `D:\agent-complete\I-harness\` — the mechanism inventory this plan ports from. Do *not* copy anything back into it.

## Global Constraints

- **ESM strict TS**: every package `"type": "module"`; `exports` point at `./src/index.ts` (plus types-only subpaths where noted); relative imports carry `.ts` extensions; `verbatimModuleSyntax`-style `import type`. Never emit `require`.
- **pnpm workspace**; package scripts are exactly `"test": "vitest run"` and `"typecheck": "tsc --noEmit"`.
- **Windows first**: server binds `127.0.0.1`; teardown uses `server.closeIdleConnections()`; sqlite handles released via existing `closeSqliteBackends()`; `timer.unref()` on every fail-closed timeout; win32 ACL sandbox backend disposed by the assembly (never leaked).
- **Fail-closed**: unanswered approval → deny; unanswered question → reject; auth fence rejects unknown `Host`/`Origin`; timeouts `unref()`ed so SIGINT works; unknown session ids → 404, never an invented row.
- **M-series style**: pure folds separated from transport (`models.ts`, `pagination.ts` precedent); typed error classes carry machine `code`s; optional seams answer 404 when absent; body validation rejects (never silently normalizes); every behavioral comment carries its ruling/task reference.
- **New external deps — exactly two**: `ws@^8.18.0` (prod, used only by the mux) and `@types/ws@^8.5.12` (dev). Rationale: Node has no built-in WebSocket *server*; `ws` is the branch-verified choice and its API (ping heartbeat, `bufferedAmount` slow-consumer cap, `noServer` upgrade) is what `mux.ts` depends on. First documented external dep was `@vscode/ripgrep` (fs-search) — ws is the second.
- **Zero dependencies added anywhere else.** Every other package dependency in this plan is `workspace:*`.

## Deferred one-liners (recorded, not implemented here)

- **R-C4** (stdio JSON-RPC SDK): 後補 — wait for the UI's first consumer; dsh/codex precedent already noted in the roadmap.
- **R-C7** (ACP): 後補 — automation-only, product decision pending.
- **R-C8** (session share/remote): 遠期 — 產品面.
- Goal/jobs domain (routes + `goal/change`/`job/status` events + DurableJobRecord): **隨 R-E6/R-E7** — explicitly out.
- Message feedback routes (`feedback.ts`), attachments routes, workspace routes, session search/lineage routes, plugin routes, static SPA dir, `GET /api/telemetry`, mux `team`/`telemetry` endpoints: deferred one-liners (branch mechanisms exist; not in M26 C-scope).
- `reasoning`/`token/usage` event *producers* (model layer emitting reasoning chunks / token summaries): A/B-region engine work — C-plan adds only the *types* so the live stream surface can carry them.
- `@i-harness/settings` structural import swap: flagged per-task, see the E-contract below.

---

## R-C0 — Decision artifact: engine-owned posture

*(This section is the R-C0 deliverable — the architecture record. The roadmap 取捨紀錄 row R-C0 is already set; this is its design detail.)*

**Decision.** The service layer is the API surface of the engine, not an engine host. The assembly that `runHeadless` builds (ctx → tools → shell/sandbox/fs/approval/guards → tool-search/fs-search/session-query tools → model → session → subagent/workflow/mcp/lsp/teams mounts → agent) becomes one reusable package function; the web host owns *only transport*: HTTP route shapes, mux frame protocol, wire folds, error→status mapping.

**Why (the branch's lesson).** The abandoned branch's transport-seam design forced the branch's `apps/cli/src/web.ts` (1,238 lines) + `live-agent.ts` (360 lines) to re-implement — not compose — the runHeadless environment. Every engine change (M25 telemetry, M23 lease, M24a team recovery) had to be replicated in two places; that 1,598-line glue is what killed the branch (audit §4). Engine-owned makes the duplication structurally impossible: one assembly, one executor, any surface on top.

**What moves where.**

| Today (m26 main) / branch | After (m26 C) |
|---|---|
| `runHeadless` inline assembly (run.ts lines 87–359: env, policy, guards, mounts, agent) | `packages/session-executor/src/assembly.ts` → `createSessionAssembly` — same code, one home |
| branch `live-agent.ts` `createLiveAgent` per-session persistent agent | `SessionAssembly` — the same handle shape (`ctx/agent/session/sessionId/killJob/pluginMcpResults/dispose`); `live-agent.ts` ceases to exist |
| branch `web.ts` glue: `liveAgents` map, `hasRun`, `teamMounted`, `creating` dedup, `runTurn`, `runner`, `createLiveAgentFor` | `packages/session-executor/src/executor.ts` → `createSessionExecutor` — registry + get-or-create + per-session serial chains + first-turn/followup flag + team claim + `onAssembly` hooks |
| host.ts mux `command` opener → `sessionRunner(sessionId, prompt, signal)` callback | host.ts mux opener → `executor.submit(sessionId, prompt, signal)`; the per-session command chain (serialization) **moves into the executor** (A2's per-session coordinator — engine-owned), the host keeps only frame mapping (`{status:"started"} → ok/error`) |
| branch `web.ts` model chain/composition imports (~230 lines of resolve/model logic) | stays **composition** (CLI `web.ts`), but at ~200 lines total because it no longer builds agents |
| `runHeadless` | keeps its one-turn orchestration (resume/restore/adoptOwnership/flush/close/exitCode); the assembly call replaces the inline mount block. CLI behavior unchanged (guard: existing CLI specs + typecheck). |

**Execution ordering (dependency on A-region).** R-A1 (input tiers: send/followup/steer/inject + queue tiers) and R-A2 (per-session serial coordinator, cross-session parallel) land *before* C1 per the roadmap's dependency cross (§5). This plan defines the `SessionExecutor` contract it consumes **before** A exists — see Consumed Contracts below, and the per-task flag **"verify against A-plan at execution"**. The mechanical adaptation surface if A's interface differs: `SessionExecutor.submit` (T2) — A1's input tiers replace/augment the prompt-string signature; T10/T11 (host mux opener) and T22 (CLI wiring) touch nothing else. Everything else in this plan is A-independent.

**Semantics preserved from the branch (ported).** Mux protocol shapes and slow-consumer/duplicate-rules; live stream drain-then-park + reattach rebinding; approval/question waterfall broadcast + fail-closed timers; page caps (200 default / 500 hard); snapshot-vs-live session resolution (live instance → coordinator snapshot → empty session); refcounted per-session stream bundles.

---

## File Structure Map

```
packages/session-executor/            (NEW — engine-owned assembly + registry)
├─ package.json                       ws-free; deps = the run.ts assembly set
├─ tsconfig.json
├─ src/index.ts                       re-exports assembly + executor
├─ src/assembly.ts                    createSessionAssembly (port of branch live-agent.ts; +run.ts bits: restoredState)
├─ src/executor.ts                    createSessionExecutor (NEW code: registry, serial chains, submit, hooks)
└─ test/executor.test.ts              serial-submit/cancel/close, onAssembly, liveSession
packages/web-host/                    (NEW — transport-only API surface)
├─ package.json                       deps per package deps list; "ws" (the one new external)
├─ tsconfig.json
├─ src/index.ts                       re-exports
├─ src/types.ts                       wire protocol (ClientMessage/ServerMessage/Endpoint) + seam faces + SessionPage
├─ src/mux.ts                         port of branch mux.ts (verbatim)
├─ src/live.ts                        port of branch live.ts (verbatim)
├─ src/approval.ts                    port of branch approval.ts (verbatim)
├─ src/questions.ts                   port of branch questions.ts (verbatim)
├─ src/pagination.ts                  port + afterSeq forward replay (C2)
├─ src/modelProtocol.ts               (NEW, provisional) wire-protocol vocab + resolve chain — E-contract flag
├─ src/models.ts                      port of branch models.ts (settings import → modelProtocol)
├─ src/host.ts                        port of branch host.ts (trimmed route set; executor-driven)
├─ src/auth.ts                        (NEW) HMAC cookie + launch token + DNS-rebind fence + CORS
└─ test/{mux,live,approval,questions,pagination,host,auth,models}.test.ts
packages/interaction/src/index.ts     MODIFY (additive): CommandMeta.description/argumentHints,
│                                     CommandDescriptor, listCommands, listCommandNames,
│                                     parseCommandLine, name grammar at registration
packages/core-session/src/index.ts    MODIFY (additive): reasoning, command/run, command/done event types
packages/session-persistence/src/index.ts
│                                     MODIFY (+backend contract): profile(), updateMeta(),
│                                     SessionMeta.{title,workspaceId,modelSelection}, SessionModelSelection
packages/session-persistence-jsonl/src/index.ts   MODIFY: updateMeta header rewrite, profile header read
packages/session-persistence-sqlite/src/index.ts  MODIFY: updateMeta (unknown-key refuse), profile; schema title column
packages/provider/src/index.ts        MODIFY: port branch directory/probe surface
packages/telemetry/src/types.ts       MODIFY: +3 event codes; add manifest.ts (NEW) with doc table
packages/telemetry/src/manifest.ts    (NEW) TELEMETRY_MANIFEST + compile-time exhaustiveness
apps/cli/src/run.ts                   MODIFY: one-shot orchestration over createSessionAssembly
apps/cli/src/web.ts                   (NEW, thin) createWebServer composition + model chain + auth wiring
apps/cli/src/index.ts                 MODIFY: `web` subcommand
```

---

## Consumed Contracts

*(The interfaces this plan consumes but does not define. Every entry is exact; flags note what must be verified at execution.)*

### 1. `SessionExecutor` — consumed by web-host + CLI — **DEFINED HERE, FLAG: verify against A-plan at execution**

```ts
// packages/session-executor/src/executor.ts (consumed by packages/web-host/src/host.ts and apps/cli/src/web.ts)
export interface SessionExecutorOptions extends AssemblyOptions {
  telemetry?: Telemetry                       // shared host event stream (also flows into assemblies)
  loadMeta?: (sessionId: string) => Promise<SessionMeta | undefined>   // FIRST-assembly meta source (model tier 1)
  modelBuilder?: (sessionId: string, meta: SessionMeta | undefined) => Promise<ModelClient | undefined>
}                                             // absent modelBuilder → the assembly's mock default

export interface SessionExecutor {
  /** One prompt for one session. FIRST submit = agent.run; later = agent.followup.
   *  Serialized per session; cross-session parallel. Abort cancels cooperatively;
   *  a queued turn that is aborted before start never runs. Fails when the
   *  session is unknown (loadMeta rejection) — the host maps it to an error frame. */
  submit(sessionId: string, prompt: string, signal: AbortSignal): Promise<void>
  assemblyFor(sessionId: string): Promise<SessionAssembly>
  liveSession(sessionId: string): Session | undefined
  hasAssembly(sessionId: string): boolean
  /** Fires once per created assembly — the bridge attach point (approval/question). */
  onAssembly(hook: (assembly: SessionAssembly) => void): () => void
  /** Wait for active turns, then dispose every assembly best-effort. */
  close(): Promise<void>
}
export function createSessionExecutor(opts: SessionExecutorOptions): SessionExecutor
```

**A-plan flag (verify at execution):** R-A1 adds input tiers (`send/followup/steer/inject` + queue 分級 + 持久化收件箱; R-A1 note: `agent/input/admitted|promoted|cancelled` event types) and R-A2 defines the real per-session serialize/coordinate shape. This plan's `submit(sessionId, prompt, signal)` is the **tier-0 send** with a simplified queue (in-memory per-session chain, no persisted inbox). If A's `SessionExecutor` differs (likely: input object with `tier`, or `submit(input: SessionInput)`), adapt mechanically in T2 and re-point T11's opener + T22's wiring; the web-host surface (mux frames, routes) is unaffected.

```ts
// packages/session-executor/src/assembly.ts
export interface AssemblyOptions {
  sessionId?: string                    // telemetry attribution + subagent persist stateId
  workspace: string
  model?: ModelClient
  mockScript?: MockStep[]
  approveAll?: boolean                  // auto-approve; absent → NO answerer (fail-closed, host wires the bridge)
  sandbox?: SandboxMode
  shellTimeoutMs?: number               // default 120_000
  shellRetention?: ShellRetentionOptions
  retry?: RetryConfig
  maxParallelToolCalls?: number
  mcp?: McpServerConfig[]
  pluginMcp?: McpServerConfig[]         // per-server containment; pluginMcpResults reports
  lsp?: LspServerConfig[]
  skills?: { extraDirs?: string[] }
  team?: Partial<TeamConfig>
  sessionQuery?: SessionQuery
  compact?: CompactionConfig
  preset?: string
  session?: Session                     // host-pre-seeded session (host owns durability)
  coordinator?: SessionCoordinator      // when present (+sessionId): write-behind + subagent persist
  restoredState?: SubagentStateSnapshot // resume: subagent registries rebuilt from the doc (run.ts path)
  telemetry?: Telemetry                 // shared stream; session/start emitted at assembly create; NEVER closed here
}
export interface SessionAssembly {
  ctx: PluginContext
  agent: Agent
  session: Session
  sessionId?: string
  telemetry?: Telemetry
  killJob(jobId: string): JobKillOutcome
  pluginMcpResults: Map<string, boolean>
  dispose(): Promise<void>              // unmounts mcp/lsp/teams/skills/workflow, drops win ACL sandbox; NEVER closes coordinator/telemetry
}
export async function createSessionAssembly(opts: AssemblyOptions): Promise<SessionAssembly>
```

### 2. E-region package faces — consumed by web-host C5 routes — **FLAG: verify against E-plan at execution**

The E-region packages (`settings`, `credentials`, `workspace`, `plugin-registry`) do not exist on m26. This plan defines minimal **structural faces** in `web-host/src/types.ts` and has the host call the faces *through the seam* — no `@i-harness/settings` import anywhere in web-host, so the build stays green until E lands, then the swap is localized.

```ts
// web-host/src/types.ts — provisional (duck) faces; E-region owns the real implementations
export interface SettingsStoreFace {                    // provisional — E's SettingsStore satisfies it
  load(): Promise<void>
  get(): Record<string, unknown>                        // typed as the E store's Settings when swapped
  set(patch: Record<string, unknown>): Promise<Record<string, unknown>>
}
export interface SectionViewLike {                      // provisional describeSection projection
  name: string
  value: Record<string, unknown>                        // redacted merged view
  user: Record<string, unknown>                         // actually-stored user layer
  writable?: boolean
}
export interface CredentialStoreFace {
  describe(refs: string[]): Record<string, CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  resolve?(ref: string): string | undefined
}
export interface ProviderRegistryFace {                 // @i-harness/provider satisfies it structurally (C5 port)
  describeDirectory(): DirectoryEntry[]
  probeModels(route: string, req: { baseURL?: string; apiKey?: string; protocol?: string }): Promise<ModelDescriptor[]>
}
export interface ModelSources {
  settingsStore?: SettingsStoreFace            // absent → /api/settings* routes 404
  credentialStore?: CredentialStoreFace        // absent → /api/credentials* 404
  providerRegistry?: ProviderRegistryFace      // absent → /api/llm/* + /api/models/* 404
  describeSection?: (name: "llm" | "onboarding") => Promise<SectionViewLike>  // E's describeSection
  /** E-region typed errors → HTTP. The host is transport-only: the embedder's
   *  seam maps (SettingsConflictError → 409 etc.); absent → generic 500. */
  forwardError?: (error: unknown) => { status: number; code?: string; body: unknown } | undefined
}
```
**E-plan flag:** when E lands, replace `SettingsStoreFace`/`SectionViewLike` with the real `SettingsStore`/`SectionView` imports, and delete `modelProtocol.ts` (E's `PROVIDER_PROTOCOLS`/`resolveProviderProtocol` take over) — mechanical, one file each (flagged in T20). Recorded-deferred route families (workspace registry, plugin registry, session search/lineage) are **not** ported in this plan at all.

### 3. Existing m26 APIs consumed (exact, verified on m26)

```ts
// core-session
createSession(onAppend?: (ev: SessionEvent) => void): Session
append(session: Session, event: SessionEvent): void            // stamps seq = events.length; validates images
subscribe(session: Session, listener: (ev: SessionEvent) => void): () => void   // appends AFTER subscribe only
// SessionCoordinator (pre-C5 surface; C5 adds profile/updateMeta as patched contract below)
create(meta?: Partial<SessionMeta>): Promise<{ id: string }>
append(sessionId: string, events: SessionEvent[]): Promise<void>
enqueue(sessionId: string, events: SessionEvent[]): void
load(sessionId: string): Promise<{ session: Session }>
list(): Promise<string[]>
flush(sessionId: string): Promise<void>
close(): Promise<void>
putDocument(key: string, data: unknown): Promise<void>
getDocument(key: string): Promise<unknown | undefined>
// patched (C5): profile(sessionId) → Promise<{ meta: SessionMeta; blank: boolean }>
//               updateMeta(sessionId, patch: Partial<SessionMeta>) → Promise<SessionMeta>
// interaction (pre-patch): registerApprovalAnswerer(ctx, (req: ApprovalRequest) => Promise<{ approved: boolean }>)
//   registerQuestionProvider(ctx, { ask(q: UserQuestion): Promise<string> })
//   registerCommand(ctx, cmd: Command); runCommand(ctx, name, input) → Promise<string>
// core-plugin: createContext(): PluginContext — ctx.services.register/get, ctx.mount(plugin), ctx.guard, ctx.cascade
// provider (pre-patch): createProviderRegistry(): { register, get, list, remove }
```

---

## Produced Contracts

*(What this plan's packages export; later tasks and consumers use these exact names.)*

```ts
// packages/session-executor/src/index.ts
export { createSessionAssembly, type AssemblyOptions, type SessionAssembly } from "./assembly.ts"
export { createSessionExecutor, type SessionExecutor, type SessionExecutorOptions } from "./executor.ts"

// packages/web-host/src/index.ts
export * from "./types.ts"
export { WebSocketMuxServer } from "./mux.ts"
export type { StreamOpener } from "./mux.ts"
export { LiveSessionStreams, type AgentState } from "./live.ts"
export { ApprovalMuxBridge, ApprovalWaterfall } from "./approval.ts"
export { QuestionMuxBridge, QuestionWaterfall } from "./questions.ts"
export { paginateEvents, type PaginateOptions, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "./pagination.ts"
export { createWebHost, type WebHost, type WebHostOptions, type WebHostSessionLiveOptions } from "./host.ts"
export { createAuth, type AuthContext, type AuthOptions } from "./auth.ts"
export { buildModelsCatalog, mergeDirectoryRows, mergeCatalogModels, sectionUserProviders, catalogDefaultOf,
  type ModelsCatalogView, type CatalogDefault, type CatalogGroup, type CatalogModel, type CatalogFailure,
  type ProviderDirectoryRow, type UserProviderView } from "./models.ts"
export { PROVIDER_PROTOCOLS, DEFAULT_PROVIDER_PROTOCOL, SEEDED_PROTOCOLS, resolveProviderProtocol,
  type SettingsProviderProtocol, type SettingsProviderConfig } from "./modelProtocol.ts"
// subpath exports: "./types" (types only), "./auth", "./models", "./mux" (branch precedent)

// wire protocol (types.ts — exact branch shapes, preserved)
export type Endpoint = "session" | "chunk" | "reasoning" | "agent-state" | "approval" | "question" | "command"
export type ClientMessage =
  | { type: "open"; streamId: string; endpoint: Endpoint; payload: unknown }
  | { type: "cancel"; streamId: string }
  | { type: "approval"; streamId: string; value: ApprovalResponseWire }
  | { type: "answer";  streamId: string; value: QuestionResponseWire }
export type ServerMessage =
  | { type: "ready"; streamId: string }
  | { type: "item";  streamId: string; value: unknown }
  | { type: "end";   streamId: string }
  | { type: "error"; streamId: string; error: unknown }
```

```ts
// web-host/src/auth.ts
export interface AuthOptions {
  hmacSecret: string      // ≥32 random bytes hex — cookie signing key (shorter is rejected)
  launchToken: string     // the bootstrap secret accepted via ?token= (login/ws/curl)
  cookieName?: string     // default "i-harness"
  maxAgeMs?: number       // session-cookie TTL, default 7*24*3600*1000
}
export interface AuthContext {
  cookieName(): string
  launchToken(): string
  tokenValid(token: string | undefined): boolean          // constant-time vs launchToken
  signSession(extra?: Record<string, unknown>): string    // b64u(payload).b64u(hmac) — payload {s, exp}
  verifySession(token: string | undefined): boolean       // hmac constant-time + exp check
  hostAllowed(hostHeader: string | undefined): boolean    // loopback only (DNS-rebind fence)
  originAllowed(originHeader: string | undefined): boolean // http(s) + loopback (CORS + fence)
}
export function createAuth(opts: AuthOptions): AuthContext
```
HTTP behavior of the wired guard (host-internal, not part of `AuthContext`): on any request — fence first (bad Host or bad Origin → 403 JSON), then OPTIONS preflight (204 with `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Headers: content-type`, `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`, `Vary: Origin` — only when the origin is allowed), then cookie-or-token auth (401 JSON). The mux upgrade applies fence + cookie-or-token before `handleUpgrade`.

---

## Tasks

All paths relative to `D:\I-harness-main`. Branch reference files are under `D:\agent-complete\I-harness\` (read-only). Commits target branch `m26` (already checked out). Run per-package tests with `pnpm --filter <pkg> test`, typecheck with `pnpm --filter <pkg> typecheck`, and the full suite with `pnpm -r typecheck && pnpm -r test`.

**Suggested sequential execution order** (technically motivated, not the numbered order): **T1 → T2 → T3 (telemetry manifest) → T4 → T6 → T7 → T8 → T9 → T10...** — Task 3 must run before Task 2 because Task 2's `submit` emits `session/request`/`session/queued`/`session/error` onto the *closed* `TelemetryEventType` union (compile error otherwise). The numbered order reflects the milestone narrative (C0 → C1 → C3 → C2 → C6 → C5); the numbers are stable either way — only the T3/T2 swap is load-bearing.

---

### Task 1: session-executor — package scaffold + `createSessionAssembly`

**Files:**
- Create: `packages/session-executor/package.json`, `packages/session-executor/tsconfig.json`, `packages/session-executor/src/index.ts`, `packages/session-executor/src/assembly.ts`
- Reference (copy base): `D:\agent-complete\I-harness\apps\cli\src\live-agent.ts` (360 lines — read it before copying)

**Interfaces:**
- Consumes: `createAgent` (`@i-harness/core-agent`), `createToolRegistry` (`@i-harness/core-tools`), the mount packages — all already m26 deps of `apps/cli`, listed in `apps/cli/package.json` (that list is the dependency list for this package).
- Produces: `createSessionAssembly`, `AssemblyOptions`, `SessionAssembly` — exactly the shapes in Consumed Contract §1.

- [ ] **Step 1: Create the package scaffolding**

```bash
mkdir -p packages/session-executor/src packages/session-executor/test
```

`packages/session-executor/package.json`:

```json
{
  "name": "@i-harness/session-executor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/agent-team": "workspace:*",
    "@i-harness/compaction": "workspace:*",
    "@i-harness/core-agent": "workspace:*",
    "@i-harness/core-plugin": "workspace:*",
    "@i-harness/core-session": "workspace:*",
    "@i-harness/core-tools": "workspace:*",
    "@i-harness/exec": "workspace:*",
    "@i-harness/fs": "workspace:*",
    "@i-harness/fs-search": "workspace:*",
    "@i-harness/guard-approval": "workspace:*",
    "@i-harness/guard-retry": "workspace:*",
    "@i-harness/guard-repeat-tool": "workspace:*",
    "@i-harness/guard-timeout": "workspace:*",
    "@i-harness/interaction": "workspace:*",
    "@i-harness/llm-mock": "workspace:*",
    "@i-harness/llm-seam": "workspace:*",
    "@i-harness/lsp": "workspace:*",
    "@i-harness/mcp-client": "workspace:*",
    "@i-harness/preset": "workspace:*",
    "@i-harness/provider": "workspace:*",
    "@i-harness/sandbox": "workspace:*",
    "@i-harness/sandbox-local": "workspace:*",
    "@i-harness/sandbox-policy": "workspace:*",
    "@i-harness/sandbox-windows-acl": "workspace:*",
    "@i-harness/session-persistence": "workspace:*",
    "@i-harness/session-query": "workspace:*",
    "@i-harness/shell": "workspace:*",
    "@i-harness/skills": "workspace:*",
    "@i-harness/subagent": "workspace:*",
    "@i-harness/telemetry": "workspace:*",
    "@i-harness/todo": "workspace:*",
    "@i-harness/tool-search": "workspace:*",
    "@i-harness/workflow": "workspace:*"
  }
}
```

`packages/session-executor/tsconfig.json` — copy `packages/guard-retry/tsconfig.json` (nearest small package; same compilerOptions, `include: ["src", "test"]`).

- [ ] **Step 2: Port `live-agent.ts` → `assembly.ts` with the exact diffs**

Copy `D:\agent-complete\I-harness\apps\cli\src\live-agent.ts` to `packages/session-executor/src/assembly.ts`, then apply every edit below (do not skip one — the engine-owned contract depends on each):

1. Header comment → engine-owned: "ONE assembly implementation. `runHeadless` (one-shot) and the web `SessionExecutor` (multi-turn) both build through this. The branch's per-session live-agent file no longer exists."
2. `interface LiveAgentOptions` → `export interface AssemblyOptions` (same fields **plus**):
   - `sessionId?: string` (was required string — one-shot may have none),
   - `restoredState?: SubagentStateSnapshot` (add; import type from `@i-harness/subagent`),
   - `telemetry?: Telemetry` (was `telemetry?: "jsonl"` — delete the `import { createTelemetry, createJsonlSink }` line; `Telemetry` comes from `@i-harness/telemetry` import type only).
3. `interface LiveAgentHandle` → `export interface SessionAssembly`; `sessionId: string` → `sessionId?: string`.
4. `async function createLiveAgent(opts: LiveAgentOptions)` → `export async function createSessionAssembly(opts: AssemblyOptions)`.
5. Telemetry block (around the old line 185): replace the `opts.telemetry === "jsonl" ? createTelemetry(...) : undefined` expression with `const telemetry: Telemetry | undefined = opts.telemetry`, and the `session/start` emit keeps data `{ sessionId }` **spread only when defined**: `data: { ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}) }`.
6. Session creation stays: `opts.session ?? createSession((ev) => { if (opts.coordinator === undefined || opts.sessionId === undefined) return; opts.coordinator.enqueue(opts.sessionId, [ev]); if (ev.type === "turn/end") void opts.coordinator.flush(opts.sessionId).catch(() => {}) })` — **keep the batch/flush-on-turn/end behavior as-is**.
7. Subagent mount: pass the existing `restoredState` through: add `...(opts.restoredState !== undefined ? { restoredState: opts.restoredState } : {})` to the `registerSubagent` options.
8. `createLiveAgent`'s `sessionId` references become `opts.sessionId` (currently `opts.sessionId` string; now optional — guard the persist wrapper with `opts.coordinator !== undefined && opts.sessionId !== undefined`).
9. `dispose()`: **delete** the `if (opts.coordinator) await opts.coordinator.close()` block (the executor/run orchestrator owns coordinator lifecycle) and **delete** `telemetry?.close()` (caller owns the stream). Keep: reverse-order unmounts, winSandbox dispose, best-effort everything.
10. `killJob` and `pluginMcpResults` stay member-for-member.

- [ ] **Step 3: Create `src/index.ts`**

```ts
export { createSessionAssembly, type AssemblyOptions, type SessionAssembly } from "./assembly.ts"
```

- [ ] **Step 4: Install + typecheck + a smoke test**

Run: `pnpm install` then `pnpm --filter @i-harness/session-executor typecheck`
Expected: clean `tsc --noEmit`.

Create `packages/session-executor/test/assembly.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSessionAssembly } from "../src/assembly.ts"

describe("createSessionAssembly", () => {
  it("composes an agent and a session and disposes cleanly", async () => {
    const assembly = await createSessionAssembly({ workspace: process.cwd(), sessionId: "s1" })
    expect(assembly.session.events).toEqual([])
    expect(assembly.agent).toBeDefined()
    await assembly.dispose()
  })
})
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @i-harness/session-executor test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/session-executor
git commit -m "feat(session-executor): sink the runHeadless assembly into createSessionAssembly (R-C0)"
```

---

### Task 2: session-executor — `createSessionExecutor` (registry + serial submit)

**Files:**
- Create: `packages/session-executor/src/executor.ts`, `packages/session-executor/test/executor.test.ts`
- Modify: `packages/session-executor/src/index.ts`
- Reference: branch `host.ts` `commandStream`/`commandChains` (the serial-chain pattern, lines 531–620 of package web-host host.ts) — read it before writing.

**Interfaces:**
- Consumes: `SessionExecutorOptions`, `createSessionAssembly`, `SessionAssembly` (Task 1); `Telemetry.emit`; `ModelClient`.
- Produces: `createSessionExecutor`, `SessionExecutor` — Consumed Contract §1.

- [ ] **Step 1: Write the failing tests**

`packages/session-executor/test/executor.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSessionExecutor, type SessionExecutor } from "../src/executor.ts"
import { createTelemetry, type TelemetrySink } from "@i-harness/telemetry"

function collectEvents(): { events: unknown[] } {
  const events: unknown[] = []
  const sink: TelemetrySink = { onEvent: (ev) => { events.push(ev) } }
  return { events }
}

describe("createSessionExecutor", () => {
  it("runs the first submit and serializes the second behind it", async () => {
    const executor = createSessionExecutor({ workspace: process.cwd(), sessionId: "s1", approveAll: true })
    const order: string[] = []
    const p1 = executor.submit("s1", "first", new AbortController().signal).then(() => order.push("first-done"))
    const p2 = executor.submit("s1", "second", new AbortController().signal).then(() => order.push("second-done"))
    await Promise.all([p1, p2])
    expect(order).toEqual(["first-done", "second-done"])
    const assemblies = executor.hasAssembly("s1")
    expect(assemblies).toBe(true)
    expect(executor.liveSession("s1")).toBeDefined()
  })

  it("an aborted queued turn settles without breaking the chain", async () => {
    const executor = createSessionExecutor({ workspace: process.cwd(), sessionId: "s1", approveAll: true })
    const p1 = executor.submit("s1", "one", new AbortController().signal)
    const gate = new AbortController()
    gate.abort() // aborted BEFORE the queued turn starts
    const p2 = executor.submit("s1", "two", gate.signal)
    await Promise.all([p1, p2]) // both settle: the chain keeps moving
    // the chain is still usable — a third turn runs:
    const p3 = executor.submit("s1", "three", new AbortController().signal)
    await p3
    expect(executor.hasAssembly("s1")).toBe(true)
  })

  it("onAssembly fires once per session with the assembly ctx", async () => {
    const executor = createSessionExecutor({ workspace: process.cwd(), sessionId: "s1", approveAll: true })
    const seen: string[] = []
    executor.onAssembly((a) => { seen.push(a.sessionId ?? "") })
    await executor.submit("s1", "x", new AbortController().signal)
    expect(seen).toEqual(["s1"])
  })

  it("emits session/request then session/queued for a chained submit", async () => {
    const collections = collectEvents()
    const executor = createSessionExecutor({
      workspace: process.cwd(), sessionId: "s1", approveAll: true,
      telemetry: createTelemetry([collections.sink]),
    })
    const p1 = executor.submit("s1", "one", new AbortController().signal)
    const p2 = executor.submit("s1", "two", new AbortController().signal)
    await Promise.all([p1, p2])
    const types = collections.events.map((e) => (e as { type: string }).type)
    expect(types).toContain("session/request")
    expect(types).toContain("session/queued")
  })

  it("close() disposes assemblies and settles active turns", async () => {
    const executor: SessionExecutor = createSessionExecutor({ workspace: process.cwd(), sessionId: "s1", approveAll: true })
    await executor.submit("s1", "x", new AbortController().signal)
    await executor.close()
    expect(executor.liveSession("s1")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @i-harness/session-executor test`
Expected: FAIL — `../src/executor.ts` does not exist.

- [ ] **Step 3: Implement `executor.ts`**

```ts
// packages/session-executor/src/executor.ts
// R-A1/R-A2 contract surface (engine-owned posture R-C0): the per-session SERIAL
// coordinator (A2) and the input tier-0 dispatch (A1 "send") live HERE — the web
// host owns only transport. The serial chain is the command-chain pattern ported
// from the branch's web-host host.ts (turns settle at the runner's settle point;
// an aborted QUEUED turn still settles so the chain keeps moving).
//
// A-plan flag (verify at execution): R-A1 replaces `submit(sessionId, prompt,
// signal)` with the tiered input surface (send/followup/steer/inject; queue
// tiers; persisted inbox). This submit is tier-0 send over an IN-MEMORY
// per-session chain. Adapt mechanically; nothing else here depends on it.
import type { Session } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionMeta } from "@i-harness/session-persistence"
import type { Telemetry } from "@i-harness/telemetry"
import { createSessionAssembly, type AssemblyOptions, type SessionAssembly } from "./assembly.ts"

export interface SessionExecutorOptions extends AssemblyOptions {
  /** Shared host event stream (also handed to each assembly). */
  telemetry?: Telemetry
  /** Metadata source for an assembly's FIRST build (the tier-1 model chain
   * input, e.g. session.meta.modelSelection). Absent → no meta. */
  loadMeta?: (sessionId: string) => Promise<SessionMeta | undefined>
  /** Per-assembly model resolution; the chain itself stays in the composition
   * (apps/cli/src/web.ts resolveModelSpec). Absent → the assembly's mock. */
  modelBuilder?: (sessionId: string, meta: SessionMeta | undefined) => Promise<ModelClient | undefined>
}

export interface SessionExecutor {
  submit(sessionId: string, prompt: string, signal: AbortSignal): Promise<void>
  assemblyFor(sessionId: string): Promise<SessionAssembly>
  liveSession(sessionId: string): Session | undefined
  hasAssembly(sessionId: string): boolean
  onAssembly(hook: (assembly: SessionAssembly) => void): () => void
  close(): Promise<void>
}

export function createSessionExecutor(opts: SessionExecutorOptions): SessionExecutor {
  const assemblies = new Map<string, SessionAssembly>()
  const creating = new Map<string, Promise<SessionAssembly>>()
  const hooks = new Set<(assembly: SessionAssembly) => void>()
  const chains = new Map<string, Promise<void>>()
  const hasRun = new Set<string>()
  const active = new Set<Promise<void>>()
  const telemetry = opts.telemetry
  let closed = false

  async function getOrCreate(sessionId: string): Promise<SessionAssembly> {
    const existing = assemblies.get(sessionId)
    if (existing !== undefined) return existing
    let pending = creating.get(sessionId)
    if (pending === undefined) {
      pending = (async () => {
        const meta = opts.loadMeta === undefined ? undefined : await opts.loadMeta(sessionId)
        const model = opts.modelBuilder === undefined ? undefined : await opts.modelBuilder(sessionId, meta)
        const assembly = await createSessionAssembly({
          ...opts,
          sessionId,
          ...(model !== undefined ? { model } : {}),
        })
        assemblies.set(sessionId, assembly)
        // Hooks fire ONCE per assembly, after registration, inside the shared
        // pending — concurrent racers never double-attach (ApprovalMuxBridge
        // registers its answerer per ctx; a double attach would register twice).
        for (const hook of [...hooks]) hook(assembly)
        return assembly
      })().finally(() => { creating.delete(sessionId) })
      creating.set(sessionId, pending)
    }
    return pending
  }

  async function startTurn(sessionId: string, prompt: string, signal: AbortSignal): Promise<void> {
    const assembly = await getOrCreate(sessionId)
    if (signal.aborted || closed) return
    if (hasRun.has(sessionId)) {
      await assembly.agent.followup(prompt, signal)
    } else {
      await assembly.agent.run(prompt, signal)
      hasRun.add(sessionId)
    }
  }

  function submit(sessionId: string, prompt: string, signal: AbortSignal): Promise<void> {
    // `hasQueued` = a prior turn for this session is still unsettled (map
    // entries are removed when a turn settles). Read BEFORE setting ours.
    const hasQueued = chains.has(sessionId)
    const prev = chains.get(sessionId) ?? Promise.resolve()
    let settle!: () => void
    const turn = new Promise<void>((resolve) => { settle = resolve })
    chains.set(sessionId, turn)
    active.add(turn)
    void turn.finally(() => {
      if (chains.get(sessionId) === turn) chains.delete(sessionId)
      active.delete(turn)
    })
    telemetry?.emit({ type: "session/request", ts: Date.now(), data: { sessionId } })
    if (hasQueued) {
      telemetry?.emit({ type: "session/queued", ts: Date.now(), data: { sessionId } })
    }
    void prev.then(() => {
      if (closed || signal.aborted) {
        settle() // the queued turn never starts; the chain keeps moving
        return
      }
      startTurn(sessionId, prompt, signal).then(
        () => settle(),
        (error: unknown) => {
          if (!signal.aborted && !closed) {
            telemetry?.emit({
              type: "session/error",
              ts: Date.now(),
              data: { sessionId, error: error instanceof Error ? error.message : String(error) },
            })
          }
          settle()
        },
      )
    })
    return turn
  }

  async function close(): Promise<void> {
    closed = true
    await Promise.allSettled([...active])
    const handles = [...assemblies.values()]
    assemblies.clear()
    hasRun.clear()
    for (const handle of handles) await handle.dispose().catch(() => {})
  }

  return {
    submit,
    assemblyFor: getOrCreate,
    liveSession: (sessionId) => assemblies.get(sessionId)?.session,
    hasAssembly: (sessionId) => assemblies.has(sessionId),
    onAssembly: (hook) => {
      hooks.add(hook)
      return () => { hooks.delete(hook) }
    },
    close,
  }
}
```

Update `packages/session-executor/src/index.ts`:

```ts
export { createSessionAssembly, type AssemblyOptions, type SessionAssembly } from "./assembly.ts"
export { createSessionExecutor, type SessionExecutor, type SessionExecutorOptions } from "./executor.ts"
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @i-harness/session-executor test && pnpm --filter @i-harness/session-executor typecheck`
Expected: PASS — *requires Task 3 (telemetry manifest) to have run first* (the `submit` emits onto the now-widened union; see the execution-order note above).

- [ ] **Step 5: Commit**

```bash
git add packages/session-executor/src/executor.ts packages/session-executor/test/executor.test.ts packages/session-executor/src/index.ts
git commit -m "feat(session-executor): add SessionExecutor registry with per-session serial submit (R-C0/R-A2 contract)"
```

---

### Task 3: telemetry types expansion (R-C6 codes) — done early for the cast-free executor

**Files:**
- Modify: `packages/telemetry/src/types.ts`
- Create: `packages/telemetry/src/manifest.ts`, `packages/telemetry/test/manifest.test.ts`
- Modify: `packages/telemetry/src/index.ts`

**Interfaces:**
- Consumes: existing 14-code union (verified identical m26 vs branch).
- Produces: `TelemetryEventType` with `+3` codes; `TELEMETRY_MANIFEST`; `TELEMETRY_EVENT_TYPES`. Additive — no existing consumer changes.

- [ ] **Step 1: Write the failing test**

`packages/telemetry/test/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { TELEMETRY_MANIFEST, TELEMETRY_EVENT_TYPES } from "../src/manifest.ts"
import type { TelemetryEventType } from "../src/types.ts"

describe("telemetry event manifest", () => {
  it("is exhaustive: every union code has a manifest row", () => {
    const codes = new Set<TelemetryEventType>(TELEMETRY_EVENT_TYPES)
    for (const row of TELEMETRY_MANIFEST) expect(codes.has(row.code)).toBe(true)
    // compile-time: a union member without a manifest row fails typecheck
    type Missing = Exclude<TelemetryEventType, (typeof TELEMETRY_MANIFEST)[number]["code"]>
    const missing: Missing[] = []
    expect(missing).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @i-harness/telemetry test`
Expected: FAIL — `../src/manifest.ts` missing.

- [ ] **Step 3: Widen the union** — `packages/telemetry/src/types.ts` (add three lines to `TelemetryEventType`):

```ts
export type TelemetryEventType =
  | "session/start"
  | "session/end"
  | "session/request"   // an inbound prompt submitted to the SessionExecutor (R-C6)
  | "session/queued"     // the submit chained behind an active turn (per-session serial, R-C6)
  | "session/error"      // a run failed / an unknown session rejected (R-C6)
  | "turn/start"
  | "turn/end"
  | "tool/start"
  | "tool/end"
  | "tool/error"
  | "provider/call"
  | "provider/error"
  | "token/usage"
  | "retry/start"
  | "error"
  | "warn"
  | "mcp/server-status"
```

- [ ] **Step 4: Add the manifest**

`packages/telemetry/src/manifest.ts`:

```ts
// packages/telemetry/src/manifest.ts — R-C6: the manifest-level event code registry.
// One row per code the runtime ACTUALLY emits (never a code without a producer).
// `refs` maps to the five-source audit's names (opencode ~60 codes / codex event
// notification sets) so the vocabulary drift questions are answered inside the
// repo (audit 2026-08-31 §6), while the i-harness codes stay OUR stable set.
import type { TelemetryEventType } from "./types.ts"

export interface TelemetryEventCodeDoc {
  code: TelemetryEventType
  domain: "session" | "turn" | "tool" | "provider" | "token" | "retry" | "mcp" | "system"
  description: string
  refs?: string[]
}

export const TELEMETRY_MANIFEST = [
  { code: "session/start",  domain: "session", description: "A session run/assembly started", refs: ["opencode session/start"] },
  { code: "session/end",    domain: "session", description: "A session run ended with exitCode", refs: ["opencode session/end"] },
  { code: "session/request",domain: "session", description: "An inbound prompt submitted to the executor", refs: ["opencode session.next.prompt"] },
  { code: "session/queued", domain: "session", description: "The submit chained behind an active turn of the same session", refs: ["opencode session.next.admit", "codex queue"] },
  { code: "session/error",  domain: "session", description: "A run failed / rejected", refs: ["codex turn error"] },
  { code: "turn/start",     domain: "turn",    description: "An agent turn started", refs: ["opencode turn/start"] },
  { code: "turn/end",       domain: "turn",    description: "An agent turn ended", refs: ["opencode turn/end"] },
  { code: "tool/start",     domain: "tool",    description: "A tool call started", refs: ["opencode tool/start"] },
  { code: "tool/end",       domain: "tool",    description: "A tool call ended successfully", refs: ["opencode tool/end"] },
  { code: "tool/error",     domain: "tool",    description: "A tool call failed", refs: ["opencode tool/error"] },
  { code: "provider/call",  domain: "provider",description: "A provider round-trip began", refs: ["opencode provider/start"] },
  { code: "provider/error", domain: "provider",description: "A provider round-trip failed", refs: ["opencode provider/error"] },
  { code: "token/usage",    domain: "token",   description: "Token usage accounted after a turn", refs: ["opencode token/usage", "codex token/usage"] },
  { code: "retry/start",    domain: "retry",   description: "A tool retry (guard-retry) started", refs: ["codex retry"] },
  { code: "mcp/server-status", domain: "mcp", description: "MCP server mount/status transition", refs: ["opencode mcp/*"] },
  { code: "error",          domain: "system",  description: "Unclassified host error", refs: [] },
  { code: "warn",           domain: "system",  description: "Unclassified host warning", refs: [] },
] as const satisfies readonly TelemetryEventCodeDoc[]

export const TELEMETRY_EVENT_TYPES: readonly TelemetryEventType[] = TELEMETRY_MANIFEST.map((row) => row.code)
```

`packages/telemetry/src/index.ts` — add:

```ts
export { TELEMETRY_MANIFEST, TELEMETRY_EVENT_TYPES } from "./manifest.ts"
export type { TelemetryEventCodeDoc } from "./manifest.ts"
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @i-harness/telemetry test && pnpm --filter @i-harness/telemetry typecheck`
Expected: PASS. (Type-level: adding a union code without a manifest row now breaks `typecheck`.)

- [ ] **Step 6: Commit**

```bash
git add packages/telemetry/src packages/telemetry/test
git commit -m "feat(telemetry): manifest-level event code registry (R-C6)"
```

---

### Task 4: run.ts one-shot over the assembly

**Files:**
- Modify: `apps/cli/src/run.ts`
- Reference: current `apps/cli/src/run.ts` (read first), Task 1's assembly.

**Interfaces:**
- Consumes: `createSessionAssembly`, `AssemblyOptions` (Task 1); all existing `HeadlessOptions`/`HeadlessResult` unchanged (public API stable).
- Produces: `runHeadless(task, opts)` — same signature/behavior; the inline env block replaced by one assembly call.

- [ ] **Step 1: Verify current behavior baseline**

Run: `pnpm --filter @i-harness/cli typecheck` — must be clean before edits.

- [ ] **Step 2: Replace the assembly block**

In `apps/cli/src/run.ts`:

1. Imports: delete the per-tool imports that now come from the assembly (`createToolRegistry`, `registerShell`, `createFsTools`, `createApprovalPolicy`, `createRetryGuard`/`createTimeoutGuard`/`createRepeatToolGuard`, `registerToolSearch`, `createFsSearchTools`, `createSessionQueryTools`, `registerSkills`, `registerWorkflow`, `mountMcpClient`, `mountLspClient`, `mountAgentTeams`, `createProviderRegistry`, `createLocalSandbox`, `createWindowsAclSandbox`, `createSandboxPolicy`/`renderPolicyContext`, `createAgent`, `createMockClient` — keep `createMockClient`? no: the assembly owns the model default), plus `parsePreset`. Keep: `createContext` (heading comment references it — actually the ctx is created inside the assembly now; drop the import), `createSession`, `createMockClient` (dropped), types (`SessionCoordinator`, `ModelClient`, `CompactionConfig`, `RetryConfig`, `SandboxMode`, `ShellRetentionOptions`, `SessionQuery`, `McpServerConfig`, `LspServerConfig`, `TeamConfig`, `SubagentStateSnapshot`). Add: `import { createSessionAssembly } from "@i-harness/session-executor"` and `import type { Telemetry } from "@i-harness/telemetry"` (type). Remove the `registerApprovalAnswerer` import (assembly owns it via approveAll). The file keeps `isSubagentStateSnapshot` unchanged.
2. Delete lines 86–128's env setup *moved* block AND lines 245–360's mount+agent block — replace with a single assembly call (see the exact new body below). Keep the session-write-behind creation (`opts.session ?? createSession(...)`), the resume block (204–227), the restored-state block (229–243), and the result/error plumbing (361–411 refactored).

The new `runHeadless` body (replace `const ctx ...` through the finally block):

```ts
export async function runHeadless(task: string, opts: HeadlessOptions): Promise<HeadlessResult> {
  const activeId = opts.resumeSessionId ?? opts.sessionId
  const telemetry: Telemetry | undefined = opts.telemetry === "jsonl" ? createTelemetry([createJsonlSink(process.stdout)]) : undefined
  if (telemetry) {
    telemetry.emit({ type: "session/start", ts: Date.now(), data: { task, ...(activeId ? { sessionId: activeId } : {}) } })
  }
  const emitSessionEnd = (exitCode: number): void => {
    telemetry?.emit({ type: "session/end", ts: Date.now(), data: { ...(activeId ? { sessionId: activeId } : {}), exitCode } })
  }
  const session = opts.session ?? createSession((ev) => {
    if (!opts.coordinator || !activeId) return
    opts.coordinator.enqueue(activeId, [ev])
    if (ev.type === "turn/end") void opts.coordinator.flush(activeId).catch(() => {})
  })

  // Resume: unchanged — restore history, header, ownership lease (see the file's
  // existing block; keep as-is, lines 204–227).
  // M6: restored subagent state — keep the existing block (lines 229–243).

  // C-region R-C0: the run-level environment assembly (env + policy + guards +
  // tool families + mcp/lsp/teams/subagent/workflow mounts + agent) lives in
  // @i-harness/session-executor. run.ts owns ONE-TURN orchestration only:
  // resume/restore/flush/close and the result vocabulary.
  let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
  try {
    assembly = await createSessionAssembly({
      workspace: opts.workspace,
      sessionId: activeId,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.mockScript !== undefined ? { mockScript: opts.mockScript } : {}),
      approveAll: opts.approveAll,
      ...(opts.shellTimeoutMs !== undefined ? { shellTimeoutMs: opts.shellTimeoutMs } : {}),
      ...(opts.shellRetention !== undefined ? { shellRetention: opts.shellRetention } : {}),
      ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
      ...(opts.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: opts.maxParallelToolCalls } : {}),
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(opts.mcp !== undefined ? { mcp: opts.mcp } : {}),
      ...(opts.lsp !== undefined ? { lsp: opts.lsp } : {}),
      ...(opts.team !== undefined ? { team: opts.team } : {}),
      ...(opts.compact !== undefined ? { compact: opts.compact } : {}),
      ...(opts.sessionQuery !== undefined ? { sessionQuery: opts.sessionQuery } : {}),
      ...(opts.session !== undefined ? { session } : {}),
      ...(opts.coordinator !== undefined ? { coordinator: opts.coordinator } : {}),
      ...(restoredState !== undefined ? { restoredState } : {}),
      ...(telemetry !== undefined ? { telemetry } : {}),
    })
  } catch (err) {
    emitSessionEnd(1)
    telemetry?.close()
    if (opts.coordinator) await opts.coordinator.close().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  }
  if (telemetry) {
    telemetry.emit({ type: "session/request", ts: Date.now(), data: { ...(activeId ? { sessionId: activeId } : {}) } })
  }
  try {
    const result = await assembly.agent.run(task)
    if (opts.coordinator) {
      if (activeId) await opts.coordinator.flush(activeId)
      await opts.coordinator.close()
    }
    emitSessionEnd(0)
    telemetry?.close()
    return { finalText: result.finalText, exitCode: 0, session }
  } catch (err) {
    emitSessionEnd(1)
    telemetry?.close()
    if (opts.coordinator) await opts.coordinator.close().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await assembly?.dispose().catch(() => {})
  }
}
```

The removed block's `winSandbox` teardown, guard/timeout mounts, and reverse-order unmounts are all inside `createSessionAssembly.dispose()` now — the run never builds them twice.

Important deltas against the current file: the sandbox-policy `<session>` resolution and the `restoredState` shape-guard stay in run.ts as-is (`createSandboxPolicy(...).resolve({ session })` was run.ts-specific; the assembly's `sandboxPolicy` resolution uses `resolve({ session: opts.session })` like live-agent's — **verify at execution** which policy semantics the CLI needs: if the m26 CLI requires the resolved-policy-in-options shape, pass `sandboxPolicyResolved` through AssemblyOptions as an optional override — a two-line option, flagged as an **A-plan-adjacent deviation**: the assembly's default keeps the live-agent shape).

- [ ] **Step 3: Verify**

Run: `pnpm --filter @i-harness/cli typecheck && pnpm --filter @i-harness/session-executor typecheck && pnpm -r typecheck`
Expected: clean. Then a smoke run: `node --import tsx apps/cli/src/index.ts run "say hi"` — hmm, invoke via the package's own entry; follow the existing CLI: `pnpm --filter @i-harness/cli exec tsx src/index.ts run "ok"` (mock model, no key). Check it prints the mock output and exit code 0.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/run.ts
git commit -m "refactor(cli): one-shot runHeadless uses createSessionAssembly (R-C0)"
```

---

### Task 5: interaction additive command surface + core-session event types

**Files:**
- Modify: `packages/interaction/src/index.ts`, `packages/core-session/src/index.ts`, `packages/session-persistence/src/index.ts`
- Reference: `D:\agent-complete\I-harness\packages\interaction\src\index.ts` (diffs below are the branch's own)

**Interfaces:**
- Consumes: `PluginContext`, `SessionEvent`.
- Produces: `CommandDescriptor`, `ParsedCommandLine`, `listCommands(ctx): CommandDescriptor[]`, `listCommandNames(ctx): string[]`, `parseCommandLine(line): ParsedCommandLine | undefined`; `Command` gains optional `description`/`argumentHints`; core-session gains `reasoning`, `command/run`, `command/done` event variants (additive, format v1); session-persistence registers the new types.

- [ ] **Step 1: interaction additions** — apply the branch's additive diff (minus the markdown kind, which is plugin-registry territory deferred with E). There are three edits and one append in `packages/interaction/src/index.ts`:

**Edit 1** — `Command` gains discovery metas (insert into the interface, after `execute`):

```ts
export interface Command {
  name: string
  /** Optional human-readable summary for discovery UIs (DSH CommandDefinition
   * parity — the web command palette lists it as the hint next to the name). */
  description?: string
  /** Optional hint of the expected argument form (DSH parity). */
  argumentHints?: string
  execute(input: string, ctx: PluginContext): Promise<string>
}
```

**Edit 2** — `registerCommand` gains the name-grammar fail-loud guard (insert after the registry block's start — before `registry.set`):

```ts
// The one command-name grammar (DSH COMMAND_NAME rule): lowercase first, then
// letters/digits/underscore/dash. parseCommandLine parses the same alphabet,
// so a name that fails it could be registered and listed but never executed —
// fail loud at registration instead.
const COMMAND_NAME_SRC = "[a-z][a-z0-9_-]*"
if (!new RegExp(`^${COMMAND_NAME_SRC}$`).test(cmd.name)) {
  throw new TypeError(`command name "${cmd.name}" must match ^${COMMAND_NAME_SRC}$`)
}
```

**Edit 3/append** — at the end of the file, paste the branch's `CommandDescriptor`, `listCommands`, `listCommandNames`, `COMMAND_LINE_RE`, `ParsedCommandLine`, `parseCommandLine` (D:\agent-complete\I-harness\packages\interaction\src\index.ts lines 80–280: descriptors return name + optional description/argumentHints, NEVER execute; name-sorted lists; `parseCommandLine` regex `^[ \t]*\/?(${COMMAND_NAME_SRC})(?:[ \t]+(.*))?$` with `input: (match[2] ?? "").trim()`). Exact target shapes:

```ts
/** Description of one command for discovery (never the handler). */
export interface CommandDescriptor {
  name: string
  description?: string
  argumentHints?: string
}
export function listCommands(ctx: PluginContext): CommandDescriptor[]
export function listCommandNames(ctx: PluginContext): string[]
/** One parsed command line — "/theme dark" or "theme dark". */
export interface ParsedCommandLine { name: string; input: string }
export function parseCommandLine(line: string): ParsedCommandLine | undefined
```

- [ ] **Step 2: core-session event types** — in `packages/core-session/src/index.ts`, add to the `SessionEvent` union (these are model-invisible log types: `deriveMessages`' default branch and `deriveSearchText`'s `""` default already skip them — zero projection changes):

```ts
    // C-region port (frontend-web task 4 prelude / R-C1): the model's thinking
    // trajectory, persisted to the log but deliberately model-INVISIBLE —
    // deriveMessages skips it (default branch) and deriveSearchText returns ""
    // (unindexed). Additive event type; format version stays 1. The PRODUCER is
    // A/B-region (llm layer); the live `reasoning` mux stream carries it.
    | { type: "reasoning"; text: string; seq?: number }
    // C-region port (R-C1 commands lifecycle, DSH commands parity): a slash
    // command's execution pair, appended by the executing host before/after the
    // handler. UI-plane (audit F05-6): the command never creates a model
    // message (default branches) and is unindexed.
    | { type: "command/run"; commandId: string; name: string; args?: string; source: { kind: "user" }; seq?: number }
    | { type: "command/done"; commandId: string; kind: "success" | "error"; text?: string; seq?: number }
```

- [ ] **Step 3: session-persistence load-gate registration** — in `packages/session-persistence/src/index.ts` beside the M19/M21 registrations:

```ts
// C-region (port): the three event types the C service surface streams/persists.
registerEventType("reasoning")
registerEventType("command/run")
registerEventType("command/done")
```

- [ ] **Step 4: Write the tests**

`packages/core-session/test/events.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessages, deriveSearchText } from "../src/index.ts"

describe("C-region additive events", () => {
  it("reasoning and command events are model-invisible and unindexed", () => {
    const session = createSession()
    append(session, { type: "reasoning", text: "thinking" })
    append(session, { type: "command/run", commandId: "cmd-1", name: "theme", source: { kind: "user" } })
    append(session, { type: "command/done", commandId: "cmd-1", kind: "success", text: "ok" })
    append(session, { type: "user/message", text: "hello" })
    append(session, { type: "assistant/message", text: "hi" })
    const messages = deriveMessages(session)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(deriveSearchText(session.events[0]!)).toBe("")
    expect(deriveSearchText(session.events[1]!)).toBe("")
    expect(session.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
  })
})
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @i-harness/core-session test && pnpm --filter @i-harness/interaction typecheck && pnpm --filter @i-harness/session-persistence typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/interaction/src/index.ts packages/core-session/src/index.ts packages/session-persistence/src/index.ts
git commit -m "feat: additive command/parse surface + reasoning and command events (C1)"
```

---

### Task 6: web-host scaffold + wire protocol types

**Files:**
- Create: `packages/web-host/package.json`, `packages/web-host/tsconfig.json`, `packages/web-host/src/index.ts`, `packages/web-host/src/types.ts`
- Reference: `D:\agent-complete\I-harness\packages\web-host\src\types.ts` (the shapes below are its first half, trimmed of goal/jobs/feedback/plugins)

**Interfaces:**
- Consumes: `SessionEvent` (`@i-harness/core-session`), `CommandDescriptor` (Task 5), `DirectoryEntry`/`ModelDescriptor` (`@i-harness/provider`, post-C5), `SessionCoordinator`.
- Produces: `Endpoint`, `ClientMessage`, `ServerMessage`, `SessionPage`, `ApprovalRequestWire`, `ApprovalResponseWire`, `QuestionRequestWire`, `QuestionResponseWire`, `CommandRequestWire`, `CommandEventWire`, `CommandExecuteRequestWire`, `CommandBridge`, `JobKillOutcome`? (no — jobs deferred; drop), `SettingsStoreFace`, `SectionViewLike`, `CredentialInfo`, `CredentialStoreFace`, `ProviderRegistryFace`, `ModelSources` — all from Consumed Contract §1/§2.

- [ ] **Step 1: package.json**

```json
{
  "name": "@i-harness/web-host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types.ts",
    "./models": "./src/models.ts",
    "./auth": "./src/auth.ts",
    "./mux": "./src/mux.ts"
  },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-plugin": "workspace:*",
    "@i-harness/core-session": "workspace:*",
    "@i-harness/interaction": "workspace:*",
    "@i-harness/provider": "workspace:*",
    "@i-harness/session-persistence": "workspace:*",
    "@i-harness/session-executor": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@i-harness/session-persistence-jsonl": "workspace:*",
    "@i-harness/telemetry": "workspace:*",
    "@types/ws": "^8.5.12"
  }
}
```

- [ ] **Step 2: `types.ts`** — write from the branch's `types.ts` verbatim with these excisions: keep `Endpoint` minus `"team"`/`"telemetry"`; keep `ClientMessage`/`ServerMessage` verbatim; keep `SessionPage` (**modified in Task 10** — define it with `nextAfterSeq` up front: `{ events: SessionEvent[]; hasMore: boolean; nextBeforeSeq?: number; nextAfterSeq?: number }`); keep `ApprovalRequestWire`/`ApprovalResponseWire`/`QuestionRequestWire`/`QuestionResponseWire`/`CommandRequestWire`/`CommandEventWire`/`CommandExecuteRequestWire` and the `CommandBridge` seam (returns `Promise<string>` — note: with command/* event appends described as the host's concern, the seam stays host-agnostic; the CLI composes programmatic commands only in M26, markdown kind deferred with plugins). Delete: `JobKillBridge`, `JobKillUnknownJobError` import, `FileReferencesBridge`, `PluginRegistryFace`, `PluginsCatalogView` etc., `GoalView` re-export, and the `@i-harness/settings`/`@i-harness/plugin-registry`/`@i-harness/workspace`/`@i-harness/credentials` import lines — replace with the duck faces from Consumed Contract §2 (`SettingsStoreFace`, `SectionViewLike`, `CredentialInfo`, `CredentialStoreFace`, `ProviderRegistryFace`, `ModelSources`). `CredentialInfo` is `{ ref: string; configured: boolean; source?: "env" | "file"; writable?: boolean; shadowed?: boolean }` (the branch's credentials package owns the real shape; the duck face keeps exactly those fields on the wire).

- [ ] **Step 3: index.ts skeleton** (grows per task)

```ts
export * from "./types.ts"
```

- [ ] **Step 4: Verify**

Run: `pnpm install && pnpm --filter @i-harness/web-host typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web-host/package.json packages/web-host/tsconfig.json packages/web-host/src/index.ts packages/web-host/src/types.ts
git commit -m "feat(web-host): wire protocol types and seam faces (R-C1)"
```

---

### Task 7: mux transport (port verbatim) + tests

**Files:**
- Create: `packages/web-host/src/mux.ts`, `packages/web-host/test/mux.test.ts`
- Reference: `D:\agent-complete\I-harness\packages\web-host\src\mux.ts` (195 lines — port verbatim)

**Interfaces:**
- Consumes: `Endpoint`, `ClientMessage`, `ServerMessage`, `ApprovalResponseWire`, `QuestionResponseWire` (Task 6).
- Produces: `WebSocketMuxServer` (constructor `(opener: StreamOpener, handlers?: MuxMessageHandlers)`; `handleUpgrade(req, socket, head)`; `close()`), `StreamOpener`, `MuxMessageHandlers` — with the exact branch semantics: 8 MiB `MAX_BUFFERED_BYTES` slow-consumer cap (close 1008), text-only frames (1003), JSON parse failure → 1008, duplicate streamId → throw (1008), `cancel` → abort, `approval`/`answer` → handlers with malformed-value guard (non-object dropped, never a socket kill), `ready`/`item`/`end`/`error` frames, 30 s ping heartbeat (`unref()`), pump abort-aware so `close()` resolves.

- [ ] **Step 1: Port**. Copy the branch `mux.ts` unchanged (it imports only `node:http`, `node:stream`, `ws`, and `./types.ts` — all preserved).

- [ ] **Step 2: Port the tests**. Copy `D:\agent-complete\I-harness\packages\web-host\tests\mux.spec.ts` → `packages/web-host/test/mux.test.ts` (same cases; the runner is vitest either way). Run it.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @i-harness/web-host test`
Expected: PASS (all branch mux cases: open/ready/end, cancel, errored opener → error frame, approval/answer routing, dup stream 1008, binary frame 1003, slow-consumer close).

- [ ] **Step 4: Commit**

```bash
git add packages/web-host/src/mux.ts packages/web-host/test/mux.test.ts
git commit -m "feat(web-host): ws mux with slow-consumer cap and heartbeat (R-C1)"
```

---

### Task 8: live streams (port verbatim) + tests

**Files:**
- Create: `packages/web-host/src/live.ts`, `packages/web-host/test/live.test.ts`
- Reference: `D:\agent-complete\I-harness\packages\web-host\src\live.ts` (268 lines — port verbatim)

**Interfaces:**
- Consumes: `subscribe`, `Session`, `SessionEvent` (core-session); `reasoning` event type (Task 5).
- Produces: `LiveSessionStreams` (constructor `(session: Session)`; `reattach(session)`, `events(signal?)`, `chunks(signal?)`, `reasonings(signal?)`, `agentState(signal?)`), `AgentState` — exact branch semantics: drain-then-park generators, 25 ms chunk/reasoning coalescing, end on `assistant/message`, rebindable subscriptions across `reattach`, `abort` → return (keeps mux `close()` resolvable).

- [ ] **Step 1: Port** the file verbatim. Add no edits — the branch's `live.ts` needs nothing from this plan's changed packages.

- [ ] **Step 2: Port the tests** — copy `tests/live.spec.ts` → `test/live.test.ts` (cases: events appends, chunks coalescing window, reasoning coalescing, agentState transitions from turn/tool events, reattach rebind, abort unwind). Append one case for reasonings after a `reasoning` append (already in the branch suite).

- [ ] **Step 3: Verify**

Run: `pnpm --filter @i-harness/web-host test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web-host/src/live.ts packages/web-host/test/live.test.ts
git commit -m "feat(web-host): live session streams (events/chunks/reasoning/agent-state) (R-C1/C2)"
```

---

### Task 9: approval + question bridges (port verbatim) + tests

**Files:**
- Create: `packages/web-host/src/approval.ts`, `packages/web-host/src/questions.ts`, `packages/web-host/test/approval.test.ts`, `packages/web-host/test/questions.test.ts`
- Reference: branch `approval.ts` (163 lines), `questions.ts` (179 lines) — port verbatim

**Interfaces:**
- Consumes: `PluginContext` (core-plugin), `registerApprovalAnswerer` / `registerQuestionProvider` (interaction — both exist on m26), `ApprovalRequestWire`/`ApprovalResponseWire`/`QuestionRequestWire`/`QuestionResponseWire` (Task 6).
- Produces: `ApprovalWaterfall` (`new ApprovalWaterfall(ctx, emit, defaultTimeoutMs?)`, `attach(ctx?)`, `respond(response): boolean`), `ApprovalMuxBridge` (`attach(ctx?)`, `respond(response): boolean`, `open(signal?): AsyncGenerator<ApprovalRequestWire>`, `dispose()`), `QuestionWaterfall`/`QuestionMuxBridge` (same shapes). Exact fail-closed semantics: approval timeout → `{ approved: false }`; question timeout → reject; pending entries registered BEFORE emit; timers `unref()`; broadcast-to-every-open-sink; idempotent respond.

- [ ] **Step 1: Port both files verbatim** (they import only core-plugin, interaction, and `./types.ts` — all present).

- [ ] **Step 2: Port the tests** — branch `tests/approval.spec.ts` and `tests/questions.spec.ts` → `test/approval.test.ts` / `test/questions.test.ts` (attach→emit→respond; broadcast to two sinks; timeout fail-closed; stale respond false; malformed answer rejects; dispose ends the stream).

- [ ] **Step 3: Verify**

Run: `pnpm --filter @i-harness/web-host test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web-host/src/approval.ts packages/web-host/src/questions.ts packages/web-host/test/approval.test.ts packages/web-host/test/questions.test.ts
git commit -m "feat(web-host): approval and question mux bridges, fail-closed waterfalls (R-C1)"
```

---

### Task 10: pagination + afterSeq replay (C2)

**Files:**
- Create: `packages/web-host/src/pagination.ts`, `packages/web-host/test/pagination.test.ts`
- Reference: branch `pagination.ts` (39 lines — port, then extend)

**Interfaces:**
- Consumes: `Session`, `SessionEvent`, `SessionPage` (Task 6 shape with `nextAfterSeq`).
- Produces: `PaginateOptions { beforeSeq?: number; afterSeq?: number; limit?: number }`, `paginateEvents(session, opts): SessionPage`, `DEFAULT_PAGE_LIMIT = 200`, `MAX_PAGE_LIMIT = 500`.

- [ ] **Step 1: Port + extend** — copy the branch file, then implement `afterSeq` forward replay (opencode `after=seq` parity):

```ts
export function paginateEvents(session: Session, opts: PaginateOptions): SessionPage {
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit >= 1
    ? Math.min(Math.floor(opts.limit), MAX_PAGE_LIMIT)
    : DEFAULT_PAGE_LIMIT
  // C2 (afterSeq forward replay): events STRICTLY AFTER the cursor, in log
  // order, bounded by limit — the resume-after-disconnect seq replay. Infinite
  // to "absent" is applied to afterSeq the same way beforeSeq handles it: a
  // non-finite value is treated as absent (route-level validation REJECTS it
  // instead for the client to notice — see host.ts; the fold stays permissive
  // like the branch's beforeSeq arm).
  if (opts.afterSeq !== undefined && Number.isFinite(opts.afterSeq)) {
    const eligible = session.events.filter((ev) => seqOf(ev) > opts.afterSeq!)
    const head = eligible.slice(0, limit)
    const last = head.length > 0 ? seqOf(head[head.length - 1]!) : undefined
    const hasMore = eligible.length > head.length
    return { events: head, hasMore, ...(last === undefined ? {} : { nextAfterSeq: last }) }
  }
  const limitSeq = typeof opts.beforeSeq === "number" && Number.isFinite(opts.beforeSeq)
    ? opts.beforeSeq
    : Number.MAX_SAFE_INTEGER
  const eligible = session.events.filter((ev) => seqOf(ev) < limitSeq)
  const tail = eligible.slice(-limit)
  const oldest = tail.length > 0 ? seqOf(tail[0]) : undefined
  const hasMore = eligible.length > tail.length
  return {
    events: tail,
    hasMore,
    ...(oldest === undefined ? {} : { nextBeforeSeq: oldest }),
  }
}
```

- [ ] **Step 2: Tests** — port `tests/pagination.spec.ts` (limit defaults, non-finite guard, beforeSeq page walking to exhaustion) and append:

```ts
it("afterSeq replays forward and pages to exhaustion", () => {
  const session = createSession()
  for (let i = 0; i < 5; i++) append(session, { type: "user/message", text: `m${i}` })
  const page1 = paginateEvents(session, { afterSeq: 0, limit: 2 })
  expect(page1.events.map((e) => e.seq)).toEqual([1, 2])
  expect(page1.hasMore).toBe(true)
  expect(page1.nextAfterSeq).toBe(2)
  const page2 = paginateEvents(session, { afterSeq: page1.nextAfterSeq, limit: 2 })
  expect(page2.events.map((e) => e.seq)).toEqual([3, 4])
  expect(page2.hasMore).toBe(false)
})
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @i-harness/web-host test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web-host/src/pagination.ts packages/web-host/test/pagination.test.ts
git commit -m "feat(web-host): paged event history + afterSeq forward replay (R-C2)"
```

---

### Task 11: host core part A — unary session routes

**Files:**
- Create: `packages/web-host/src/host.ts` (this task: helpers + session routes; Task 12 adds the mux; Task 13 the command RPC; Task 17 models), `packages/web-host/test/host.test.ts` (this task: unary session suite)
- Reference: branch `host.ts` line ranges quoted per route

**Interfaces:**
- Consumes: `SessionExecutor` (Task 2), `SessionCoordinator` (m26), `readJsonObject` helpers, `SessionPage` (Task 10), `CommandBridge` (Task 6).
- Produces: `createWebHost(opts: WebHostOptions): WebHost` — this task's options: `{ port: number; executor: SessionExecutor; coordinator: SessionCoordinator; approvalBridge?: ApprovalMuxBridge; questionBridge?: QuestionMuxBridge; commandBridge?: CommandBridge; auth?: AuthContext; modelSources?: ModelSources }`. `WebHost { listen(): Promise<{port}>; close(): Promise<void>; attachLiveSession(options): void }`.

- [ ] **Step 1: Write the unary-route tests first** (focused smoke; the branch host.spec.ts is the fuller suite — port its session cases in Step 3):

`packages/web-host/test/host.test.ts`:

```ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createSessionExecutor } from "@i-harness/session-executor"
import { createWebHost } from "../src/host.ts"

const base = (host: { port: number }) => `http://127.0.0.1:${host.port}`
const tempStore = () => mkdtempSync(join(tmpdir(), "ih-web-host-"))

describe("host unary routes", () => {
  let stop: (() => Promise<void>) | undefined
  afterEach(async () => { await stop?.(); stop = undefined })

  it("creates and lists sessions, resumes, forks, pages events", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(tempStore()))
    const executor = createSessionExecutor({ workspace: process.cwd(), approveAll: true })
    const host = createWebHost({ port: 0, executor, coordinator })
    const { port } = await host.listen()
    stop = async () => { await host.close(); await coordinator.close() }

    let res = await fetch(`${base({ port })}/api/sessions`, { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } })
    expect(res.status).toBe(200)
    const { id } = await res.json() as { id: string }
    res = await fetch(`${base({ port })}/api/sessions`)
    expect((await res.json() as { sessions: unknown[] }).sessions.length).toBe(1)

    res = await fetch(`${base({ port })}/api/sessions/${id}/resume`, { method: "POST" })
    expect(res.status).toBe(200)

    res = await fetch(`${base({ port })}/api/sessions/${id}/events`)
    expect((await res.json()).events).toEqual([])
    expect(res.status).toBe(200)

    res = await fetch(`${base({ port })}/api/sessions/${id}/fork`, { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } })
    expect(res.status).toBe(409) // no completed turn to fork from
  })
})
```

- [ ] **Step 2: Run to verify failure** (module missing → FAIL).

- [ ] **Step 3: Implement `host.ts` core** — start from the branch `host.ts` copy, then apply the engine-owned edits. Guidance (copy the branch file into `packages/web-host/src/host.ts` first, then edit):

1. Imports: delete `node:fs/promises`, `node:path` (static/workspace), `@i-harness/attachment`, `@i-harness/workspace`, `@i-harness/credentials`, `@i-harness/settings`, `@i-harness/plugin-registry`, `./goal.ts`, `./jobs.ts`, `./feedback.ts`; keep `node:http`, `node:stream`, `@i-harness/core-session` (createSession/append/IMAGE constants keep for live fallback — wait: with attachments deferred, `IMAGE_MEDIA_TYPES` etc. are unused — drop them too; keep `Session`, `SessionEvent`, `createSession`), `@i-harness/session-persistence` (types), `@i-harness/session-query` (defer — drop), `./mux.ts`, `./pagination.ts`, `./live.ts`, `./approval.ts`, `./questions.ts`, `./types.ts`; add `import type { SessionExecutor } from "@i-harness/session-executor"` and `import { createAuth, type AuthContext } from "./auth.ts"` (after Task 14).
2. `WebHostOptions` → the produced shape (Port options above); keep `context?: PluginContext` off — the m26 host takes `approvalBridge`/`questionBridge` only, no shared ctx (the CLI composes bridges over the executor's assemblies via `onAssembly`; keep a `ctx?: PluginContext` for the fail-closed fallback attach `approvalBridge?.attach()` — see Task 12's opener).
3. Keep: `isUnknownSessionError`, `readJson`, `readJsonObject`, `normalizeSessionTitle` + `MAX_SESSION_TITLE_LENGTH` (title route arrives in Task 17 — keep the helper now), `parseSectionOps` (Task 17).
4. Routes (port from branch — the following branch host.ts ranges map exactly):
   - `GET /api/sessions` (branch 1026–1091): **drop** the workspace-registry join, `archived`, `workspaceId` fields; row = `{ id, running: executor.hasAssembly(id), ...(meta?.title !== undefined ? { title } : {}), ...(meta?.modelSelection !== undefined ? { modelSelection } : {}), ...(blank !== undefined ? { blank } : {}) }` — with `profile` calls only **after Task 17** lands; for this task the row is `{ id, running }` + the profile/(title/blank) bits behind a comment-ready `// C5` marker (execute Task 17's enrichment next).
   - `POST /api/sessions` (branch 1092–1154): drop the cwd/workspaceId branch entirely; body passthrough meta minus `cwd`/`workspaceId` (unchanged rules are in the branch comments); `const { id } = await coordinator.create(meta as { sessionId?: string })` → `{ id }`.
   - `PUT /api/sessions/:id` (title) — register in Task 17 (needs `updateMeta`).
   - `POST /api/sessions/:id/fork` (branch 1190–1320): drop every workspace attach step; keep the `atSeq`/`title`/boundary/prefix/`parentSession`/`seedLength` logic verbatim; the child `create` body = `{ ...(titleForChild !== undefined ? { title: titleForChild } : {}), parentSession: sourceId, seedLength: cut }`; answer `{ id, title?, seedLength }`.
   - `POST /api/sessions/:id/resume` (branch 1559–1575): verbatim.
   - `GET /api/sessions/:id/events` (branch 1576–1597): verbatim — the `beforeSeq` paged-history arm only; `afterSeq` lands in Task 15.
   - `DELETE` everything else; final 404 JSON fallback verbatim.
5. `createWebHost` return: `listen()` binds `opts.port` on `127.0.0.1` (branch verbatim); `close()` = `await mux.close(); await new Promise(res => { server.close(() => res()); server.closeIdleConnections() })`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @i-harness/web-host test`
Expected: PASS (the smoke above + ported unary cases).

- [ ] **Step 5: Commit**

```bash
git add packages/web-host/src/host.ts packages/web-host/test/host.test.ts
git commit -m "feat(web-host): HTTP unary session surface (list/create/fork/resume/events) (R-C1/C2)"
```

---

### Task 12: host core part B — mux opener over the executor + live stream bundles

**Files:**
- Modify: `packages/web-host/src/host.ts`, `packages/web-host/test/host.test.ts`
- Reference: branch `host.ts` 471–730 (bundle refcounting + mux opener) and branch `web.ts` attach wiring (the calls to `attachLiveSession` — now via `executor.onAssembly`)

**Interfaces:**
- Consumes: `WebSocketMuxServer`/`StreamOpener` (Task 7), `LiveSessionStreams` (Task 8), `SessionExecutor.submit` (Task 2), `ApprovalMuxBridge.open`/`QuestionMuxBridge.open` (Task 9).
- Produces: mux endpoint behavior — `open` frames per endpoint; `attachLiveSession(options)`; the refcounted `liveStreams` bundle cache (pruned at 0).

- [ ] **Step 1: Write the failing test case** (append to `host.test.ts`):

```ts
it("mux: command stream runs one turn and ends; live session stream sees appends", async () => {
  const coordinator = createSessionCoordinator(createJsonlBackend(tempStore()))
  const executor = createSessionExecutor({ workspace: process.cwd(), approveAll: true, mockScript: [{ role: "assistant", text: "hi" }] })
  const host = createWebHost({ port: 0, executor, coordinator })
  const { port } = await host.listen()
  stop = async () => { await host.close(); await coordinator.close() }
  const post = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
  const { id } = await post.json() as { id: string }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mux`)
  const frames: string[] = []
  await new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data))
      frames.push(msg.type)
      if (msg.type === "ready") ws.send(JSON.stringify({ type: "open", streamId: "cmd", endpoint: "command", payload: { sessionId: id, prompt: "hi" } }))
      if (msg.type === "end") resolve()
    }
  })
  expect(frames).toContain("item")
  ws.close()
})
```

(Note: the global `WebSocket` client is available in Node ≥22 — also serves the C3 auth tests.)

- [ ] **Step 2: Run to verify failure** (no mux wiring yet).

- [ ] **Step 3: Implement the opener** — port the branch's bundle code (refcounted `liveStreams`, `tracked`, `LiveEntry`, the opener's session resolution with the live-instance preference) with these replacements:

- The live-instance preference chain becomes: `liveSessions.get(sessionId) ?? executor.liveSession(sessionId) ?? (await coordinator.load(sessionId)).session ?? createSession()` — the executor now owns the live instance, so the host registers it via a two-step: `executor.onAssembly((a) => { if (a.sessionId !== undefined) hostRef.attachLiveSession({ sessionId: a.sessionId, session: a.session }) })` — the CLI calls this, **or** the host must reattach into the bundle cache on assembly — implement `attachLiveSession` (branch 2309–2320 verbatim: set + `reattach` the cached bundle).
- `command` endpoint → the executor: delete `commandStream`'s serial-chain bulk; the new opener body:

```ts
if (endpoint === "command") {
  const request = payload as Partial<CommandRequestWire>
  if (typeof request.prompt !== "string") throw new Error("prompt required")
  return commandStream(sessionId, request.prompt, signal)
}

/** Frame mapper over the executor (engine-owned: serialization is the executor's
 * job; the host only shapes status frames and races the client signal). It
 * lives inside `createWebHost` so `executor`/`signal` close over it. */
function commandStream(sessionId: string, prompt: string, signal: AbortSignal): AsyncGenerator<CommandEventWire> {
  return (async function* () {
    yield { status: "started" }
    const outcome = await Promise.race([
      executor.submit(sessionId, prompt, signal)
        .then(() => ({ status: "ok" }) as const)
        .catch((error: unknown) => ({ status: "error", error: String(error) }) as const),
      new Promise<undefined>((resolve) => {
        if (signal.aborted) resolve(undefined)
        else signal.addEventListener("abort", () => resolve(undefined), { once: true })
      }),
    ])
    if (outcome === undefined) return // torn down — never send ok/error to a gone client
    yield outcome
  })()
}
```

- `approval`/`question` endpoint openers: port verbatim (global channel, no sessionId payload; `approvalBridge === undefined` → throw `"approval endpoint not configured"`).
- The opener's `onApproval`/`onAnswer` handlers: verbatim (`approvalBridge?.respond(value)`).
- `server.on("upgrade", ...)` → `/api/mux` (Task 14 adds the auth gate there).
- Drop `commandQueueStats` (jobs deferred) and `CommandQueueView` (jobs.ts dropped).

- [ ] **Step 4: Verify**

Run: `pnpm --filter @i-harness/web-host test`
Expected: PASS (mux case + all previous).

- [ ] **Step 5: Commit**

```bash
git add packages/web-host/src/host.ts packages/web-host/test/host.test.ts
git commit -m "feat(web-host): mux opener over SessionExecutor + refcounted live bundles (R-C1)"
```

---

### Task 13: host core part C — commands RPC routes

**Files:**
- Modify: `packages/web-host/src/host.ts`, `packages/web-host/test/host.test.ts`

**Interfaces:**
- Consumes: `CommandBridge` (Task 6), `CommandExecuteRequestWire` (Task 6), coordinator (session existence check).
- Produces: `GET /api/commands` → `{ commands: CommandDescriptor[] }`; `POST /api/commands/execute` body `{ sessionId, line }` → `{ result: string }` with `command-invalid` 400 / `command-failed` 400 / 404 unknown session. **Host-owned** `command/run` + `command/done` event appends: the host appends them through the executor's live session or the coordinator (branch `appendCommandEvent` shape — port verbatim; the live-path `liveAgents.get` becomes `executor.liveSession(sessionId)` with a `handle.session`-equivalent via the assembly — the executor exposes `assemblyFor`; use `executor.assemblyFor(sessionId).then(a => append(a.session, ev))` contained best-effort).

- [ ] **Step 1: Port the routes** (branch host.ts 851–898) with these deltas: the body reads `{ sessionId, line }` (branch verbatim); the `coordinator.load(request.sessionId)` existence check stays; error mapping stays (`command-invalid`/`command-failed`/404); the abort-on-close stays. The `commandBridge.run` continuation stays.

- [ ] **Step 2: Append the command-events test** to `host.test.ts`:

```ts
it("commands: list and execute through the seam", async () => {
  const coordinator = createSessionCoordinator(createJsonlBackend(tempStore()))
  const executor = createSessionExecutor({ workspace: process.cwd(), approveAll: true })
  const commandBridge = {
    list: () => [{ name: "ping", description: "pong" }],
    run: async (_: string, line: string) => `ran:${line}`,
  }
  const host = createWebHost({ port: 0, executor, coordinator, commandBridge })
  const { port } = await host.listen()
  stop = async () => { await host.close(); await coordinator.close() }
  const sessions = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
  const { id } = await sessions.json() as { id: string }
  const list = await fetch(`http://127.0.0.1:${port}/api/commands`)
  expect(await list.json()).toEqual({ commands: [{ name: "ping", description: "pong" }] })
  const exec = await fetch(`http://127.0.0.1:${port}/api/commands/execute`, { method: "POST", body: JSON.stringify({ sessionId: id, line: "ping hi" }), headers: { "content-type": "application/json" } })
  expect(exec.status).toBe(200)
  expect(await exec.json()).toEqual({ result: "ran:ping hi" })
})
```

- [ ] **Step 3: Verify** — `pnpm --filter @i-harness/web-host test` PASS, then typecheck.

- [ ] **Step 4: Commit**

```bash
git add packages/web-host/src/host.ts packages/web-host/test/host.test.ts
git commit -m "feat(web-host): commands RPC routes over the CommandBridge seam (R-C1)"
```

---

### Task 14: auth — HMAC cookie + launch token + DNS-rebind fence (R-C3)

**Files:**
- Create: `packages/web-host/src/auth.ts`, `packages/web-host/test/auth.test.ts`, `packages/web-host/src/auth.test-signatures.md`? — **no** (no docs files; tests only)
- Modify: `packages/web-host/src/host.ts` (guard wiring), `packages/web-host/test/host.test.ts`

**Interfaces:**
- Consumes: `node:crypto` (`createHmac`, `randomBytes`, `timingSafeEqual`), `IncomingMessage`.
- Produces: Produced Contract §3 (`AuthOptions`, `AuthContext`, `createAuth`). Host behavior: `WebHostOptions.auth?: AuthContext` — absent → no auth (dev/test); present → every HTTP route answers 401 `{ error: "unauthorized" }` without cookie/token, every mux upgrade is rejected before upgrade (socket destroyed + 401 response), DNS-rebind fence runs FIRST (403 `{ error: "forbidden host" }`), CORS headers on allowed origins, `OPTIONS *` preflight answered 204.

- [ ] **Step 1: Write the failing tests**

`packages/web-host/test/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createAuth } from "../src/auth.ts"

const auth = createAuth({ hmacSecret: "a".repeat(64), launchToken: "launch-xyz" })

describe("createAuth", () => {
  it("signs and verifies a session token; expiry fails closed", () => {
    const token = auth.signSession()
    expect(auth.verifySession(token)).toBe(true)
    const expired = auth.signSession({ exp: Math.floor(Date.now() / 1000) - 10 })
    expect(auth.verifySession(expired)).toBe(false)
    expect(auth.verifySession(token + "0")).toBe(false)
  })
  it("launch token verification is constant-time safe", () => {
    expect(auth.tokenValid("launch-xyz")).toBe(true)
    expect(auth.tokenValid("launch-xy")).toBe(false)
    expect(auth.tokenValid("")).toBe(false)
  })
  it("fences only loopback hosts and origins", () => {
    expect(auth.hostAllowed("localhost:4310")).toBe(true)
    expect(auth.hostAllowed("127.0.0.1:4310")).toBe(true)
    expect(auth.hostAllowed("evil.com")).toBe(false)
    expect(auth.originAllowed("http://localhost:4310")).toBe(true)
    expect(auth.originAllowed("http://127.0.0.1:9955")).toBe(true)
    expect(auth.originAllowed("https://evil.com")).toBe(false)
    expect(auth.originAllowed(undefined)).toBe(true) // non-browser (curl) — host fence applies
  })
})
```

`host.test.ts` append:

```ts
it("auth: unauthenticated requests answer 401; bad hosts answer 403", async () => {
  const coordinator = createSessionCoordinator(createJsonlBackend(tempStore()))
  const executor = createSessionExecutor({ workspace: process.cwd(), approveAll: true })
  const auth = createAuth({ hmacSecret: "b".repeat(64), launchToken: "t" })
  const host = createWebHost({ port: 0, executor, coordinator, auth })
  const { port } = await host.listen()
  stop = async () => { await host.close(); await coordinator.close() }
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`)
  expect(res.status).toBe(401)
  const token = auth.signSession()
  const ok = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { cookie: `i-harness=${token}` } })
  expect(ok.status).toBe(200)
  // fence checked even before auth:
  const evil = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { host: "evil.com", cookie: `i-harness=${token}` } })
  expect(evil.status).toBe(403)
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `auth.ts`**

```ts
// packages/web-host/src/auth.ts — R-C3 (dsh browser-auth + api-request-trust shape):
// 1) launch token via query param (?token=) — bootstrap + WS/curl clients
// 2) HMAC-signed session cookie set by GET /api/auth/login
// 3) DNS-rebind fence: Host/Origin must be loopback; CORS allow-list = loopback origins
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export interface AuthOptions {
  hmacSecret: string              // ≥32 bytes (hex) — NEVER defaulted; a short secret is rejected
  launchToken: string             // the bootstrap secret (query ?token=)
  cookieName?: string             // default "i-harness"
  maxAgeMs?: number               // session-cookie TTL; default 7 days
}

export interface AuthContext {
  tokenValid(token: string | undefined): boolean
  signSession(extra?: Record<string, unknown>): string
  verifySession(token: string | undefined): boolean
  hostAllowed(hostHeader: string | undefined): boolean
  originAllowed(originHeader: string | undefined): boolean
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

function hmac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest()
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function createAuth(opts: AuthOptions): AuthContext {
  const cookieName = opts.cookieName ?? "i-harness"
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600 * 1000
  if (opts.hmacSecret.length < 32) throw new Error("auth: hmacSecret must be at least 32 chars (64 hex chars of entropy)")
  const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url")
  const decode = (value: string): string => Buffer.from(value, "base64url").toString("utf8")

  function signSession(extra: Record<string, unknown> = {}): string {
    const payload = encode(JSON.stringify({
      s: randomBytes(16).toString("base64url"),
      exp: Math.floor(Date.now() / 1000) + Math.floor(maxAgeMs / 1000),
      ...extra,
    }))
    return `${payload}.${hmac(opts.hmacSecret, payload).toString("base64url")}`
  }

  function verifySession(token: string | undefined): boolean {
    if (token === undefined || token === "") return false
    const i = token.indexOf(".")
    if (i === -1) return false
    const payload = token.slice(0, i)
    const signature = token.slice(i + 1)
    const expected = hmac(opts.hmacSecret, payload).toString("base64url")
    if (!constantTimeEq(signature, expected)) return false
    try {
      const data = JSON.parse(decode(payload)) as { exp?: number }
      return typeof data.exp === "number" && data.exp > Math.floor(Date.now() / 1000)
    } catch {
      return false
    }
  }

  function hostAllowed(hostHeader: string | undefined): boolean {
    if (hostHeader === undefined || hostHeader === "") return false // no Host header: not a browser/HTTP client we serve
    try {
      const hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "")
      return LOOPBACK_HOSTS.has(hostname.toLowerCase())
    } catch {
      return false
    }
  }

  function originAllowed(originHeader: string | undefined): boolean {
    if (originHeader === undefined || originHeader === "") return true // no Origin = non-browser request
    try {
      const url = new URL(originHeader)
      if (url.protocol !== "http:" && url.protocol !== "https:") return false
      const hostname = url.hostname.replace(/^\[|\]$/g, "")
      return LOOPBACK_HOSTS.has(hostname.toLowerCase())
    } catch {
      return false
    }
  }

  return {
    cookieName: () => cookieName,
    launchToken: () => opts.launchToken,
    tokenValid: (token) => token !== undefined && constantTimeEq(token, opts.launchToken),
    signSession,
    verifySession,
    hostAllowed,
    originAllowed,
  }
}
```

- [ ] **Step 4: Wire the host guard.** In `host.ts` `createWebHost`, before the `server = createServer(...)` call, add these helpers (private — `auth: AuthContext | undefined` from `WebHostOptions`); call `guardAndAuth()` as the **first statement of `route()`** (every route, before any dispatch), and the new upgrade handler replaces the plain one:

```ts
function parseCookieHeader(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === undefined) return out
  for (const part of raw.split(";")) {
    const i = part.indexOf("=")
    if (i === -1) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

function guardAndAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (auth === undefined) return true
  const url = new URL(req.url ?? "/", "http://localhost")
  // DNS-rebind fence FIRST — a bad Host/Origin fails before any auth check:
  if (!auth.hostAllowed(req.headers.host)) {
    res.writeHead(403, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "forbidden host" }))
    return false
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined
  if (!auth.originAllowed(origin)) {
    res.writeHead(403, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "forbidden origin" }))
    return false
  }
  if (req.method === "OPTIONS") {
    // CORS allow-list = loopback origins (already fence-verified above):
    const headers: Record<string, string> = {
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
      vary: "Origin",
    }
    if (origin !== undefined) headers["access-control-allow-origin"] = origin
    res.writeHead(204, headers)
    res.end()
    return false
  }
  const cookie = parseCookieHeader(req.headers.cookie)
  if (auth.verifySession(cookie[auth.cookieName()])) return true
  const token = url.searchParams.get("token")
  if (token !== null && auth.tokenValid(token)) return true
  res.writeHead(401, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: "unauthorized" }))
  return false
}

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/api/mux") { socket.destroy(); return }
  // fence + auth BEFORE upgrade; query token allowed (WS clients/curl):
  if (auth !== undefined) {
    if (!auth.hostAllowed(req.headers.host)) { socket.destroy(); return }
    const url = new URL(req.url, "http://localhost")
    const cookie = parseCookieHeader(req.headers.cookie)
    const token = url.searchParams.get("token")
    if (!auth.verifySession(cookie[auth.cookieName()]) && !auth.tokenValid(token ?? undefined)) {
      socket.destroy()
      return
    }
  }
  mux.handleUpgrade(req, socket as Duplex, head)
})
```

The `GET /api/auth/login` route runs through `guardAndAuth`; set the cookie as in Step 5. Subsequent requests carry only the cookie (SameSite=Strict, HttpOnly — the token never needs to be forwarded again).

- [ ] **Step 5: Implement the login route** — `GET /api/auth/login?token=<launch>`:

```ts
if (req.method === "GET" && url.pathname === "/api/auth/login") {
  if (auth === undefined) { res.writeHead(404); res.end(); return }
  const token = url.searchParams.get("token")
  if (token === null || !auth.tokenValid(token)) {
    res.writeHead(401, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "invalid launch token" }))
    return
  }
  const session = auth.signSession()
  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": `${auth.cookieName()}=${session}; HttpOnly; SameSite=Strict; Path=/`,
  })
  res.end(JSON.stringify({ ok: true }))
  return
}
```

Note: `SameSite=Strict` + loopback-only fence is the dsh-shaped browser-auth for a local service; the token stays valid for the cookie's TTL (a fresh login re-requests the launch token — the CLI prints it; see Task 18).

- [ ] **Step 6: Verify** — `pnpm --filter @i-harness/web-host test` PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web-host/src/auth.ts packages/web-host/src/host.ts packages/web-host/test/auth.test.ts packages/web-host/test/host.test.ts
git commit -m "feat(web-host): auth — HMAC cookie, launch token, DNS-rebind fence, CORS (R-C3)"
```

---

### Task 15: events route `afterSeq` replay wiring (C2 — completes Task 10/11)

**Files:**
- Modify: `packages/web-host/src/host.ts`, `packages/web-host/test/host.test.ts`

**Interfaces:**
- Consumes: `paginateEvents` with `afterSeq` (Task 10).
- Produces: `GET /api/sessions/:id/events?afterSeq=<n>[&limit=N]` → `SessionPage`; `beforeSeq`+`afterSeq` together → 400 `events-cursor-invalid`.

- [ ] **Step 1: Test** (append):

```ts
it("events: afterSeq replays forward, bounded; both cursors rejected", async () => {
  const coordinator = createSessionCoordinator(createJsonlBackend(tempStore()))
  const executor = createSessionExecutor({ workspace: process.cwd(), approveAll: true })
  const host = createWebHost({ port: 0, executor, coordinator })
  const { port } = await host.listen()
  stop = async () => { await host.close(); await coordinator.close() }
  const { id } = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).json() as { id: string }
  await coordinator.append(id, [
    { type: "user/message", text: "a" }, { type: "assistant/message", text: "b" },
  ])
  const page = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/events?afterSeq=0&limit=1`)).json()
  expect(page.events.map((e: { seq?: number }) => e.seq)).toEqual([1])
  expect(page.nextAfterSeq).toBe(1)
  const both = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/events?beforeSeq=5&afterSeq=0`)
  expect(both.status).toBe(400)
})
```

- [ ] **Step 2: Implement** — in the events route (it currently parses `limitParam`/`beforeParam`): add the `afterParam` branches per Task 11's marker, with the exclusivity check before `paginateEvents`.

- [ ] **Step 3: Verify** — test + typecheck PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web-host/src/host.ts packages/web-host/test/host.test.ts
git commit -m "feat(web-host): events route afterSeq forward replay (R-C2)"
```

---

### Task 16: web-host models folds + provisional protocol module (R-C5 part 1)

**Files:**
- Create: `packages/web-host/src/modelProtocol.ts`, `packages/web-host/src/models.ts`, `packages/web-host/test/models.test.ts`
- Reference: branch `models.ts` (306 lines — port; import swap only), branch `settings` protocol constants

**Interfaces:**
- Consumes: `DirectoryEntry`, `ModelDescriptor` (@i-harness/provider — post-C5 surface; the folds use only field names), `SectionViewLike` (Task 6).
- Produces: the fold surface (Produced Contracts) — `mergeDirectoryRows`, `sectionUserProviders`, `mergeCatalogModels`, `catalogDefaultOf`, `buildModelsCatalog`, `ModelsCatalogView` etc. — pure functions, zero transport.

- [ ] **Step 1: `modelProtocol.ts`** (provisional — E flag):

```ts
// PROVISIONAL (R-C5 port, E-region flag): the three-value wire protocol
// vocabulary + resolution chain that @i-harness/settings owns. E-region lands →
// delete this module, import PROVIDER_PROTOCOLS/resolveProviderProtocol/
// DEFAULT_PROVIDER_PROTOCOL/SEEDED_PROTOCOLS from @i-harness/settings, change
// models.ts imports (one line each). Verify at execution against the E-plan.
export type SettingsProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages"
export const PROVIDER_PROTOCOLS: readonly SettingsProviderProtocol[] = [
  "openai-completions", "openai-responses", "anthropic-messages",
]
export const DEFAULT_PROVIDER_PROTOCOL: SettingsProviderProtocol = "openai-completions"
export const SEEDED_PROTOCOLS: Record<string, SettingsProviderProtocol> = {} // amendment: no seeded profiles
export interface SettingsProviderConfig {
  protocol?: string
  displayName?: string
  baseURL?: string
  apiKeyEnv?: string
  models?: unknown
}
/** Resolution chain (settings' rule, ported): user section value > seeded > DEFAULT. */
export function resolveProviderProtocol(
  route: string,
  user?: SettingsProviderConfig | undefined,
): SettingsProviderProtocol {
  if (user?.protocol !== undefined
    && (PROVIDER_PROTOCOLS as readonly string[]).includes(user.protocol)) {
    return user.protocol as SettingsProviderProtocol
  }
  return SEEDED_PROTOCOLS[route] ?? DEFAULT_PROVIDER_PROTOCOL
}
```

- [ ] **Step 2: Port `models.ts`** — copy the branch file; its only external imports are the settings ones — replace with `./modelProtocol.ts` (same names). Everything else verbatim (folds, `UNKNOWN_PROTOCOL_REASON`, `catalogDefaultOf`).

- [ ] **Step 3: Port the tests** — branch `tests/models.spec.ts` → `test/models.test.ts` (directory merge declared⊕user, model id dedupe declared-wins, protocol resolution per row, failure rows, default fallback).

- [ ] **Step 4: Verify** — `pnpm --filter @i-harness/web-host test` PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-host/src/modelProtocol.ts packages/web-host/src/models.ts packages/web-host/test/models.test.ts
git commit -m "feat(web-host): model catalog folds + provisional wire-protocol module (R-C5)"
```

---

### Task 17: provider portfolio patch — directory/probe surface (R-C5)

**Files:**
- Modify: `packages/provider/src/index.ts` (117 → 593 lines), Create: `packages/provider/test/directory.test.ts` (port), `packages/provider/test/provider.test.ts` (port — the branch has both)
- Reference: branch `provider/src/index.ts` + branch `provider/test/*.ts` — port verbatim

**Interfaces:**
- Consumes: `llm-seam` (`createRetryingClient`, `resolveRetryPolicy`, `RetryPolicyConfig`), the three llm client packages (already deps).
- Produces (verbatim branch surface): `ModelDescriptor`/`DirectoryEntry`/`ProbeRequest`/`Probe`/`ProviderRegistry.describeDirectory()/registerProbe()/probeModels()`; `ProbeUnavailableError` (`code: "probe-unavailable"`), `ModelProbeFailedError` (`code: "model-probe-failed"`); `probeCandidatePaths`, `buildWireClient` + `WireClientConfig` and the module-level conveniences (`defaultProviderRegistry`, `describeDirectory`, `registerProbe`, `probeModels`). Everything is already in the branch build (its `packages/web-host` imports `DirectoryEntry`/`ModelDescriptor`/errors from it — no shape drift).

- [ ] **Step 1: Port the patch** — copy the branch `packages/provider/src/index.ts` over the main one (the file already contains the whole main surface as its prefix; the diff is the 476-line directory/probe addition). Verify: `git diff` shows only the intended additions.

- [ ] **Step 2: Port the tests** — copy branch `provider/test/directory.test.ts` + `provider/test/provider.test.ts` → `packages/provider/test/`. Run.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @i-harness/provider test && pnpm --filter @i-harness/provider typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/provider/src/index.ts packages/provider/test
git commit -m "feat(provider): describeDirectory/probeModels surface from the abandoned branch (R-C5)"
```

---

### Task 18: session-persistence patch — `SessionMeta` extensions, `profile()`, `updateMeta()` (R-C5 port)

**Files:**
- Modify: `packages/session-persistence/src/index.ts`, `packages/session-persistence-jsonl/src/index.ts`, `packages/session-persistence-sqlite/src/index.ts` (+ `schema.ts`)
- Reference: branch's `session-persistence{,writes}` index + both backends (jsonl ~62 added lines, sqlite ~57 + schema)

**Interfaces:**
- Consumes: existing `SessionMeta`/`PersistenceBackend`/`SessionCoordinator` (m26 — verified above).
- Produces (patched contract): `SessionModelSelection { provider: string; model: string; reasoningEffort?: string }`; `SessionMeta` + `{ title?: string; workspaceId?: string; modelSelection?: SessionModelSelection }`; `PersistenceBackend` + `profile(sessionId)` and `updateMeta(sessionId, patch)`; `SessionCoordinator` + `profile` (pass-through) and `updateMeta` (same M23 lease discipline as the other mutating paths).

- [ ] **Step 1: Port the JSONL backend bits** — branch: `profile` (header-only read: 64 KiB window, line 0 parse), `updateMeta` (header rewrite: read → merge → `out[0] = serializeHeader(merged)` → temp `<uuid>.tmp` write → `rename`; events lines byte-exact). `serializeHeader`/`parseHeader` already handle `modelSelection`/`title` as passthrough data (do NOT add them to the known-key list — verify the branch's `parseHeader` keeps unknown fields; the jsonl metadata stream is opaque).

- [ ] **Step 2: Port the sqlite backend bits** — `profile` (SELECT title/created_at… + blank via turn/start count), `updateMeta` (UPDATE sessions SET title = ? … with **fail-closed unknown-key refusal**: `if (!("title" in patch)) throw new Error(...)` — the branch refuses unknown meta keys loudly so a sqlite session never silently loses a model selection); schema: add the `title` column (`ALTER`-proof in `CREATE TABLE IF NOT EXISTS`). Also `SessionCoordinator.updateMeta`'s ownership-lease discipline (updateMeta is mutating: `ensureOwnership` first — branch does).

- [ ] **Step 3: Port the coordinator edits** — `profile`/`updateMeta` forwarders verbatim (branch index.ts lines 104–145, 463–478 shapes).

- [ ] **Step 4: Tests** — new `packages/session-persistence-jsonl/test/meta.test.ts` (or extend the existing test dir; same temp-store helper style as the web-host tests):

```ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../src/index.ts"

describe("updateMeta/profile", () => {
  it("rewrites the header atomically and reads it header-only", async () => {
    const coordinator = createSessionCoordinator(createJsonlBackend(mkdtempSync(join(tmpdir(), "ih-meta-"))))
    const { id } = await coordinator.create()
    await coordinator.append(id, [{ type: "user/message", text: "hi" }])
    const meta = await coordinator.updateMeta(id, { title: "T" })
    expect(meta.title).toBe("T")
    const profile = await coordinator.profile(id)
    expect(profile.meta.title).toBe("T")
    expect(profile.blank).toBe(false)
    const meta2 = await coordinator.updateMeta(id, { modelSelection: { provider: "p", model: "m" } })
    expect(meta2.modelSelection).toEqual({ provider: "p", model: "m" })
    await coordinator.close()
  })
})
```

- [ ] **Step 5: Verify** — run the jsonl/persistence suites (`pnpm --filter @i-harness/session-persistence-jsonl test`, `--filter @i-harness/session-persistence-sqlite test`, `--filter @i-harness/session-persistence test`) + typechecks.

- [ ] **Step 6: Commit**

```bash
git add packages/session-persistence packages/session-persistence-jsonl packages/session-persistence-sqlite
git commit -m "feat(session-persistence): per-session meta (title/model selection) + profile/updateMeta (R-C5)"
```

---

### Task 19: host model routes — directories, probe, catalog, per-session model, title PUT (R-C5)

**Files:**
- Modify: `packages/web-host/src/host.ts`, `packages/web-host/test/host.test.ts`
- Reference: branch host.ts 1966–2256 (models routes), 1155–1189 (title PUT), `parseSessionModelSelection` (135–153), `forwardModelsError` (194–223 — replaced by `modelSources.forwardError`), list-row enrichment (1082)

**Interfaces:**
- Consumes: `ModelSources` (Task 6), folds (Task 16), provider registry (Task 17), patched coordinator (Task 18).
- Produces: `GET /api/settings` + `PUT /api/settings` (over `modelSources.settingsStore` — duck: nonexistent → 404), `GET /api/settings/sections?name=llm|onboarding|core`, `POST /api/settings/mutate`, `GET/POST/DELETE /api/credentials`, `GET /api/llm/directory`, `POST /api/llm/probe`, `GET /api/models/catalog`, `POST /api/sessions/:id/model` → `{ modelSelection }`, `PUT /api/sessions/:id` (title), list-row `title`/`modelSelection`/`blank` via `coordinator.profile`.

- [ ] **Step 1: Tests first** (one smoke; the folder folds already covered): `host.test.ts` append — create session → `PUT /api/sessions/:id` title → 200 `{ title }`; `POST /api/sessions/:id/model` → `{ modelSelection }`; `GET /api/sessions` row carries `title`/`modelSelection`; `GET /api/llm/directory` with a `providerRegistry` seam → 200; without the seam → 404.

- [ ] **Step 2: Implement** — port branch host.ts routes in order (settings sections/mutate → credentials → directory → probe → catalog → session model → title PUT → list enrichment). Deltas vs branch:
  1. Every error mapping goes through `modelSources.forwardError?.(error)` — `{ status, code?, body }` → `res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body))`; `undefined` → rethrow to the generic 500. (The branch's `forwardModelsError` becomes the E-region's contract — see Consumed Contract §2.)
  2. `describeSection("llm", settingsStore)` calls → `await modelSources.describeSection?.("llm")` (absent → the route answers 404 like any other missing piece). `settingsStore.get().llm.defaultModel` → read `(await modelSources.describeSection("llm")).value` via `sectionUserProviders`/`catalogDefaultOf` — the folds already accept the `SectionViewLike`; keep the shapes identical.
  3. The probe route's protocol chain (user section > draft > default) stays — but sourced from `modelSources.describeSection("llm").value.providers` — resolve inside the host exactly per branch 2138–2169 with the `modelProtocol` helpers.
  4. `parseSessionModelSelection` verbatim; `updateMeta` unknown-session → 404 (existing mapping).
  5. The list route (Task 11's marker): swap the row builder's `profile` list — `const profiles = await Promise.allSettled(ids.map(id => coordinator.profile(id)))` with the branch's settle/warn per row (per-row failure never hides the row), plus `title`/`modelSelection`/`blank` per branch 1082; drop the `console.warn` wording? keep (M-style loud logging).

- [ ] **Step 3: Verify** — tests + `pnpm --filter @i-harness/web-host typecheck` (the `@i-harness/provider` types are now present). Full: `pnpm -r typecheck && pnpm -r test` (still green).

- [ ] **Step 4: Commit**

```bash
git add packages/web-host/src/host.ts packages/web-host/test/host.test.ts
git commit -m "feat(web-host): model directory/probe/catalog + per-session model + title routes (R-C5)"
```

---

### Task 20: CLI web composition — thin `web.ts` + `web` subcommand (R-C1 integration)

**Files:**
- Create: `apps/cli/src/web.ts`, Modify: `apps/cli/src/index.ts`, Modify: `apps/cli/package.json` (add `@i-harness/web-host`, `@i-harness/session-executor` deps), Create: `apps/cli/test/web.test.ts`
- Reference: branch `web.ts` (the ~200 lines this file replaces: `resolveModelSpec`, `buildAdapterForRoute`, `effectiveProviderProfile`, `registerDefaultCommands`, `parsePort`) — port the *pure* ones; the agent-creation glue is gone.

**Interfaces:**
- Consumes: `createSessionExecutor` (Task 2), `createWebHost` (T11–14), `ApprovalMuxBridge`/`QuestionMuxBridge` (T9), `createAuth` (T14), `createSessionCoordinator` + jsonl/sqlite backends, `SettingsStore`-duck + `createCredentialStore`-duck — WAIT: main m26 has **no** settings/credentials packages — the CLI's web composition in M26 composes **without** the model-settings seam (the `modelSources` route family answers 404 like every other absent seam); the pieces below are written to be seam-absent-safe and their E-flip is flagged.
- Produces: `parsePort`, `WebServerOptions`, `createWebServer(opts): Promise<WebServer>`, `runWebServer(opts)`, `web` subcommand.

- [ ] **Step 1: `apps/cli/src/web.ts`** (this is the complete m26-compilable file — the branch's web.ts is the source for the pure model-chain pieces only, which are E-gated here):

```ts
// Thin web composition (R-C0 engine-owned): the runHeadless assembly lives in
// @i-harness/session-executor; web-host is transport-only. This file wires the
// two, composes the seams the host serves (approvals, questions, auth), and
// owns the process lifecycle. The branch's 1,598-line glue (web.ts +
// live-agent.ts) is NOT recreated — one assembly, one executor.
//
// E-region flags (verify against the E-plan at execution):
//   * settings/credentials/plugin-registry land with E → compose modelSources
//     here + port the branch web.ts pure model chain (resolveModelSpec /
//     buildAdapterForRoute / effectiveProviderProfile — ~230 lines) into a
//     model.ts module; the host's model routes activate automatically.
//   * the command seam: registerDefaultCommands (theme/sandbox/model) via
//     @i-harness/interaction registers into the SERVER ctx; it needs the
//     settings store for its writes — compose it with E. On m26 the command
//     routes answer via the host's 404 seam only (commandBridge absent = 404).
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createSessionCoordinator, type SessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSqliteBackend, closeSqliteBackends } from "@i-harness/session-persistence-sqlite"
import type { ModelClient } from "@i-harness/llm-seam"
import type { MockStep } from "@i-harness/llm-mock"
import { createSessionExecutor, type SessionExecutor } from "@i-harness/session-executor"
import { createWebHost, ApprovalMuxBridge, QuestionMuxBridge, createAuth
  , type WebHost } from "@i-harness/web-host"

export const DEFAULT_WEB_PORT = 4310

export function parsePort(raw: string | undefined, fallback = DEFAULT_WEB_PORT): number {
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

export interface WebServerOptions {
  port: number
  workspace: string
  sessionBackend?: "jsonl" | "sqlite"
  model?: ModelClient
  mockScript?: MockStep[]
  /** Auth: enable by passing BOTH; per-start random when only one is given. */
  launchToken?: string
  hmacSecret?: string
  /** E-region: brand the login URL with the launch token. */
  printLoginUrl?: boolean
}

export interface WebServer {
  host: WebHost
  port: number
  executor: SessionExecutor
  close(): Promise<void>
}

export async function createWebServer(opts: WebServerOptions): Promise<WebServer> {
  const port = Number.isFinite(opts.port) && opts.port >= 0 ? Math.floor(opts.port) : DEFAULT_WEB_PORT
  const coordinator: SessionCoordinator =
    (opts.sessionBackend ?? "jsonl") === "sqlite"
      ? createSessionCoordinator(createSqliteBackend(join(opts.workspace, "sessions.db")), { lock: { enabled: true } })
      : createSessionCoordinator(createJsonlBackend(opts.workspace), { lock: { enabled: true } })
  const hostCtx = createContext()
  const approvals = new ApprovalMuxBridge(hostCtx)
  approvals.attach()
  const questions = new QuestionMuxBridge(hostCtx)
  questions.attach()
  const executor = createSessionExecutor({
    workspace: opts.workspace,
    coordinator,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.mockScript !== undefined ? { mockScript: opts.mockScript } : {}),
    // When E lands, wire loadMeta -> coordinator.profile(id).meta and
    // modelBuilder -> the branch's resolveModelSpec chain (session tier >
    // default tier > legacy > mock). On m26 the executor's mock default holds.
    loadMeta: async (id) => (await coordinator.profile(id)).meta,
  })
  const wired = new Set<string>()
  executor.onAssembly((assembly) => {
    if (assembly.sessionId === undefined || wired.has(assembly.sessionId)) return
    wired.add(assembly.sessionId)
    approvals.attach(assembly.ctx) // asks from any session flow into the shared mux streams
    questions.attach(assembly.ctx)
  })
  const auth =
    opts.hmacSecret !== undefined || opts.launchToken !== undefined
      ? createAuth({
          hmacSecret: opts.hmacSecret ?? randomBytes(32).toString("hex"),
          launchToken: opts.launchToken ?? randomBytes(24).toString("base64url"),
        })
      : undefined
  const host = createWebHost({
    port,
    executor,
    coordinator,
    approvalBridge: approvals,
    questionBridge: questions,
    ...(auth !== undefined ? { auth } : {}),
  })
  const { port: listeningPort } = await host.listen()
  if (auth !== undefined && opts.printLoginUrl) {
    console.log(`I-harness web login: http://127.0.0.1:${listeningPort}/api/auth/login?token=${auth.launchToken()}`)
  }
  return {
    host,
    port: listeningPort,
    executor,
    close: async () => {
      await host.close()
      await executor.close()
      if (opts.sessionBackend === "sqlite") closeSqliteBackends()
    },
  }
}

export async function runWebServer(opts: { port: number; workspace: string; sessionBackend?: "jsonl" | "sqlite" }): Promise<{ port: number }> {
  const server = await createWebServer(opts)
  console.log(`I-harness web: http://127.0.0.1:${server.port}`)
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })
  await server.close()
  return { port: server.port }
}
```

Note: `executor`'s `loadMeta` uses `coordinator.profile(id).meta` — the Task 18 patched surface; if Task 18 hasn't landed yet, `loadMeta` returns `undefined` and the single `// Task 18` marker governs (execute Task 18 before this one — it does anyway in the numbered order).

- [ ] **Step 2: `apps/cli/src/index.ts`** — add the `web` subcommand (port the branch's command branch: `web` + `--session-backend jsonl|sqlite` flag; `process.env.PORT` via `parsePort`; cwd as workspace).

- [ ] **Step 3: Tests** — `apps/cli/test/web.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { parsePort, createWebServer } from "../src/web.ts"
describe("parsePort", () => {
  it("falls back on junk and floors valid values", () => {
    expect(parsePort(undefined)).toBe(4310)
    expect(parsePort("abc")).toBe(4310)
    expect(parsePort("3080.9")).toBe(3080)
    expect(parsePort("0")).toBe(0)
  })
})
describe("web composition", () => {
  it("serves session create/list over the thin composition", async () => {
    const server = await createWebServer({ port: 0, workspace: process.cwd() })
    try {
      const post = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
      expect(post.status).toBe(200)
      const list = await fetch(`http://127.0.0.1:${server.port}/api/sessions`)
      expect(((await list.json()) as { sessions: unknown[] }).sessions.length).toBe(1)
    } finally {
      await server.close()
    }
  })
})
```

- [ ] **Step 4: Verify**

Run: `pnpm install && pnpm --filter @i-harness/cli test && pnpm --filter @i-harness/cli typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/web.ts apps/cli/src/index.ts apps/cli/package.json apps/cli/test/web.test.ts
git commit -m "feat(cli): thin web composition over SessionExecutor + web-host (R-C1)"
```

---

### Task 21: full verification + C-batch wrap-up

**Files:** (none new)

- [ ] **Step 1: Whole-workspace check**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: all green.

- [ ] **Step 2: Sanity run the service**

```bash
pnpm --filter @i-harness/cli exec tsx src/index.ts web &
curl -s http://127.0.0.1:4310/api/sessions | head -c 300
```

- [ ] **Step 3: Record the E/A flags in the C-roadmap 取捨紀錄** (append one 註記 row, no plan doc): R-C1-A1/A2 flags + E-contract swaps — one line each.

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap/2026-08-31-roadmap-C-service.md
git commit -m "docs(roadmap): record C1 execution flags for A/E contract verification"
```

---

## Self-review notes (checked)

- **Spec coverage**: R-C0 → Tasks 1–4 + plan §R-C0; R-C1 → Tasks 1–13, 20; R-C2 → 10, 15; R-C3 → 14; R-C5 → 16–19; R-C6 → 3; R-C4/R-C7/R-C8 → one-liners kept in the roadmap, not built.
- **Placeholder scan**: every task carries executable code or an exact branch-file citation with an explicit edit list; no "TBD"/"similar to" — the port tasks cite line ranges and exact deltas because a full transcription of branch files would be stale the moment the branch is read; the task list is the contract.
- **Type consistency**: `SessionExecutor.submit` used by Task 11/12/20 matches §1; `AuthContext` extended consistently (Task 14's handler uses `cookieName()`/`launchToken` and the test updates already include it); `SessionPage.nextAfterSeq` consistent across Task 6/10/15; web-host steps match the Produced Contracts table. The one deliberate exemption (Task 3 executes before Task 2 no matter what the numbered list suggests) is flagged inside Task 2.
