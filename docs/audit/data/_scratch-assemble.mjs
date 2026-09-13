import fs from "node:fs"
import path from "node:path"

const DATA = "D:/I-harness-main/docs/audit/data"
const modulesDoc = JSON.parse(fs.readFileSync(path.join(DATA, "2026-09-11-d3-modules.json"), "utf8"))
const mineUp = JSON.parse(fs.readFileSync(path.join(DATA, "_scratch-mine-upstream.json"), "utf8"))
const mineFork = JSON.parse(fs.readFileSync(path.join(DATA, "_scratch-mine-fork.json"), "utf8"))
const perUp = JSON.parse(fs.readFileSync(path.join(DATA, "_scratch-upstream-peripheral.json"), "utf8"))
const perFork = JSON.parse(fs.readFileSync(path.join(DATA, "_scratch-fork-peripheral.json"), "utf8"))

const DOMAINS = ["loop", "session", "context", "tools", "subagent", "safety", "model", "extension", "service", "retrieval", "ops", "interface"]
const KEEP = ["name", "what", "invariants", "failurePolicy", "constants", "evidence", "modules", "verified"]
const clean = (m) => Object.fromEntries(KEEP.map((k) => [k, m[k]]))

function mergeDomains(parts) {
  const out = {}
  for (const d of DOMAINS) {
    const list = []
    const seen = new Set()
    for (const p of parts) for (const m of p.domains[d] ?? []) {
      if (seen.has(m.name)) continue
      seen.add(m.name)
      list.push(clean(m))
    }
    out[d] = list
  }
  return out
}

const upstreamDomains = mergeDomains([mineUp, perUp])
const forkDomains = mergeDomains([mineFork, perFork])

const reasons = {
  upstream: {
    "core/integration": "One-line integration wiring (core/src/integration/connection.ts); no behaviour of its own - it registers an external integration endpoint used by the extension-domain provider/plugin surface.",
    "core/effect": "Effect runtime plumbing (LayerNode / app-node / instance state) imported by the session and plugin mechanisms; contributes to session-runner-serialization, v2-run-coordinator-coalescing and plugin-hook-runtime.",
    "core/util": "Shared helpers; core/util/wildcard is the matcher used by permission-rule-engine and core/util/hash keys the snapshot git dir in snapshot-diff-tracking.",
    "docs": "Empty package (0 source files); contributes no mechanism.",
    "effect-drizzle-sqlite": "Drizzle-over-SQLite Effect driver; the storage layer under durable-event-log and session-sql-schema.",
    "effect-sqlite-node": "SQLite driver binding used by effect-drizzle-sqlite; contributes to session-sql-schema.",
    "http-recorder": "HTTP record/replay harness for provider tests; test-only, contributes no runtime mechanism.",
    "opencode/util": "Host utilities; util/timeout's withTimeout is used by the MCP client, so it contributes to mcp-client-lifecycle.",
    "storybook": "UI component workshop; presentation only, out of the backend scope.",
    "app": "Presentation package; per the approved interface scope only the event/stream contract it consumes counts, which is implemented in server/schema (event-envelope-contract, renderer-stream-transport).",
    "tui": "Presentation package; the backend seam it consumes is tui-control-channel plus the SSE event stream, not a mechanism implemented here.",
    "ui": "Presentation component library; contributes no backend mechanism.",
    "core/account": "Only an account table definition (core/src/account/sql.ts); storage plumbing for credential/entitlement state, no behaviour of its own.",
    "core/oauth": "OAuth callback page markup (core/src/oauth/page.ts); the OAuth flow itself is credential-store-and-oauth-lifecycle.",
    "opencode/account": "Host account service; contributes to the model-domain credential-store-and-oauth-lifecycle and to ops token-and-cost-accounting.",
    "opencode/env": "Single table declaring which providers are configured from environment variables; contributes to provider-registry-merge-chain.",
    "stats": "Statistics/aggregation package behind the CLI stats surface; contributes to token-and-cost-accounting and the ops session-stat aggregation.",
    "identity": "Empty package (0 source files); contributes no mechanism.",
    "cli": "CLI host; its engine-relevant parts are the run/serve/debug/stats commands that drive the service-domain and ops-domain mechanisms (sse-live-event-stream, runtime-flag-registry, debug-diagnostics-commands).",
    "client": "Client SDK wrapper package; contributes to the service-domain SDK/transport mechanisms.",
    "console": "Hosted web console (product UI + its API); out of the backend engine scope, contributes no mechanism.",
    "containers": "Docker build recipes for distribution; contributes to ops installation/distribution only.",
    "desktop": "Electron desktop shell; presentation, no backend mechanism.",
    "enterprise": "Enterprise packaging/SSO surface; contributes to service-basic-auth-with-ticket-bypass and workspace routing.",
    "function": "Deployment function entrypoint (packages/function/src/api.ts); no engine mechanism.",
    "sdk-next": "Next-generation SDK package; contributes to the service-domain SDK wire contract.",
    "slack": "Slack integration package containing only README/.env scaffolding in this tree; contributes no backend mechanism.",
    "web": "Marketing/docs site package; no backend mechanism.",
    "core/project": "Project/worktree bookkeeping rows including the sandbox path column; contributes to session-lifecycle-and-forking and to the no-os-level-sandbox finding.",
    "opencode/bus": "Bus adapter (bus/global.ts) bridging the durable event log to the global bus; contributes to event-envelope-contract.",
    "opencode/storage": "Legacy storage schema/helper retained for migration; contributes to session persistence only as a compatibility surface.",
    "opencode/sync": "Sync payload schema (sync/schema.ts); contributes to the service-domain workspace event-sync replication.",
    "session-ui": "96-file presentation package for sessions; its backend contribution is only the session event/stream contract (server/event.ts).",
    "core/github-copilot": "GitHub Copilot provider implementation (Copilot/OpenAI-compatible model adapters plus auth); contributes to provider-registry-merge-chain and provider-sdk-resolution-and-timeouts.",
    "opencode/git": "Single git wrapper (git/index.ts) used by project/bookkeeping paths; the model-visible behaviour is recorded in snapshot-diff-tracking.",
    "opencode/patch": "Single patch wrapper (patch/index.ts) used by the apply_patch tool; contributes to edit-replace-with-permission-diff.",
    "opencode/worktree": "Single worktree wrapper (worktree/index.ts); supports project/worktree bookkeeping for session locations.",
    "core/id": "Sortable id generator; contributes to session-sql-schema ordering and to output-truncation-spill file naming.",
    "opencode/id": "Host re-export of the id generator; contributes to the same mechanisms as core/id.",
    "core/v1": "Version-1 config/permission/session schemas still consumed by live code (v1/config/config.ts:41 inline command entries, v1/permission.ts PermissionV1.Ruleset); contributes to custom-command-registry, permission-rule-engine and session-permission-persistence.",
    "opencode/ide": "IDE integration endpoint; contributes to the interface-domain capability/negotiation mechanisms.",
    "script": "Repo build/release scripts; no runtime mechanism."
  },
  fork: {
    "core/integration": "One-line integration wiring (core/src/integration/connection.ts); registers an external integration endpoint, no behaviour of its own.",
    "plugin": "Shared plugin SDK (legacy Hooks types plus the v2 Effect plugin API); contributes to named-plugin-hook-runtime, v1-plugin-compatibility-bridge and source-composed-command-registry.",
    "core/effect": "Effect runtime plumbing imported by the kernel, coordinator and plugin mechanisms; contributes to kernel-durable-turn-coordinator and named-plugin-hook-runtime.",
    "docs": "Empty package (0 source files); contributes no mechanism.",
    "effect-drizzle-sqlite": "Drizzle-over-SQLite driver under every durable mechanism in this source (durable-event-log, durable-task-submission-protocol, lease-generation-fencing).",
    "effect-sqlite-node": "SQLite driver binding used by effect-drizzle-sqlite; contributes to durable-session-schema.",
    "http-recorder": "HTTP record/replay harness for provider tests; test-only, no runtime mechanism.",
    "opencode/format": "Host formatter dispatch retained from upstream; contributes to formatter-dispatch-by-config.",
    "schema": "Shared schema package (event manifest, session messages, permission rules, prompt input, durable event manifest); underpins durable-event-log, permission-v2-engine and the pruned-field plumbing noted in the tool-result-pruning delta.",
    "storybook": "UI component workshop; presentation only.",
    "app": "Presentation package; only the renderer/event seam is in scope and that seam is implemented in server/schema (event-manifest-versioned-contract, worker-thread-rpc-bridge).",
    "opencode/config": "Host config loading/merge and path discovery; contributes to source-composed-command-registry and the interface settings seams.",
    "tui": "Presentation package; consumes tui-control-request-channel and the SSE event stream rather than implementing a backend mechanism.",
    "ui": "Presentation component library; contributes no backend mechanism.",
    "core/account": "Account table definition only; storage plumbing for credential/entitlement state.",
    "core/oauth": "OAuth callback page markup; the flow is credential-store-with-oauth-refresh.",
    "llm": "Shared LLM wire-protocol/route package consumed by the model mechanisms (llm-runtime-native-vs-aisdk-selection, reasoning-effort-variant-translation, model-resolution-chain).",
    "opencode/account": "Host account service; contributes to credential-store-with-oauth-refresh and token-and-cost-accounting.",
    "opencode/auth": "Empty directory (0 source files): auth moved to core credential plus the compat wire layer; contributes no mechanism.",
    "opencode/env": "Provider-from-environment table; contributes to the model-domain catalogue/credential resolution chain.",
    "stats": "Statistics package behind the CLI stats surface; contributes to session-stats-aggregation and token-and-cost-accounting.",
    "opencode/image": "Host image helper wrapping the core photon normalizer; contributes to image-normalization.",
    "identity": "Empty package (0 source files); contributes no mechanism.",
    "cli": "CLI host; its engine-relevant parts (run/tui/serve/heap/uninstall) drive sse-event-stream-with-heartbeat, worker-thread-rpc-bridge, heap-snapshot-watchdog and installation-method-detection.",
    "client": "Client SDK wrapper package; contributes to legacy-sdk-openapi-contract and http-server-and-openapi-spec.",
    "console": "Hosted web console; out of the backend engine scope, contributes no mechanism.",
    "containers": "Docker recipes for distribution; ops distribution only.",
    "core/control-plane": "Two-file control-plane plumbing; contributes to the service-domain workspace routing/proxy mechanisms.",
    "core/share": "Single-file share helper; contributes to the session-share-upload/lineage retrieval mechanism.",
    "desktop": "Electron desktop shell; presentation, no backend mechanism.",
    "enterprise": "Enterprise packaging/SSO surface; contributes to service-basic-auth.",
    "function": "Deployment function entrypoint; no engine mechanism.",
    "opencode/share": "Host share wiring; contributes to session-share-upload.",
    "sdk": "Generated SDK package (122 files) implementing the legacy OpenAPI wire contract; contributes to legacy-sdk-openapi-contract.",
    "sdk-next": "Next-generation SDK package; contributes to the service-domain wire contract surface.",
    "server": "Standalone server package (54 files) exposing the HTTP/SSE handlers; contributes to http-server-and-openapi-spec and sse-event-stream-with-heartbeat.",
    "slack": "Slack integration package containing only scaffolding in this tree; contributes no backend mechanism.",
    "web": "Marketing/docs site package; no backend mechanism.",
    "core/event": "Single-file barrel for the event log service; the durable-event-log mechanism is implemented in core/src/event.ts and cited there.",
    "opencode/project": "Host project/location bookkeeping (git detection, worktrees, sandbox path column); contributes to durable-session-schema location semantics and the no-os-level-sandbox finding.",
    "opencode/storage": "Legacy storage schema/helper retained for migration; compatibility only.",
    "opencode/sync": "Sync payload schema; contributes to workspace-event-sync-replication.",
    "session-ui": "98-file presentation package; its backend contribution is the session event/stream contract only.",
    "opencode/background": "Host wrapper adapting the core BackgroundJob registry to instance scope; contributes to background-job-registry and task-cancellation-by-ownership-root.",
    "core/github-copilot": "GitHub Copilot provider implementation; contributes to the model-domain catalogue and credential mechanisms.",
    "core/ripgrep": "Single-file barrel for the ripgrep adapter (core/src/ripgrep.ts); contributes to workspace-file-search and file-read-search-surface.",
    "opencode/git": "Single git wrapper; model-visible behaviour is recorded in the snapshot/diff mechanisms.",
    "opencode/patch": "Single patch wrapper used by the apply-patch tool; contributes to the edit/apply-patch tooling.",
    "opencode/snapshot": "Single-file wrapper over the git-backed snapshot service; contributes to session revert/diff.",
    "opencode/worktree": "Single worktree wrapper supporting session locations.",
    "core/id": "Sortable id generator; contributes to durable-session-schema ordering and job/task id derivation.",
    "httpapi-codegen": "HTTP API code generator for the SDK wire contract; contributes to legacy-sdk-openapi-contract.",
    "opencode/command": "Empty directory (0 source files) - the v1 command registry was deleted in favour of the CoreV2 source-composed registry; contributes no mechanism here.",
    "opencode/id": "Host re-export of the id generator; contributes to the same mechanisms as core/id.",
    "opencode/ide": "IDE integration endpoint; contributes to the interface-domain capability negotiation.",
    "protocol": "Wire protocol definitions (38 files) consumed by the service-layer mechanisms and the compat wire adapters.",
    "script": "Repo build/release scripts; no runtime mechanism."
  }
}

function buildCoverage(sourceKey, domains) {
  const mods = modulesDoc.sources[sourceKey].modules
  const nameToPath = new Map(mods.map((m) => [m.name, m.path]))
  const sorted = [...mods].sort((a, b) => b.path.length - a.path.length)
  const buckets = new Map(mods.map((m) => [m.name, new Set()]))
  for (const d of DOMAINS) for (const mech of domains[d]) {
    const owners = new Set()
    for (const raw of mech.modules ?? []) {
      const p = nameToPath.get(raw) ?? raw
      for (const cand of sorted) {
        if (p === cand.path || p.startsWith(cand.path + "/")) { owners.add(cand.name); break }
      }
    }
    for (const o of owners) buckets.get(o).add(mech.name)
  }
  const out = {}
  const missingReasons = []
  for (const m of mods) {
    const b = buckets.get(m.name)
    if (b.size > 0) out[m.name] = [...b].sort()
    else {
      const r = reasons[sourceKey][m.name]
      if (!r) missingReasons.push(m.name)
      out[m.name] = r ?? "UNMAPPED"
    }
  }
  return { out, missingReasons, count: mods.length }
}

const upCov = buildCoverage("opencode", upstreamDomains)
const forkCov = buildCoverage("opencode-fork", forkDomains)
if (upCov.missingReasons.length) console.log("UP MISSING REASONS:", upCov.missingReasons)
if (forkCov.missingReasons.length) console.log("FORK MISSING REASONS:", forkCov.missingReasons)

const hintCorrections = {
  upstream: [
    { module: "opencode/agent", hint: "loop", correction: "This module is the AGENT PROFILE registry (mode primary/subagent/all, model, variant, steps, permission ruleset, builtins build/plan/general/explore plus hidden compaction/title/summary); the loop itself lives in opencode/session. It contributes to the loop-domain step-budget-enforcement and to the subagent-domain task-tool-delegation and agent-mode-taxonomy.", evidence: ["packages/opencode/src/agent/agent.ts:38", "packages/opencode/src/agent/agent.ts:54", "packages/opencode/src/agent/agent.ts:142"] },
    { module: "opencode/question", hint: "retrieval", correction: "Not retrieval: this is the user-input round-trip (question tool calling the core Question service, whose request is a Deferred the UI must resolve). It belongs to the interaction/interface seam and, because an unanswered request blocks the turn, to safety.", evidence: ["packages/core/src/question.ts:67", "packages/core/src/question.ts:97"] },
    { module: "core/github-copilot", hint: "tools", correction: "Model domain, not tools: it is a provider adapter (Copilot/OpenAI-compatible provider factory with bearer credentials and a configurable base URL) feeding the provider registry and model catalogue.", evidence: ["packages/core/src/github-copilot/copilot-provider.ts:52", "packages/core/src/github-copilot/copilot-provider.ts:62"] },
    { module: "opencode/format", hint: "infra", correction: "Tools domain: post-write formatter dispatch, where each formatter probes the project for its config file and yields an argv template with $FILE.", evidence: ["packages/opencode/src/format/formatter.ts:11", "packages/opencode/src/format/formatter.ts:143"] },
    { module: "opencode/background", hint: "subagent", correction: "Loop/execution primitive first, subagent second: it is the per-instance background-job registry that the loop consults to cancel a session's jobs, and that task delegation registers child sessions in.", evidence: ["packages/opencode/src/background/job.ts:17", "packages/core/src/background-job.ts:88", "packages/opencode/src/session/run-state.ts:111"] },
    { module: "core/v1", hint: "unmapped", correction: "Not unmapped: the v1 schemas are live (inline command entries in v1/config/config.ts, PermissionV1.Ruleset stored on the session row and consumed by the tool registry), so they belong to extension/safety/session.", evidence: ["packages/core/src/v1/config/config.ts:41", "packages/core/src/v1/permission.ts:1", "packages/core/src/session/sql.ts:50"] },
    { module: "opencode/session", hint: "session", correction: "Hint understates the module: it contains the prompt loop and turn engine (loop), the compaction/pruning policy (context) and instruction/reminder injection (context), not only session persistence.", evidence: ["packages/opencode/src/session/prompt.ts:1081", "packages/opencode/src/session/compaction.ts:28", "packages/opencode/src/session/overflow.ts:8"] },
    { module: "core/session", hint: "session", correction: "Same understatement: it also carries the v2 turn runner (loop), the context epoch (context), input admission/steering (loop) and the projection/update path (session).", evidence: ["packages/core/src/session/runner/llm.ts:400", "packages/core/src/session/context-epoch.ts:31", "packages/core/src/session/input.ts:41"] },
    { module: "tui", hint: "interface", correction: "Presentation package; under the approved interface scope only the engine seam counts, and that seam (the TUI event/control contract) is defined in the server/schema modules, not in this package.", evidence: ["packages/opencode/src/server/event.ts:4", "packages/opencode/src/server/shared/tui-control.ts:1"] },
    { module: "session-ui", hint: "session", correction: "Presentation package, not session logic: it renders session state delivered over the event/stream contract; the session mechanisms live in core/session and opencode/session.", evidence: ["packages/opencode/src/server/event.ts:4"] }
  ],
  fork: [
    { module: "core/session", hint: "session", correction: "Spans four domains here: the kernel/classic engines and coordinator (loop), the durable task protocol and projections (session/subagent), compaction (context) and tool scheduling/discovery (tools).", evidence: ["packages/core/src/session/execution/router.ts:12", "packages/core/src/session/task-submission.ts:23", "packages/core/src/session/kernel/tool-scheduler.ts:42"] },
    { module: "opencode/session", hint: "session", correction: "In the fork this is the host-side session facade (run-state, retry, overflow, summary, message-v2/compat wire shims); the engine moved to core/session, so the hint describes the upstream layout rather than this module's content.", evidence: ["packages/opencode/src/session/run-state.ts:1", "packages/opencode/src/session/overflow.ts:1"] },
    { module: "opencode/permission", hint: "safety", correction: "Only a legacy-rules shim remains (the live engine is core/permission.ts with V2 rules); the module still contributes to safety but not as the policy engine.", evidence: ["packages/opencode/src/permission/legacy-rules.ts:58", "packages/core/src/permission.ts:1"] },
    { module: "opencode/tool", hint: "tools", correction: "Only host compat shims (plugin-compat, plugin-compat-v2, schema, truncate) remain; the tool implementations moved to core/tool, so most tools-domain mechanisms are implemented outside this module.", evidence: ["packages/opencode/src/tool/plugin-compat.ts:1", "packages/opencode/src/tool/truncate.ts:1"] },
    { module: "opencode/background", hint: "subagent", correction: "Loop/execution primitive first: it is the instance-scoped wrapper of the core BackgroundJob registry that the loop's cancellation cascade and the durable task protocol both use.", evidence: ["packages/opencode/src/background/job.ts:1", "packages/core/src/background-job.ts:139"] },
    { module: "opencode/command", hint: "unmapped", correction: "Empty directory (0 files): the v1 command registry and its templates were deleted, so this module contributes nothing and the hint 'unmapped' is right only by accident.", evidence: ["packages/core/src/plugin/command.ts:15"] },
    { module: "opencode/auth", hint: "model", correction: "Empty directory (0 files): authentication moved to core credential plus the compat wire layer (compat/auth-wire.ts), so this module contributes no mechanism.", evidence: ["packages/opencode/src/compat/auth-wire.ts:1"] },
    { module: "core/mcp", hint: "extension", correction: "Correct domain, but note the fork ADDED this module: MCP was moved out of the host into core and now registers its prompts as a command Source, so it also contributes to the command-registry mechanism, not only to MCP client behaviour.", evidence: ["packages/core/src/mcp/runtime.ts:931", "packages/core/src/mcp/runtime.ts:935"] },
    { module: "core/lsp", hint: "extension", correction: "Correct domain; the module is fork-new (LSP moved from the host into core), so the upstream module of the same capability path no longer exists at packages/opencode/src/lsp/index.ts.", evidence: ["packages/core/src/lsp/lsp.ts:1"] },
    { module: "llm", hint: "model", correction: "Correct domain; recorded because the fork's model mechanisms are mostly cited at core paths (provider-models, provider-discovery) while this shared package implements the wire/route layer they use.", evidence: ["packages/core/src/provider-models.ts:124"] }
  ]
}

const absent = {
  upstream: {
    domainsAbsent: [],
    absentCapabilities: [
      { capability: "OS-level sandbox / process confinement", reason: "Confirmed absent: the shell tool builds ChildProcess.make and spawns it through ChildProcessSpawner with no wrapper, namespace, seatbelt/bwrap/landlock or seccomp layer; the only 'sandbox' identifiers in the tree are project worktree path bookkeeping and the codemode JS interpreter's Sandbox* types. The permission model is policy, not confinement.", evidence: ["packages/opencode/src/tool/shell.ts:295", "packages/opencode/src/tool/shell.ts:484", "packages/core/src/project/sql.ts:16", "packages/opencode/src/session/prompt/kimi.txt:62"] },
      { capability: "Cross-session long-term memory / codebase graph index", reason: "No memory or codebase-graph module exists; the durable schema is per-session (session/message/part/todo/session_message/session_input/session_context_epoch) and the closest capabilities are per-session search and file search.", evidence: ["packages/core/src/session/sql.ts:22", "packages/core/src/session/sql.ts:119"] },
      { capability: "Subagent identity / credential / workspace isolation", reason: "A subagent is a child session in the same process sharing the host's credentials; only its permission ruleset is derived (parent denies + external_directory, plus default todowrite/task denies).", evidence: ["packages/opencode/src/agent/subagent-permissions.ts:14", "packages/opencode/src/tool/task.ts:157"] },
      { capability: "Remote execution placement", reason: "Execution routing is explicitly local-only: the local layer's own comment places future remote placement there, and there is no remote worker implementation.", evidence: ["packages/core/src/session/execution/local.ts:10"] }
    ]
  },
  fork: {
    domainsAbsent: [],
    absentCapabilities: [
      { capability: "OS-level sandbox / process confinement", reason: "Confirmed absent in the fork too: the bash tool spawns the configured shell directly and its own description states the command runs with the host user's filesystem, process and network authority, gated only by permission.assert; the only 'sandbox' identifiers in core are the project sandboxes path column and the codemode JS Sandbox* types.", evidence: ["packages/core/src/tool/bash.ts:340", "packages/core/src/tool/bash.ts:81", "packages/core/src/project/sql.ts:16", "packages/core/src/tool/code-mode.ts:3"] },
      { capability: "Durable in-process background jobs", reason: "The BackgroundJob registry is explicitly non-durable (a restart or owner-scope closure loses status and interrupts live work); durability exists only for delegated tasks via task_submission/task_notification_outbox, and the bash tool's backgrounded commands ride the non-durable registry.", evidence: ["packages/core/src/background-job.ts:139", "packages/core/src/session/task-submission.ts:23"] },
      { capability: "Tool-result pruning policy (upstream PRUNE_PROTECT/PRUNE_MINIMUM pass)", reason: "Removed: no PRUNE_PROTECT, PRUNE_MINIMUM or PRUNE_PROTECTED_TOOLS identifier exists anywhere in the fork tree, and nothing writes tool.time.pruned. Only the representation survives - the pruned field on the message schema, its two-way mapping in to-llm-message.ts and the compaction.prune config key.", evidence: ["packages/schema/src/session-message.ts:147", "packages/core/src/session/runner/to-llm-message.ts:781", "packages/core/src/config/compaction.ts:12"] },
      { capability: "Remote execution placement", reason: "Still local-only: kernel and classic engines are process-local coordinators over durable rows; there is no remote worker transport.", evidence: ["packages/core/src/session/kernel/coordinator.ts:89-95"] },
      { capability: "Cross-session long-term memory / codebase graph index", reason: "No memory or codebase graph module; durable state is per-session, plus durable tool-discovery records which are session-scoped.", evidence: ["packages/core/src/session/sql.ts:328", "packages/core/src/session/tool-discovery.ts:97"] }
    ]
  }
}

const forkDeltas = [
  { area: "session-execution-engine", change: "Two engines exist per session, fixed at creation: the session row gained an engine column (default 'classic', existing rows decode as classic) and a router reads it to pick the engine, failing with KernelUnavailableError instead of ever falling back to classic.", evidence: ["packages/core/src/session/sql.ts:51-52", "packages/core/src/session/execution/router.ts:12-17", "packages/core/src/session/execution/router.ts:40-51", "packages/core/src/session/command.ts:66"] },
  { area: "kernel-engine", change: "A whole kernel execution engine is new: durable turn coordinator, lifecycle store with generation/lease fencing, publication actor, plugin host, recovery planner/executor, diagnostics and status projector. Upstream's packages/core/src/session has only execution/local.ts plus the runner, with no kernel directory.", evidence: ["packages/core/src/session/kernel/index.ts:19-33", "packages/core/src/session/kernel/coordinator.ts:89-95", "packages/core/src/session/kernel/lifecycle-store.ts:68-87", "packages/core/src/session/sql.ts:288-303"] },
  { area: "startup-recovery", change: "The kernel reconciles every non-idle kernel execution at startup (planner + executor + plugin recovery-advice seam) with zero provider calls by construction; upstream has no recovery planner or execution state machine.", evidence: ["packages/core/src/session/kernel/index.ts:65-92"] },
  { area: "durable-provider-attempts", change: "Provider attempts became durable rows with a state machine (started/responding/retrying/continuation -> ended/interrupted/abandoned, plus recovery-required) and a bounded automatic retry: MAX_PROVIDER_ATTEMPTS = 3 with delay min(retryAfterMs ?? 500*2^(n-1), 10_000) ms. Upstream's core runner has no attempt table and no MAX_PROVIDER_ATTEMPTS constant.", evidence: ["packages/core/src/session/attempt.ts:33-71", "packages/core/src/session/runner/llm.ts:213-215", "packages/core/src/session/sql.ts:240"] },
  { area: "tool-failure-circuit-breaker", change: "New per-turn circuit breaker on identical tool failures: MAX_IDENTICAL_TOOL_FAILURES = 2 stops the turn from repeating the same failing call. No counterpart in upstream's runner.", evidence: ["packages/core/src/session/runner/llm.ts:126", "packages/core/src/session/runner/llm.ts:678-690"] },
  { area: "session-stop-hooks", change: "New hook-driven turn termination: 'session.stop' / 'session.subagent.stop' hooks may demand continuation, capped at MAX_BLOCKS_PER_TURN = 3 shared across all provider attempts of a turn, and the evaluation fails open. Upstream's HookName union has no stop hooks and no block cap.", evidence: ["packages/core/src/session/stop-hook.ts:6", "packages/core/src/session/stop-hook.ts:20-47", "packages/core/src/plugin/runtime.ts:22-23"] },
  { area: "durable-task-protocol", change: "Delegation became durable and resumable: task_submission rows keyed by parent session/message/tool-call with child session+input, agent path, completion delivery ('tool' | 'parent'), status and outcome (including recovery-required), a task_notification_outbox as the durable notification source of truth, and a session_cancellation table. Upstream has none of these tables and delegates in-process.", evidence: ["packages/core/src/session/task-submission.ts:23-41", "packages/core/src/session/task-submission.ts:56", "packages/core/src/session/task-notification.ts:30-43", "packages/core/src/session/sql.ts:153", "packages/core/src/session/sql.ts:196", "packages/core/src/session/sql.ts:222"] },
  { area: "subagent-concurrency-budget", change: "New SubagentPermit budget keyed per delegation, sized from config 'subagent_max_concurrency' (undefined = unlimited), acquired before child creation, re-keyed to the child session and released on settle; depth still defaults to 1 via 'subagent_depth'. Upstream has a depth check only.", evidence: ["packages/core/src/session/subagent-permit.ts:27-43", "packages/core/src/tool/task.ts:175-176", "packages/core/src/tool/task.ts:224", "packages/core/src/tool/task.ts:416"] },
  { area: "task-cancellation-and-control-tools", change: "New cancellation tree plus control tools: TaskCancellation.cancelTree settles submissions/outbox/cancellations/attempts in one transaction and then interrupts and waits for every affected session, and the task surface gained get_task_output and stop_task. Upstream cancels by cancelling background jobs of a session's descendants.", evidence: ["packages/core/src/session/task-cancellation.ts:48-107", "packages/core/src/session/task-cancellation.ts:203-217", "packages/core/src/tool/get-task-output.ts:1", "packages/core/src/tool/stop-task.ts:1", "packages/opencode/src/session/run-state.ts:83-103"] },
  { area: "transcript-storage", change: "The legacy transcript tables were retired: a session_message_tombstone table was introduced and a later migration drops the tombstone together with the message and part tables and their indexes. Upstream still stores messages in message + part.", evidence: ["packages/core/src/database/migration/20260812130609_drop_legacy_transcript.ts:8-14", "packages/core/src/session/sql.ts:90"] },
  { area: "session-command-durability", change: "Prompt submission became a durable, conflict-checked command protocol with typed conflicts (PromptConflictError, ActiveAttemptConflictError, TurnConflictError, RestoreConflictError) over idempotent input admission. Upstream's loop is driven directly and treats the command surface as a plain prompt call.", evidence: ["packages/core/src/session/command.ts:37-60", "packages/core/src/session/command.ts:91-120", "packages/core/src/session/input.ts:487-515"] },
  { area: "input-admission-model", change: "Input rows gained an intent and a synthetic descriptor with a scope, plus session-scoped queries (pending, waitForPending, promotedUnterminalizedAtOrBefore, cancelPending) and the notion of startup candidates for steer delivery that must be re-driven after restart. Upstream's SessionInput has delivery + promoted_seq only.", evidence: ["packages/core/src/session/input.ts:104-141", "packages/core/src/session/input.ts:414-471", "packages/opencode/src/session/legacy-session-input.ts:1"] },
  { area: "projection-repair", change: "New crash-repair path: SessionRepair.repairSession replays the durable log (limit 10_000) to rebuild a missing/divergent attempt row and missing input rows only. Upstream has no repair module.", evidence: ["packages/core/src/session/repair.ts:27-61", "packages/core/src/session/repair.ts:34", "packages/core/src/session/repair.ts:63-74"] },
  { area: "session-settlement", change: "New SessionLifecycle settlement helpers (settleAssistant, settleCompletedAttempt, terminateAttempt, abandonOrphan, reconcileForStart, endOpenTurn) so a crashed turn's pending tool parts, step, attempt and turn are closed durably.", evidence: ["packages/core/src/session/lifecycle.ts:16-49", "packages/core/src/session/lifecycle.ts:82-117", "packages/core/src/session/lifecycle.ts:134-160"] },
  { area: "permission-model", change: "The stored session ruleset was migrated in place from V1 {permission, pattern, action} to V2 {action, resource, effect}, the live engine moved to core with deny-by-default missingAgentPermissions, and the host permission service (index/arity/evaluate) was replaced by a legacy-rules shim exporting itself as both LegacyPermissionRules and Permission.", evidence: ["packages/core/src/database/migration/20260811000000_session_permission_v2.ts:4-26", "packages/core/src/session/sql.ts:50", "packages/core/src/permission.ts:20", "packages/opencode/src/permission/legacy-rules.ts:58-59"] },
  { area: "tool-catalog-exposure", change: "New tool catalogue with explicit exposure (direct | deferred | hidden): deferred tools stay out of the model's tool list until searched, the registry only materialises tool_search when a deferred tool exists, and a definition-hash change invalidates a prior selection. Upstream's core registry is a plain name->registration map with no catalogue or search tool.", evidence: ["packages/core/src/tool/catalog.ts:16-34", "packages/core/src/tool/registry.ts:314-318", "packages/core/src/tool/registry.ts:417-432", "packages/core/src/tool/registry.ts:454"] },
  { area: "durable-tool-discovery", change: "tool_search results are durable per session (session_tool_discovery_call / session_tool_discovery projections of a ToolDiscovery.Completed event) and a stale or conflicting discovery result is rejected instead of executed. No counterpart upstream.", evidence: ["packages/core/src/session/tool-discovery.ts:18-23", "packages/core/src/session/tool-discovery.ts:146-186", "packages/core/src/session/sql.ts:328-348"] },
  { area: "bash-timeout-semantics", change: "A foreground bash command that exceeds its timeout is no longer killed: it is transferred to an owned background task (reason 'timeout'), a new user steer also backgrounds a running command (reason 'steer'), and the model inspects/cancels it with get_task_output/stop_task. Upstream kills the process after the timeout with forceKillAfter 3 seconds.", evidence: ["packages/core/src/tool/bash.ts:32-36", "packages/core/src/tool/bash.ts:437", "packages/core/src/tool/bash.ts:526-569", "packages/opencode/src/tool/shell.ts:548-556"] },
  { area: "kernel-tool-scheduling", change: "New bounded tool scheduler: MaxActiveBodies = 10 concurrent bodies with head-of-line finalization, per-call 'parallel' | 'exclusive' mode where exclusive drains active work first, and outcomes classified success/error/cancelled/abandoned. Upstream relies on the AI SDK's tool execution and a doom-loop permission guard.", evidence: ["packages/core/src/session/kernel/tool-scheduler.ts:9-17", "packages/core/src/session/kernel/tool-scheduler.ts:42", "packages/core/src/session/kernel/tool-scheduler.ts:73"] },
  { area: "compaction-policy", change: "Compaction was rebuilt in core with explicit budgets (DEFAULT_BUFFER 20_000, DEFAULT_KEEP_TOKENS 8_000, SUMMARY_OUTPUT_TOKENS 4_096) and a fixed summary template, and it runs as a lease-fenced phase. The upstream host compactor is gone; its tool-result pruning pass (PRUNE_PROTECT 40_000 / PRUNE_MINIMUM 20_000 / PRUNE_PROTECTED_TOOLS ['skill']) has NO counterpart in the fork - the pruned field and its wire mapping remain but nothing writes them.", evidence: ["packages/core/src/session/compaction.ts:23-27", "packages/core/src/session/kernel/coordinator.ts:736-758", "packages/opencode/src/session/compaction.ts:28-31", "packages/schema/src/session-message.ts:147", "packages/core/src/session/runner/to-llm-message.ts:781"] },
  { area: "request-option-partitioning", change: "New module splitting a request body into generation options, provider options and a wire body that strips provider-only keys per route (openai: promptCacheKey/reasoningEffort/reasoningSummary/serviceTier/textVerbosity; anthropic: thinking; gemini: thinkingConfig). No upstream counterpart.", evidence: ["packages/core/src/session/runner/request-policy.ts:5-15", "packages/core/src/session/runner/request-policy.ts:34-48"] },
  { area: "plugin-runtime", change: "Plugin hooks became a scoped, ordered, named runtime with a 17-entry HookName union, owner-order then registration-sequence execution, mutable event holders and scope-bound disposal. Upstream iterates a per-instance hooks array in Plugin.trigger with no scoping, ordering metadata or name union.", evidence: ["packages/core/src/plugin/runtime.ts:6-26", "packages/core/src/plugin/runtime.ts:85-116"] },
  { area: "plugin-v1-compatibility", change: "New legacy-plugin bridge: v1-compat.ts declares the whole V1 Hooks surface and adapts each hook onto the CoreV2 Effect host with mutable get/set outputs, v1-projection.ts converts V2 model/provider/auth/credential values into legacy shapes, and plugin initialization is bounded by an 8-second timeout. Upstream's only bridge is a Promise->Effect adapter.", evidence: ["packages/core/src/plugin/v1-compat.ts:54-80", "packages/core/src/plugin/v1-projection.ts:15", "packages/opencode/src/plugin/index.ts:80", "packages/opencode/src/plugin/index.ts:388"] },
  { area: "command-registry", change: "The CoreV2 command registry became source-composed: an ordered Source[] resolved in reverse before the base map, skills projected only when skill.slash !== false, a beforeExecute plugin pass, INIT/REVIEW exported constants driving the builtin templates, MCP prompts registered as a Source, and the entire duplicate v1 registry plus its templates deleted from the host.", evidence: ["packages/core/src/command.ts:15-23", "packages/core/src/command.ts:85-118", "packages/core/src/plugin/command.ts:14-22", "packages/core/src/mcp/runtime.ts:931-953"] },
  { area: "plugin-marketplace", change: "New install surface that did not exist upstream (no 'marketplace' identifier anywhere in the upstream host): a Claude-style marketplace manager with versioned state, git/GitHub/HTTP sources, manifest discovery, install/uninstall/refresh, per-plugin capabilities, and generated skill/command directories; plugin sources are validated to stay inside the marketplace directory.", evidence: ["packages/opencode/src/plugin/claude-marketplace.ts:76-77", "packages/opencode/src/plugin/claude-marketplace.ts:124-126", "packages/opencode/src/plugin/claude-marketplace.ts:341", "packages/opencode/src/plugin/claude-marketplace.ts:572-592"] },
  { area: "direct-extension-approval", change: "New capability-approval model for directly installed extensions: a versioned direct-extensions.json records requested vs APPROVED capabilities, split into declarative (skills, commands, mcp, themes) and runtime (plugin.runtime, agent.transform, catalog.transform, command.transform, ...), with config edits made under a flock and JSONC-preserving edits.", evidence: ["packages/opencode/src/plugin/direct-extension.ts:27-53", "packages/opencode/src/plugin/direct-extension.ts:60-70"] },
  { area: "plugin-readiness", change: "New runtime readiness reporter that derives pending/ready per capability (skills, commands, tool sources, MCP, aggregate) from live observations, so an unmet capability is pending while initialization is in flight rather than unavailable.", evidence: ["packages/opencode/src/plugin/runtime-readiness.ts:49-63", "packages/opencode/src/plugin/runtime-readiness.ts:81-115", "packages/opencode/src/plugin/runtime-readiness.ts:148-150"] },
  { area: "backend-relayering", change: "The engine was re-layered into packages/core/src: the tool registry and tools (catalog, task, bash, stop-task, get-task-output, tool-search, code-mode, lsp, progress), MCP and LSP now live in core, while packages/opencode/src gained compat wire adapters (auth-wire, provider-wire, session-wire, native-v1-*) and legacy-* shims; the host tool directory shrank to four compat files.", evidence: ["packages/core/src/tool/registry.ts:1", "packages/core/src/mcp/runtime.ts:1", "packages/core/src/lsp/lsp.ts:1", "packages/opencode/src/compat/native-v1-session.ts:1", "packages/opencode/src/tool/plugin-compat.ts:1"] },
  { area: "live-model-discovery", change: "Fork-only live provider model discovery (core/src/provider-models.ts + provider-discovery.ts) with a catalog snapshot, in addition to the models.dev cache both sources share.", evidence: ["packages/core/src/provider-models.ts:124", "packages/core/src/provider-models.ts:132", "packages/core/src/provider-discovery.ts:65", "packages/core/src/provider-discovery.ts:389"] },
  { area: "custom-provider-management", change: "Fork-only custom provider configure/rollback service (packages/opencode/src/provider/custom-provider/*) that did not exist upstream.", evidence: ["packages/opencode/src/provider/custom-provider/service.ts:69", "packages/opencode/src/provider/custom-provider/service.ts:103", "packages/opencode/src/provider/custom-provider/service.ts:217"] },
  { area: "kernel-diagnostics", change: "Fork-only kernel diagnostics with counters and percentiles (core/src/session/kernel/diagnostics.ts), consumed by startup reconciliation bookkeeping.", evidence: ["packages/core/src/session/kernel/diagnostics.ts:35-36", "packages/core/src/session/kernel/diagnostics.ts:47", "packages/core/src/session/kernel/diagnostics.ts:58"] },
  { area: "session-usage-accounting", change: "Fork-only session usage module (packages/opencode/src/session/usage.ts) for token/cost accounting, where upstream accounts inline in the session/token fields.", evidence: ["packages/opencode/src/session/usage.ts:12", "packages/opencode/src/session/usage.ts:30", "packages/opencode/src/session/usage.ts:46"] },
  { area: "attachment-materialization", change: "Fork-only attachment materialization in core (core/src/session/attachment.ts) so prompt attachments become durable session content; upstream has no core attachment module.", evidence: ["packages/core/src/session/attachment.ts:17-18", "packages/core/src/session/attachment.ts:158"] },
  { area: "agent-registry", change: "Agents moved to core as AgentV2 with a Transformable draft surface and defaultID 'build'; the host keeps only an agent-file generator (packages/opencode/src/agent/generator.ts) instead of upstream's builtin agent map with modes/steps/permissions.", evidence: ["packages/core/src/agent.ts:10", "packages/core/src/agent.ts:68-74", "packages/opencode/src/agent/generator.ts:1"] },
  { area: "unchanged-despite-appearance", change: "NOT deltas, recorded so they are not mistaken for them: the overflow/usable budget math is byte-identical (COMPACTION_BUFFER 20_000 and the same reserve rule), the host truncation contract is unchanged (2_000 lines / 50 KiB), the BackgroundJob registry is still the same non-durable in-process engine, and the run-state serialization contract (one Runner per session, BusyError on busy shell) is unchanged.", evidence: ["packages/opencode/src/session/overflow.ts:8-20", "packages/opencode/src/tool/truncate.ts:1", "packages/core/src/background-job.ts:139", "packages/opencode/src/session/run-state.ts:110-126"] }
]

const out = {
  "generatedFor": "D3 backend mechanism inventory - opencode upstream + private fork",
  "date": "2026-09-11",
  upstream: {
    source: "opencode",
    version: "1.18.30",
    root: modulesDoc.sources.opencode.root,
    moduleCount: upCov.count,
    mechanismCount: DOMAINS.reduce((a, d) => a + upstreamDomains[d].length, 0),
    sandboxFinding: "NO OS-level sandbox. Confinement is the permission model only (last-match wildcard rules defaulting to 'ask'); shell/process tools spawn the host shell directly with the user's full authority. See absentCapabilities.",
    domains: upstreamDomains,
    moduleCoverage: upCov.out,
    hintCorrections: hintCorrections.upstream,
    domainsAbsent: absent.upstream.domainsAbsent,
    absentCapabilities: absent.upstream.absentCapabilities
  },
  fork: {
    source: "opencode-fork",
    dirName: "opencode-fork-private-999.0.15",
    version: "999.0.19",
    versionNote: "Directory name says 999.0.15 but packages/opencode/package.json declares version 999.0.19 (packages/opencode/package.json:3). 999.0.19 is used; the discrepancy is recorded, not resolved.",
    root: modulesDoc.sources["opencode-fork"].root,
    moduleCount: forkCov.count,
    mechanismCount: DOMAINS.reduce((a, d) => a + forkDomains[d].length, 0),
    sandboxFinding: "NO OS-level sandbox, same as upstream. The bash tool's own description states the command runs with the host user's filesystem, process and network authority; permission.assert is the only gate. See absentCapabilities.",
    domains: forkDomains,
    moduleCoverage: forkCov.out,
    hintCorrections: hintCorrections.fork,
    domainsAbsent: absent.fork.domainsAbsent,
    absentCapabilities: absent.fork.absentCapabilities
  },
  forkDeltas
}

const target = path.join(DATA, "2026-09-11-d3-opencode.json")
fs.writeFileSync(target, JSON.stringify(out, null, 2))
console.log("wrote", target)
console.log("upstream mechanisms:", out.upstream.mechanismCount, "modules:", out.upstream.moduleCount, "coverage keys:", Object.keys(out.upstream.moduleCoverage).length)
console.log("fork mechanisms:", out.fork.mechanismCount, "modules:", out.fork.moduleCount, "coverage keys:", Object.keys(out.fork.moduleCoverage).length)
console.log("forkDeltas:", forkDeltas.length)
