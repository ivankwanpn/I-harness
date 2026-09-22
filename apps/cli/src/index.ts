import { pathToFileURL } from "node:url"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
// BUG-1 (m49 audit): node:sqlite's ExperimentalWarning is suppressed by the
// session-query package itself (module side effect, evaluated before its
// node:sqlite import) — no explicit wiring needed here.
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { runHeadless, type HeadlessOptions } from "./run.ts"
import { createCliDiagnostics } from "./diagnostics-bootstrap.ts"
import { createProviderRegistry, buildModelClient } from "@i-harness/provider"
import { diagnosticsFor } from "@i-harness/diagnostics"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionCoordinator, forkSession } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createFileBackedSessionQuery, type SessionQuery } from "@i-harness/session-query"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import type { SessionAssembly, SessionServiceOptions } from "@i-harness/session-executor"
import type { SandboxMode } from "@i-harness/sandbox"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import { createGitProbeForStore, RewindService } from "@i-harness/rewind"
import { createSdkServer } from "@i-harness/sdk/server"
import { createBoundedWriter, DEFAULT_WRITE_BOUND_BYTES, type SessionListEntry, type SessionModelSelection } from "@i-harness/sdk"
import { createAcpServer } from "@i-harness/acp"
import { CLI_VERSION } from "./version.ts"
import { loadProviderRuntime, roleModelOptionsFor, roleModelResolverFor } from "./provider-runtime.ts"
import { listStoredSessions, runSessionsCommand } from "./sessions.ts"
import { runHooksCommand } from "./hooks.ts"
import { runPluginsCommand } from "./plugins.ts"
import { PROVIDER_PROTOCOLS, runProviderCommand, type CliProtocol } from "./provider.ts"
import { runModelsCommand } from "./models.ts"
import { runRolesCommand } from "./roles.ts"
import { failureReport, diagnosticSessionId } from "./run.ts"

// W6 T5: the phase handles this file's call sites log through.
//
// MODULE SCOPE, never a parameter: `diagnosticsFor` re-reads the installed
// instance on EVERY call, so a handle taken here — at import time, long before
// any entry body runs — is a live view rather than a snapshot (the ambient
// handle's contract, packages/diagnostics). ONE handle per phase this file
// reports under: `cli` for the argv/flag refusals and this entry's own
// reporters, `run` for the run's own failure report below (the phase is the
// run whose outcome the message carries), `sdk` for the sdk host's runtime
// (its two messages carry the `[i-harness sdk]` tag).
const d = diagnosticsFor("cli")
const runD = diagnosticsFor("run")
const sdkD = diagnosticsFor("sdk")

// M3 fail-loud. An UNHANDLED error is reported with the session it interrupted,
// instead of as a bare stack trace that names no run — M3's completion definition
// is that a failed run can be located "不需要人手讀 JSONL".
//
// It lives HERE, at the process entry, because exiting is correct here and is not
// correct in a library: `runHeadless` publishes the in-flight session id for
// exactly this reader and must not call `process.exit` itself.
//
// Exiting matches Node's own default — `unhandledRejection` has been fatal since
// v15 and `uncaughtException` always was. What changes is what the reader is TOLD.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err: unknown) => {
    d.error(failureReport(err, { sessionId: diagnosticSessionId(), kind: "crashed" }))
    process.exit(1)
  })
}

// M65 T1: the frontends are gone, so USAGE advertises only the backend
// surface — and it no longer describes a bare-launch default, because there is
// none (see the fall-through at the end of the dispatch chain). The
// `--sandbox read-only|workspace-write|danger-full-access` token is
// test-pinned (bin.test.ts's M62 block) and stays verbatim.
const USAGE =
  "usage: i-harness [<run|sdk|acp|sessions|hooks|provider|models|roles|plugins> ...]\n" +
  "  run <task> [--model provider:model --api-key KEY] [--protocol P (not with --model)] [--yes] [--session-dir DIR] [--resume ID] [--telemetry] [--sandbox read-only|workspace-write|danger-full-access] |\n" +
  "  sdk [--session-dir DIR] | acp [--session-dir DIR] [--no-auto-approve] |\n" +
  "  sessions [list] [--session-dir DIR] [--json] | sessions show <id> [--last N] |\n" +
  "  hooks <list|approve|revoke> [sha256] |\n" +
  "  provider <list|add|set|key|rm> | models <list|probe|add|set|rm|use|refresh> | roles <list|set|unset> |\n" +
  "  plugins [list] [--json]"

export { runHeadless } from "./run.ts"
export type { HeadlessOptions, HeadlessResult } from "./run.ts"

// M31: no hardcoded model catalogs — gemini/bedrock built-in profiles keep
// only the config template (protocol/defaultModel); `models: []` + no
// `modelContexts`. The model list comes from the user settings (spec §2.3 —
// nothing is preset by the CLI).
export function parseModel(modelSpec: string, apiKey: string): ModelClient {
  const [provider, model] = modelSpec.split(":")
  const reg = createProviderRegistry()
  // built-in convenience profiles so the CLI keeps working without user config
  reg.register({ name: "openai", displayName: "OpenAI", protocol: "openai-responses", apiKey, models: [], defaultModel: "gpt-4o" })
  reg.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey, models: [], defaultModel: "deepseek-chat" })
  reg.register({ name: "anthropic", displayName: "Anthropic", protocol: "anthropic-messages", apiKey, models: [], defaultModel: "claude-3-5-sonnet-latest" })
  reg.register({ name: "gemini", displayName: "Google Gemini", protocol: "gemini", apiKey, models: [], defaultModel: "gemini-2.5-pro" })
  reg.register({ name: "bedrock", displayName: "Amazon Bedrock", protocol: "bedrock", models: [], defaultModel: "anthropic.claude-3-5-sonnet-20241022" })
  const profile = reg.get(provider ?? "")
  if (!profile) throw new Error(`unknown model provider: ${provider}`)
  return buildModelClient(profile, model)
}

function providerModelBindingFor(runtime: ProviderRuntime): SessionServiceOptions["modelBindingFor"] {
  return async (_sessionId, meta) => {
    const state = await runtime.resolveModel({
      ...(meta?.modelSelection !== undefined
        ? { sessionSelection: meta.modelSelection }
        : {}),
    })
    if (state.status !== "ready") return state
    const { client, ...binding } = state.binding
    return { status: "ready", binding: { model: client, ...binding } }
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)
  // M29: --session-backend is removed — JSONL is the only persistence backend
  // and the search index is derived from it (reconcile-on-search). Fail loud
  // instead of silently ignoring the old flag.
  if (args.includes("--session-backend")) {
    d.error("--session-backend is removed (M29: JSONL-only persistence; the search index derives from the store)")
    return Promise.resolve(1)
  }
  // R-C4 sdk subcommand: NDJSON JSON-RPC 2.0 stdio server (hosted by the
  // SessionService). stdout carries ONLY protocol frames — every log goes to
  // stderr. `i-harness sdk [--session-dir DIR]`
  if (args[0] === "sdk") {
    return runSdkCommand(args)
  }
  // M61: the durable session store's CLI face — list the sessions the agent
  // persisted and print a transcript of one (read-only; shares the store root
  // with the run/sdk/acp paths).
  if (args[0] === "sessions") {
    return runSessionsCommand(args)
  }
  // D1's grant surface. The RULE lives in @i-harness/hooks; without a way to
  // GRANT, a plugin's declared hook was permanently ungranted — so the rule was
  // complete and unusable. This is the CLI's own reason for existing (the
  // development/test harness), not a product surface: the frontend will grow its
  // own, against the same store.
  if (args[0] === "hooks") {
    return runHooksCommand(args)
  }
  // The provider lifecycle's route tree
  // (docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md §4). Same
  // reason as `hooks`: M65 left seven ProviderRuntime methods with no caller.
  if (args[0] === "provider") {
    return runProviderCommand(args)
  }
  // The provider lifecycle's model tree — the second half of §4. Its verbs are
  // where `probeModels` / `addModels` / `setModel` / `removeModel` /
  // `discoverModels` / `setDefaultModel` got their first callers; `probe` is
  // the only one that touches the network and it writes NOTHING.
  if (args[0] === "models") {
    return runModelsCommand(args)
  }
  // The role tree — which model each of the four built-in sub-agent roles runs
  // on (docs/superpowers/specs/2026-09-19-agent-roles-design.md §8). It is the
  // surface `agents.roles` and Task 4's gate were landed FOR, and the verb the
  // gate's refusal message already tells the user to run.
  if (args[0] === "roles") {
    return runRolesCommand(args)
  }
  // The plugin registry's report face (owner ruling 2026-09-21, M6 precedent
  // synthesis #8). The registry's state/catalog/readiness vocabulary had ZERO
  // production consumers since the frontends were removed, and that
  // invisibility is what let every plugin MCP server fail to mount for a week
  // with one warn line as its only trace. READ-ONLY by construction: the
  // lifecycle verbs are a separate decision, and this dispatch reaches only the
  // list command.
  if (args[0] === "plugins") {
    return runPluginsCommand(args)
  }
  // R-C7 acp subcommand: official-ACP (v1) stdio server over the SessionService.
  // Same stdout discipline as `sdk` — ONLY ACP NDJSON frames on stdout.
  if (args[0] === "acp") {
    return runAcpCommand(args)
  }
  // Hidden dist self-check (M55 — scripts/verify-dist.mjs drives it): the
  // windows-acl confinement the bundle must serve WITHOUT a source
  // checkout/tsx. Exit 0 only when every probe passed. Deliberately not in
  // USAGE (a build gate, not a user command).
  if (args[0] === "__dist-selfcheck") {
    return runDistSelfcheck()
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(CLI_VERSION)
    return Promise.resolve(0)
  }
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.error(USAGE)
    return Promise.resolve(0)
  }
  // M65 T1: the pre-M44 fall-through, restored in shape verbatim
  // (`db3d1e7^:apps/cli/src/index.ts`). M44 replaced it with the grok-style
  // default, which launched the TUI for a bare `i-harness` or for any first
  // token that was not a subcommand. The frontends are gone, so an absent or
  // unknown subcommand is a usage error again: usage on stderr, exit 1.
  if (args[0] !== "run") {
    d.error(USAGE)
    return Promise.resolve(1)
  }

  // M1 Phase B: a FLAG must never become the prompt. `--help`/`-h` are handled at
  // :165-168 as `args[0]` only, so `i-harness run --help` fell through to the
  // filter at :384-388 -- which knows only the flags it strips (it read "seven" until 2026-09-15; the list at :385 carries nine names) -- and
  // reached runHeadless as a real turn whose prompt was "--help". The same hole
  // sent `--no-compact` (parsed at :257, absent from that filter) into the prompt
  // as `do x --no-compact`.
  //
  // The TOP-LEVEL `help`/`--help`/`-h` command at :165-168 is deliberately left
  // alone -- it is test-pinned as the documentation surface (bin.test.ts:36-49,
  // and ":75-78" forces a new run flag to appear in it). The run path gets no
  // `--help` case for a different reason: `--help` AFTER `run` is not a help
  // request, it is an unrecognised flag, and unrecognised flags are errors here.
  // That mirrors the file's own fail-loud stance (`--session-backend`: ":105-108";
  // `--resume`: ":308-311") rather than inventing a second help contract.
  // M65 T1 renumbered every citation in this comment: the frontend removal
  // deleted ~50 lines ABOVE it and this note adds three, so the targets below
  // moved and every number here was re-derived from the file, not guessed.
  // Protocol-selection phase B task 5 moved them once more (the `--protocol`
  // block below); every number above, including the count, was re-measured
  // after that edit, the same way.
  // `--protocol` takes a VALUE, so it is in BOTH sets below. The two sets are
  // what the guard reads; the task filter further down spells the same two lists
  // out again, and a flag missing from EITHER chain there leaks into the prompt
  // (the `--no-compact` defect: `run "do x" --no-compact` sent the model
  // `do x --no-compact`).
  const RUN_FLAGS = new Set(["--model", "--api-key", "--yes", "--session-dir", "--resume", "--telemetry", "--sandbox", "--no-compact", "--protocol"])
  const RUN_VALUE_FLAGS = new Set(["--model", "--api-key", "--session-dir", "--resume", "--sandbox", "--protocol"])
  const runArgs = args.slice(1)
  for (let i = 0; i < runArgs.length; i += 1) {
    const a = runArgs[i]!
    if (RUN_FLAGS.has(a)) continue
    if (i > 0 && RUN_VALUE_FLAGS.has(runArgs[i - 1]!)) continue
    if (a.startsWith("-")) {
      d.error(`i-harness run: unknown flag ${a} (a flag-like token would otherwise become the prompt)\n${USAGE}`)
      return Promise.resolve(1)
    }
  }

  // §4.3 (protocol-selection design): `run --protocol P` — THIS session runs on
  // wire P and P is written to NO file. Validated HERE, OUTSIDE the settings
  // chain: routing the value through the settings normalizer would FILL IN a
  // default, and that silent tail is exactly what phase A removed. The refusal
  // is `provider add`'s verbatim — the set named by content, never a default.
  const protocolIdx = args.indexOf("--protocol")
  let protocol: CliProtocol | undefined
  if (protocolIdx !== -1) {
    const value = args[protocolIdx + 1]
    if (value === undefined) {
      d.error(`--protocol requires one of: ${PROVIDER_PROTOCOLS.join(" | ")}`)
      return Promise.resolve(1)
    }
    if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(value)) {
      d.error(`unknown protocol "${value}"; expected one of: ${PROVIDER_PROTOCOLS.join(" | ")}`)
      return Promise.resolve(1)
    }
    // `--model` builds its client from the flag's own route and never enters
    // the settings chain, so there is no session selection for the protocol to
    // ride. The combination is REFUSED rather than accepted-and-dropped: a
    // silently unused protocol is the degradation this design removed.
    if (args.includes("--model")) {
      d.error("--protocol cannot be combined with --model (--model builds its client outside the settings chain, so there is no session selection for --protocol to ride)")
      return Promise.resolve(1)
    }
    protocol = value as CliProtocol
  }

  const yes = args.includes("--yes")
  // M62: `--sandbox` is the headless face of `settings.sandboxMode`. Measured
  // gap this closes: HeadlessOptions.sandbox was read from the caller and the
  // CLI could not supply it, so `i-harness run` — the ONLY remaining interface
  // that executes shells — always ran with sandbox unset, i.e. unconfined, no
  // matter what settings.json said. `web` was wired in 891db14 and the TUI had
  // its own path (M65 T1 deleted both); this is the last one.
  //
  // Resolved HERE rather than inside runHeadless on purpose: HeadlessOptions
  // stays an embedder contract where unset means "no sandbox requested", so the
  // hidden __dist-selfcheck and the exported API keep their meaning.
  const sandboxIdx = args.indexOf("--sandbox")
  const noCompact = args.includes("--no-compact")
  let sandboxMode: SandboxMode | undefined
  // Load BEFORE reading either knob: an UNLOADED SettingsStore answers get() with
  // DEFAULTS, so skipping this would silently ignore the operator's file (the same
  // trap the web fix hit — see docs/audit/2026-09-10-m62-web-sandbox-not-wired.md).
  // Loaded once for both, rather than per-knob.
  const { SettingsStore } = await import("@i-harness/settings")
  const settings = new SettingsStore()
  await settings.load()
  if (sandboxIdx !== -1) {
    const value = args[sandboxIdx + 1]
    const allowed: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]
    if (value === undefined || !(allowed as readonly string[]).includes(value)) {
      // Never coerce a typo to a default: `--sandbox readonly` silently meaning
      // workspace-write is exactly the false assurance the web fix removed.
      d.error(`--sandbox requires one of: ${allowed.join(" | ")}`)
      return Promise.resolve(1)
    }
    sandboxMode = value as SandboxMode
  } else {
    sandboxMode = settings.get().sandboxMode
  }
  // M11 wired at last. `HeadlessOptions.compact` existed and `runHeadless` would
  // have threaded it, but nothing ever SET it, so on every shipped path the
  // compaction engine was never constructed: pressure never triggered a summary
  // and the three-layer budget ladder ran with its first layer dead, falling
  // through to the fail-closed `prompt_too_long`. Manual `/compact` answered
  // "No compactable history yet." for the same reason.
  //
  // This is the deliberate sibling of the `--sandbox` resolution above, and it
  // resolves HERE for the same reason: `HeadlessOptions` stays an embedder
  // contract where unset means "no compaction requested", so the exported API and
  // the hidden __dist-selfcheck keep their meaning.
  const compactAuto = noCompact ? false : settings.get().compaction.auto
  // M25: --telemetry enables the independent host event stream (stdout JSONL
  // sink, assembled in run.ts). Default OFF; I_HARNESS_TELEMETRY=1 is the
  // env-var equivalent.
  const telemetry = args.includes("--telemetry") || process.env.I_HARNESS_TELEMETRY === "1"
  const modelIdx = args.indexOf("--model")
  const keyIdx = args.indexOf("--api-key")
  const sessionDirIdx = args.indexOf("--session-dir")
  const resumeIdx = args.indexOf("--resume")

  // `--resume` without a store used to be a SILENT no-op: the id was parsed
  // only inside the `--session-dir` branch below, so the flag was ignored and
  // the run proceeded as a FRESH conversation with exit 0 — the worst shape of
  // failure, because the caller believes the earlier context was restored.
  // Measured: with a store the telemetry's session/start carries the restored
  // `sessionId`; without one the field is absent entirely. A run is ephemeral
  // by design (no store root means no jsonl, no ownership lease), so resuming
  // simply has nothing to resume FROM — say so instead of pretending.
  if (resumeIdx !== -1 && sessionDirIdx === -1) {
    d.error("--resume requires --session-dir DIR (headless runs are ephemeral without a store)")
    return Promise.resolve(1)
  }

  // persistence wiring (M29: JSONL-only — locked under the store root).
  let coordinator: SessionCoordinator | undefined
  let sessionId: string | undefined
  let resumeSessionId: string | undefined
  if (sessionDirIdx !== -1) {
    const dir = args[sessionDirIdx + 1]
    if (!dir) {
      d.error("--session-dir requires a directory")
      return Promise.resolve(1)
    }
    // M23: the CLI opts into the session ownership lease with lockRoot = the
    // session STORE directory — lock files share the store's lifecycle, and a
    // conflicting live writer fails the create below (fail-closed) instead of
    // silently double-writing.
    coordinator = createSessionCoordinator(createJsonlBackend(dir), { lock: { enabled: true, lockRoot: dir } })
    if (resumeIdx !== -1) {
      resumeSessionId = args[resumeIdx + 1]
      if (!resumeSessionId) {
        d.error("--resume requires a session id")
        return Promise.resolve(1)
      }
    } else {
      try {
        const { id } = await coordinator.create()
        sessionId = id
      } catch (err) {
        // M23: with the lock enabled, create() fails closed —
        // SessionLockConflictError (another live writer owns the lease, message
        // carries the lock path + deadline diagnostics) or
        // SessionLockUnsupportedError off-Windows (M24 boundary). Surface the
        // message cleanly (exitCode 1) instead of an unhandled rejection.
        d.error(err instanceof Error ? err.message : String(err))
        return Promise.resolve(1)
      }
    }
  }

  // M29: the search/lineage surface mounts out of the box once the STORE ROOT
  // is known — a file-backed query derives from the jsonl store
  // (reconcile-on-search; default :memory: index, process-private).
  let sessionQuery: SessionQuery | undefined
  if (sessionDirIdx !== -1 && args[sessionDirIdx + 1] !== undefined) {
    sessionQuery = createFileBackedSessionQuery({ storeRoot: args[sessionDirIdx + 1]! })
  }

  // --model requires --api-key: fail loud rather than silently falling back.
  // M30: bedrock is key-less by design (AWS credential chain) — the key
  // requirement is exempted for the bedrock route only.
  let model: ModelClient | undefined
  if (modelIdx !== -1) {
    const modelSpec = args[modelIdx + 1]
    const apiKey = args[keyIdx + 1]
    const needsApiKey = modelSpec?.split(":")[0] !== "bedrock"
    if (!modelSpec || (needsApiKey && (keyIdx === -1 || !apiKey))) {
      d.error("--model requires --api-key KEY")
      return Promise.resolve(1)
    }
    try {
      model = parseModel(modelSpec, apiKey ?? "")
    } catch (err) {
      d.error(err instanceof Error ? err.message : String(err))
      return Promise.resolve(1)
    }
  }

  // task = everything after the "run" command, excluding flag tokens/values.
  // TWO chains, because a value-taking flag has two tokens to remove: the flag
  // itself, and the value after it. `--protocol` must be in BOTH, like every
  // other member of `RUN_VALUE_FLAGS` above — a member missing from chain 1
  // reaches the model as task text (the `--no-compact` defect this test file
  // pins), and one missing from chain 2 leaks its VALUE.
  const taskArgs = args.slice(1).filter((a, i) => {
    if (a === "--model" || a === "--api-key" || a === "--yes" || a === "--session-dir" || a === "--resume" || a === "--telemetry" || a === "--sandbox" || a === "--no-compact" || a === "--protocol") return false
    const prev = args.slice(1)[i - 1]
    return prev !== "--model" && prev !== "--api-key" && prev !== "--session-dir" && prev !== "--resume" && prev !== "--sandbox" && prev !== "--protocol"
  })
  const task = taskArgs.join(" ")
  if (!task) {
    d.error("usage: i-harness run <task> [--model provider:model --api-key KEY] [--protocol P (not with --model)] [--yes] [--session-dir DIR] [--resume ID] [--telemetry] [--sandbox read-only|workspace-write|danger-full-access]")
    return Promise.resolve(1)
  }

  const opts: HeadlessOptions = {
    workspace: process.cwd(),
    approveAll: yes,
    modelPolicy: "required",
    // The rule the (M65-deleted) web path established: explicit flag wins,
    // otherwise the operator's setting.
    sandbox: sandboxMode,
    // The window is NOT supplied here — `runHeadless` resolves the model binding
    // and the assembly fills it in. See the resolution above.
    compact: { auto: compactAuto },
    // `agents.roles.<name>` + `plugins.subagentModel`, from the store loaded
    // above. `roleSelectionFor` is a GETTER over the store, never a snapshot of
    // it — the selection is read at SPAWN time, so an edit applies to the next
    // spawn without restarting the run — while `plugins.subagentModel` is read
    // ONCE here, per dispatch, like every other flag this command passes. The
    // same loaded-before-read trap the sandbox knob documents: an unloaded store
    // answers with defaults.
    ...roleModelOptionsFor(settings),
  }
  if (model) opts.model = model
  if (telemetry) opts.telemetry = "jsonl"
  if (protocol !== undefined) {
    // §4.3: the ONE-SHOT selection. `--protocol P` rides THIS session's model
    // resolution and is written to NO file. It is composed here, in the CLI,
    // because a protocol has nowhere to ride without a provider:model under it
    // and `llm.defaultModel` is the rung the chain would otherwise use — the
    // store is loaded above (an unloaded one answers with defaults). run.ts
    // layers this on top of a resumed session's durable selection, the caller's
    // protocol being the most specific rung of selection > model row > route.
    // A `--model` run never reaches here; that combination is refused above.
    opts.sessionSelection = { ...settings.get().llm.defaultModel, protocol }
  }
  if (coordinator) {
    opts.coordinator = coordinator
    if (sessionId) opts.sessionId = sessionId
    if (resumeSessionId) opts.resumeSessionId = resumeSessionId
  }
  if (sessionQuery) opts.sessionQuery = sessionQuery
  // W6 T4: the CLI's own diagnostics instance, installed for the run this
  // command is about to start. The three hosts install their own — this is the
  // run path's, and `runSdkCommand`/`runAcpCommand` below are the other two.
  //
  // WHERE IT GOES, and why nothing earlier: the flags above are refused through
  // the module-scope handles at the top of this file — T5 migrated them, and the
  // help usage among them is one of the plan's named exceptions (it stays a
  // plain console call) — and a run refused during parsing has no run to
  // instrument. The `finally` below is the ONE teardown
  // for every way `runHeadless` can end: the four returns (a failed resume, a
  // failed assembly, success, a failed run) and a rejection alike.
  //
  // The redactor's second source (settings' `llm.providers[*].apiKeyEnv`) is NOT
  // fed here on purpose: the credential store `loadProviderRuntime()` builds
  // does not exist until the run needs a model, so `run.ts` feeds it there — see
  // the bootstrap's header.
  const boot = createCliDiagnostics()
  try {
    return await runHeadless(task, opts).then((r) => {
      if (r.finalText) console.log(r.finalText)
      // M3 diagnose-ability: a failed run used to print `r.error` — ONE bare line
      // naming no session and saying nothing about what survived. It now gets the
      // same report an unhandled crash gets, because it is the same question.
      // Phase `run` (R10): T4's four exit-path cases used to read the installed
      // instance out of a spy on this very console call, which made a test's
      // capture hook into a product constraint; they now read the instance where
      // it is built, and this site reports like every other one.
      if (r.error) runD.error(failureReport(r.error, { ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}), kind: "failed" }))
      return r.exitCode
    })
  } finally {
    // close() releases the instance AND detaches it; the uninstaller is the
    // slot's own pairing discipline (`installDiagnostics`'s contract). Both, so
    // neither a replaced slot nor a retained handle can outlive the entry.
    boot.diagnostics.close()
    boot.uninstall()
  }
}

/** Hidden `__dist-selfcheck` (see the dispatch in main()). Every probe drives
 * a PRODUCTION seam — the windows-acl confinement through
 * createWindowsAclSandbox — never a parallel re-implementation.
 * M65 T1 removed the three probes whose subject WAS the TUI: the inline engine
 * (probeMinimalHost), the /minimal relaunch argv (relaunchArgs /
 * defaultRelaunchArgv, printed here for verify-dist to execute) and the
 * --attach SDK spawn (spawnSdkSubprocess + buildSdkSpawnArgs) all lived in
 * @i-harness/tui-app, which is deleted. The confinement probe's subject still
 * exists and is kept.
 * Exit 0 only when every live probe passed. */
async function runDistSelfcheck(): Promise<number> {
  let failed = false
  const record = (label: string, error: unknown): void => {
    failed = true
    d.error(`dist-selfcheck: ${label} FAIL: ${error instanceof Error ? error.message : String(error)}`)
  }
  // The Windows-ACL sandbox seam: confine() must spawn the DIST runner
  // bundle and really confine (child exit mirrored). Windows-only surface —
  // on other platforms this is now the ONLY probe's skip line, so say so
  // rather than let the check read as a pass it did not earn.
  if (process.platform === "win32") {
    try {
      console.log(`acl-seam: ok (confined child exit=${await probeAclSeam()})`)
    } catch (error) {
      record("acl-seam", error)
    }
  } else {
    console.log("acl-seam: skipped (non-win32) — no probe remains on this platform")
  }
  console.log(`dist-selfcheck: ${failed ? "FAIL" : "PASS"}`)
  return failed ? 1 : 0
}

/** Confine a child through the REAL windows-acl seam (createWindowsAclSandbox
 * → confine) and mirror its exit code — proves the BUNDLED seam spawns the
 * sibling `runner.mjs`, not the source tsx entry. Returns the child exit. */
async function probeAclSeam(): Promise<number> {
  const { createWindowsAclSandbox } = await import("@i-harness/sandbox-windows-acl")
  const workspace = mkdtempSync(join(tmpdir(), "ih-dist-acl-"))
  try {
    const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "read-only" })
    try {
      const confined = provider.confine(
        [process.execPath, "-e", "process.exit(7)"],
        { mode: "read-only", workspaceRoot: workspace },
      )
      if (process.env.I_HARNESS_DIST === "1" && confined.argv.some((arg) => arg.includes("tsx"))) {
        throw new Error(`dist confinement still uses tsx: ${JSON.stringify(confined.argv.slice(0, 5))}`)
      }
      const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { stdio: "inherit", timeout: 120_000 })
      if (result.status !== 7) throw new Error(`confined child exit ${String(result.status)} (expected 7)`)
      return 7
    } finally {
      provider.dispose()
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** `i-harness sdk` — the SDK stdio server (R-C4). One NDJSON JSON-RPC line
 * per frame; every response/notification is written through onWrite so stdout
 * NEVER carries host logs (all diagnostics go to stderr). Exits cleanly when
 * the client ends stdin or issues shutdown. */
async function runSdkCommand(args: string[]): Promise<number> {
  const dirIdx = args.indexOf("--session-dir")
  let coordinator: SessionCoordinator | undefined
  let storeRoot: string | undefined
  if (dirIdx !== -1) {
    const dir = args[dirIdx + 1]
    if (dir === undefined || dir === "") {
      d.error("--session-dir requires a directory")
      return 1
    }
    storeRoot = dir
    coordinator = createSessionCoordinator(createJsonlBackend(dir), { lock: { enabled: true, lockRoot: dir } })
  }
  const { settings, credentials, runtime } = await loadProviderRuntime()
  // W6 T4: this host's diagnostics instance. It goes in HERE rather than before
  // the load because the redactor's second source needs BOTH halves of what
  // `loadProviderRuntime()` returns — the settings that name the refs and the
  // store that resolves them (see the bootstrap). Installing earlier would mean
  // feeding them late through module state, for no coverage gain: everything
  // above this line logs through the console directly (that is `--session-dir`
  // validation), so no record is being missed.
  const boot = createCliDiagnostics({ settings, credentials })
  const service = createSessionService({
    workspace: process.cwd(),
    modelPolicy: "required",
    modelBindingFor: providerModelBindingFor(runtime),
    resolveRoleModel: roleModelResolverFor(async () => runtime),
    // The role-model gate from the same settings store the runtime loaded —
    // `agents.roles.<name>` read live + `plugins.subagentModel`. Default false:
    // a session that never touches either key spawns roles exactly as before.
    ...roleModelOptionsFor(settings),
    ...(coordinator !== undefined ? { coordinator } : {}),
    ...(coordinator !== undefined ? { sessionFor: createDurableSessionLoader(coordinator) } : {}),
    ...(storeRoot !== undefined ? { sessionQuery: createFileBackedSessionQuery({ storeRoot }) } : {}),
    // M41b v1.1: rewind engine — the assembly creates the RewindStore +
    // RewindRecorder per session (keyed on sessionId) and records turns; the
    // rewindFactory below serves the rewind surface over that handle. Only
    // meaningful with a --session-dir (a store root to hang rewind/ under).
    ...(storeRoot !== undefined ? { rewindStoreRoot: storeRoot } : {}),
    ...(coordinator !== undefined
      ? {
          loadMeta: async (id: string) => (await coordinator.profile(id)).meta,
        }
      : {}),
    // Block ③ B1: the tool-output bound. `assembly.ts` mounts the guard only
    // when the option is present (`if (opts.outputSpill)` — absent = not
    // mounted), and before this line the ONLY opt-in in the tree was
    // runHeadless's, so this host's tool output was unbounded.
    outputSpill: {},
  })

  // M41b v1.1: the server-side rewind seam — mirror of the embedded bridge's
  // svcFor pattern: watch assemblies (the onAssembly hook fires once per live
  // assembly), then resolve the CURRENT assembly's rewind handle per request.
  // The RewindService is rebuilt per call over that handle (never cached — a
  // session switch must not serve a stale store), and the factory returns
  // undefined (→ -32603 "rewind not enabled" on the wire) for an assembly
  // built without rewind or a session this process never opened.
  const liveAssemblies = new Map<string, SessionAssembly>()
  service.onAssembly((assembly) => {
    if (assembly.sessionId !== undefined) liveAssemblies.set(assembly.sessionId, assembly)
  })
  const workspaceRoot = process.cwd()
  const rewindFor = (sessionId: string) => {
    const assembly = liveAssemblies.get(sessionId)
    if (assembly === undefined || assembly.rewind === undefined) return undefined
    const svc = new RewindService({
      store: assembly.rewind.store,
      workspace: workspaceRoot,
      // M58 R-B4 A: read-only git cross-check for plan().unseen.
      gitProbe: createGitProbeForStore(assembly.rewind.store, workspaceRoot),
    })
    return {
      points: async () => ({
        points: (await svc.points()).map((p) => ({ turnIndex: p.turnIndex, preview: p.preview, files: p.files })),
      }),
      plan: async (target: number, mode: "all" | "files" | "conversation") => {
        const plan = await svc.plan(target, mode)
        // wire FileOp mirrors the engine FileOp minus the blob id (strip)
        return {
          clean: plan.clean.map((f) => ({ path: f.path, op: f.kind })),
          conflicts: plan.conflicts,
          unTracked: plan.unTracked,
          ops: plan.ops.map((f) => ({ path: f.path, op: f.kind })),
          // M58 R-B4 A: the read-only git evidence rides the wire additively.
          ...(plan.unseen !== undefined ? { unseen: plan.unseen } : {}),
        }
      },
      execute: async (target: number, mode: "all" | "files" | "conversation", hooks: { appendEvent: (ev: unknown) => void }) => {
        const result = await svc.execute(target, mode, { appendEvent: (ev) => hooks.appendEvent(ev) })
        return {
          revertedFiles: result.revertedFiles,
          conflicts: result.conflicts,
          ...(result.errors.length > 0
            ? { error: result.errors.map((e) => `${e.path}: ${e.message}`).join("; ") }
            : {}),
        }
      },
    }
  }

  const rl = createInterface({ input: process.stdin, terminal: false })
  // M68 batch A: the outbound bound. onWrite() is called SYNCHRONOUSLY from the
  // server for every frame (responses AND one notification per appended event),
  // so the queue and its bound live HERE, between that call and stdout: in-bound
  // the frames are byte-identical to the pre-M68 path; at the bound the writer
  // writes ONE SERVER_OVERLOAD frame (id: null) and ends stdout — a slow client
  // is cut visibly and recovers via session/history, instead of growing this
  // process's heap invisibly.
  const writer = createBoundedWriter({
    write: (chunk) => process.stdout.write(chunk),
    end: () => process.stdout.end(),
    onDrain: (cb) => {
      process.stdout.once("drain", cb)
      return () => { process.stdout.off("drain", cb) }
    },
    boundBytes: DEFAULT_WRITE_BOUND_BYTES,
  })
  const server = createSdkServer(service, {
    coordinator,
    ...(coordinator !== undefined
      ? {
          createSession: async () => {
            const { id } = await coordinator.create()
            return { sessionId: id }
          },
          forkSession: async (sessionId: string) => {
            await coordinator.flush(sessionId)
            const result = await forkSession(coordinator, sessionId)
            return { sessionId: result.sessionId }
          },
          modelState: async (sessionId: string) => {
            const known = service.hasAssembly(sessionId) || (await coordinator.list()).includes(sessionId)
            if (!known) throw new Error(`session not found: ${sessionId}`)
            return service.modelState(sessionId)
          },
          setSessionModel: async (sessionId: string, selection: SessionModelSelection) => {
            const known = service.hasAssembly(sessionId) || (await coordinator.list()).includes(sessionId)
            if (!known) throw new Error(`session not found: ${sessionId}`)
            // Task 4 (§4.2②): the wire's `protocol` is for the REBIND only.
            // Validate it against the five BEFORE it can reach the resolution
            // chain — an unknown value is refused loudly, the same rule
            // `provider add`/`models set` use for their --protocol. Dropping it
            // silently would report "ready" for a wire the caller named and did
            // not get; letting it through would put an unresolvable string into
            // the chain and misreport the refusal as a route problem.
            const protocol = selection.protocol
            if (protocol !== undefined && !(PROVIDER_PROTOCOLS as readonly string[]).includes(protocol)) {
              throw new Error(`unknown protocol "${protocol}"; expected one of: ${PROVIDER_PROTOCOLS.join(" | ")}`)
            }
            // Resolve FIRST — a selection that cannot be resolved is refused
            // before anything is written. The old order wrote the meta first
            // and leaned on a teardown to make it take effect, so an
            // unresolvable selection still landed durably, naming a model
            // nothing live would use.
            const resolved = await runtime.resolveModel({
              sessionSelection: {
                provider: selection.provider,
                model: selection.model,
                ...(protocol !== undefined ? { protocol: protocol as CliProtocol } : {}),
                ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
              },
            })
            if (resolved.status !== "ready") throw new Error(resolved.reason)
            const { client, ...binding } = resolved.binding
            // The LIVE rebind: the session's handle forwards to this client now
            // (every handle-reachable holder follows), and the service refreshes
            // the reported binding + label in the same call (F1 — without this,
            // modelState and the dashboard row would keep naming the pre-rebind
            // model).
            service.rebindModel(sessionId, { model: client, ...binding })
            // §4.3: the DURABLE selection never carries the protocol. It is
            // stripped HERE — after the rebind, before anything writes — which
            // is the half the sdk-wire guard pins.
            await coordinator.updateMeta(sessionId, {
              modelSelection: {
                provider: selection.provider,
                model: selection.model,
                ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
              },
            })
          },
        }
      : {}),
    // M41b v1.1: the rewind seam (wire-level "session-rewind" capability).
    // Present only with --session-dir (the assembly-side rewindStoreRoot chain
    // above); without it, every rewind method answers "rewind not enabled".
    ...(storeRoot !== undefined ? { rewindFactory: rewindFor } : {}),
    // M41a v1: session/list source — the store listing. M61: the ONE listing
    // implementation (shared with `i-harness sessions`) — a single corrupt or
    // missing file settles to a labelled row instead of failing the list, and
    // the failure is loud on stderr (stdout carries protocol frames only).
    listSessions:
      coordinator === undefined
        ? undefined
        : async () => {
            const rows = await listStoredSessions(coordinator, storeRoot!)
            for (const row of rows) {
              if (row.problem !== undefined) sdkD.error(`[i-harness sdk] session list: "${row.id}": ${row.problem}`)
            }
            const sessions: SessionListEntry[] = rows.map((row) => ({
              id: row.id,
              ...(row.title !== undefined ? { title: row.title } : {}),
              ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
              ...(row.turnCount !== undefined ? { turnCount: row.turnCount } : {}),
            }))
            return { sessions }
          },
    onWrite: (message) => writer.push(message),
    onShutdown: () => rl.close(),
  })

  let teardownPromise: Promise<void> | undefined
  const teardown = (): Promise<void> => teardownPromise ??= (async () => {
    rl.close()
    await server.close()
    await service.close()
    if (coordinator !== undefined) await coordinator.close()
    // W6 T4: LAST, so the closes above still reach the record — a closed
    // instance takes no further records — and so terminating this host leaves no
    // installed instance behind (the process may outlive the command in tests).
    boot.diagnostics.close()
    boot.uninstall()
  })()
  rl.on("close", () => { void teardown() })
  const onSignal = (): void => { void teardown() }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  rl.on("line", (line) => {
    void server.handleLine(line).catch((error: unknown) => {
      // The pre-T5 call passed TWO console arguments (the label, then this
      // string). The handle takes ONE message, and the second argument cannot
      // become `data` — that slot is a record, and delegation drops it, which
      // would lose the text. So the two are folded into one template, and the
      // stderr bytes are unchanged: Node joins multiple console arguments with a
      // single space, and both branches of the expression below are strings.
      sdkD.error(`[i-harness sdk] loop error: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  // The process lives until the client ends the stdio (or SIGINT), then 0.
  return new Promise<number>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      void teardown().then(() => resolve(0))
    }
    rl.on("close", finish)
  })
}

/** `i-harness acp` — the official-ACP (v1) stdio server (R-C7). The
 * @agentclientprotocol/sdk ndJsonStream is the NDJSON JSON-RPC loop over
 * process stdin/stdout (Web-stream adapted); stdout carries ONLY ACP frames.
 * Version-same flags as `sdk`; `--no-auto-approve` switches the v0 permission
 * face to refuse-prompts (fail-closed) instead of allow-once. */
async function runAcpCommand(args: string[]): Promise<number> {
  const dirIdx = args.indexOf("--session-dir")
  let coordinator: SessionCoordinator | undefined
  let storeRoot: string | undefined
  if (dirIdx !== -1) {
    const dir = args[dirIdx + 1]
    if (dir === undefined || dir === "") {
      d.error("--session-dir requires a directory")
      return 1
    }
    storeRoot = dir
    coordinator = createSessionCoordinator(createJsonlBackend(dir), { lock: { enabled: true, lockRoot: dir } })
  }
  const { settings, credentials, runtime } = await loadProviderRuntime()
  // W6 T4: same seam as the sdk path above, same reason — see there.
  const boot = createCliDiagnostics({ settings, credentials })
  const service = createSessionService({
    workspace: process.cwd(),
    modelPolicy: "required",
    modelBindingFor: providerModelBindingFor(runtime),
    resolveRoleModel: roleModelResolverFor(async () => runtime),
    // Same two options as the sdk path, from the same store — see there.
    ...roleModelOptionsFor(settings),
    ...(coordinator !== undefined ? { coordinator } : {}),
    ...(coordinator !== undefined ? { sessionFor: createDurableSessionLoader(coordinator) } : {}),
    ...(storeRoot !== undefined ? { sessionQuery: createFileBackedSessionQuery({ storeRoot }) } : {}),
    ...(coordinator !== undefined
      ? {
          loadMeta: async (id: string) => (await coordinator.profile(id)).meta,
        }
      : {}),
    // Block ③ B1, same as the sdk path above: absent = not mounted, so this
    // host opts in explicitly.
    outputSpill: {},
  })
  const server = createAcpServer({
    service,
    ...(coordinator !== undefined ? { coordinator } : {}),
    autoApprove: !args.includes("--no-auto-approve"),
  })

  // The ACP transport: NDJSON in → NDJSON out (official SDK line loop).
  // The SDK's Stream types come from the DOM lib; Node's stream/web types are
  // structurally equivalent at runtime but not assignable there — cast at the
  // adaptor boundary (the stdio round-trip is verified by e2e).
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  const connection = server.connect(stream)

  let teardownPromise: Promise<void> | undefined
  const teardown = (): Promise<void> => teardownPromise ??= (async () => {
    connection.close()
    await service.close()
    if (coordinator !== undefined) await coordinator.close()
    // W6 T4: last, for the reason spelled out in the sdk path's teardown.
    boot.diagnostics.close()
    boot.uninstall()
  })()
  const onSignal = (): void => { void teardown() }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  // The process lives until the client ends the stdio (stream EOF closes the
  // connection) or SIGINT/SIGTERM, then 0.
  return new Promise<number>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      void teardown().then(() => resolve(0))
    }
    void connection.closed.then(finish, (error: unknown) => {
      process.stderr.write(
        `[i-harness acp] connection error: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      finish()
    })
  })
}

// Entry guard: invoke main only when this module is executed directly as the
// process entry point (e.g. `node --import tsx apps/cli/src/index.ts run "..."`),
// never when it is merely imported (tests, other modules). Both sides are
// compared as file:// URLs — a raw path string never equals a file URL, so
// comparing import.meta.url (a URL) to pathToFileURL(argv[1]).href holds on
// Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then(
    (code) => { process.exitCode = code },
    (error) => {
      d.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}
