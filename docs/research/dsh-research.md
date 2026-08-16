# DeepSeek Harness + Anchored-Standard Research Report

**Target project:** `D:\agent-complete\deepseek-harness-master` (+ `dsh-anchored-standard-main`)
**Date:** 2026-08-16

## Summary (5 lines)

DeepSeek Harness (`dsh`) is an **agent runtime**, not a test harness *for* agents — it boots real coding agents (Web UI, one-shot headless, ACP automation) from a fully plugin-based Cordis composition where the LLM adapter, tools, prompt assembly, sandbox, and even the agent loop are replaceable plugins. Its defining discipline is a **per-session "agent preset"** (a `cordis.yml` file mounted per agent) and a **generated, verified tool catalog** that all model-facing tool schemas flow through. The `dsh-anchored-standard` preset demonstrates a two-phase **bootstrap/promote** technique: shape request #1 with a minimal tool pair (and stripped context), then promote to a full 25-tool catalog after the first durable signal. The same concept was upstreamed into this checkout as the official `@deepseek-ai/dsh-tool-bootstrap` package under `packages/guard/`.

## 1. Core Concept — Harness or Agent?

**Verdict: it IS an agent, running inside a harness-shaped plugin runtime.** Evidence:

- `D:\agent-complete\deepseek-harness-master\README.md` — *"DeepSeek Harness (`dsh`) is an open-source agent harness developed by DeepSeek AI. It uses an architecture where **everything is a plugin**, and is powered by Cordis."*
- `D:\agent-complete\deepseek-harness-master\AGENTS.md` — *"DeepSeek Harness is a plugin-based agent harness on vendored Cordis: **everything is a plugin**."*
- `D:\agent-complete\deepseek-harness-master\docs\architecture.md` — *"Cordis is the framework under dsh: plugins contribute services, typed events, and reversible effects to a shared context. Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so every part is replaceable from configuration. There is no privileged core to patch."*

Running an agent "in" the harness means: `dsh web` serves a chat/Web app at `http://127.0.0.1:3080` where a session works a workspace through tools; `dsh --profile headless "task"` (see `packages/bundle/headless/README.md`) creates one fresh persisted Agent, submits the task as an ordinary `user/message`, waits for quiescence, prints the final answer, exits 0/1. ACP mode (`packages/acp`) and JSON-RPC SDK (`packages/sdk`) expose the same agents to automation, so **evaluation/sandboxing/session-control are all internal features, not the product's purpose** — the product's purpose is to be the agent runtime itself.

**Session lifecycle** (`docs/architecture.md` "Turn flow" + `docs/agent-lifecycle.md` sequence diagram + `docs/subsystems/session.md`):
- A `Session` is an **append-only log** of typed `SessionEvent`s (`turn/start`, `step/start`, `user/message`, `assistant/chunk*`, `assistant/message`, `tool/call*`, `tool/result*`, `step/end`, `turn/end`). Model history is *derived* from the log (`deriveMessages()`), never stored separately; **model-visible ⟺ logged** is a runtime-invariant rule.
- A **step** = one model request plus the tool calls it makes. A **turn** = zero-or-more steps.
- Extension points are events: durable `session/event`, live `agent/*` events, and capability events; `agent/pre-step`, `agent/request`, `llm/stream`, and `tools/*` are waterfalls (listeners must call `next()`).
- Durability: JSONL and SQLite backends (`session-persistence-jsonl`/`-sqlite`) plus checkpoint policy; `SESSION_FORMAT_VERSION` at `0`, no back-compat promise (pre-release stance in `AGENTS.md`).

## 2. Architecture & Tech Stack

**Stack** (`root package.json`, `docs/development.md`):
- **pnpm workspace** (`pnpm@11.7.0`), ESM only, Node `^22.19.0 || >=24.0.0`, TypeScript `^6.0.3`, strict with `noImplicitAny`.
- Workspaces: `vendor/*` (vendored, rescoped Cordis), `packages/*/*`, `native/*`, `apps/*` (CLI + web), `website`.
- **tsdown** bundles; **tsx** runs source (`node --import tsx/esm`); **vitest** (`^4.1.8`) is the test runner: `test` (unit), `test:e2e` (real API, self-skip without `DEEPSEEK_API_KEY`), `test:snapshot` (keyless ACP/headless replay against recorded outputs — this is the "replay/eval" angle), `test:coverage` (per-file 100% gate), `test:web` (browser snapshot/perf/stress).
- **Host/client split** (`docs/development.md` "isolated Host and Client aggregates"): `tsconfig.host.json` (Node-side packages) and `tsconfig.client.json` (browser `packages/client/*`) are two separate `ts.Program` aggregates because both sides declaration-merge the Cordis `Context` interface under the same keys with different services — one program seeing both collides. The Web GUI is the "client half"; the `api-remotes` gateway (Typert RPC) bridges them.
- **`native/`** — `native/landlock-run/` is the **Landlock self-restrict-then-exec launcher** (Linux kernel-sandbox confinement) with an early-boot C entry (`native/landlock-run/packages/entry/src/main.c`) packaged per-platform as `linux-x64`/`linux-arm64` npm optional-dependency packages. It is *not* part of the anchored preset; on Windows dsh uses a `sandbox-local`/permission-presets stack instead (see `packages/bundle/base/cordis.patch.yml` lines 169–190: sandbox, sandbox-policy `workspace-write`, approval, permission presets).

**Package surface** (`packages/README.md`): ~30 groups, e.g. `core/` (session, system-prompt, tools, agent, agent-loop), `llm/` (LLM seam + DeepSeek adapters), `shell/`, `fs/` (+ sandbox), `sandbox/`, `terminal/`, `subagent/`, `preset/` (agent presets), `guard/` (loop hygiene + **tool-bootstrap**), `skill/` (skills registry/catalog/loader), `session/` (durable data plane), `sdk/`, `acp/`, `interaction/`, `boot/`. Every capability is a **seam**: Service Definition / Service Provider / Consumer (`docs/capability-seams.md` table lists all `ctx.*` keys, owners, implementations, consumers).

## 3. The "Anchored-Standard" Concept

Source: `D:\agent-complete\dsh-anchored-standard-main\README.md` + `preset\agent.cordis.yml` + `preset\tool-bootstrap.mjs`.

The insight (from community evaluation, issues #6/#11): **DeepSeek V4 Pro conditions strongly on the API-visible tool catalog on the first request.** Plain-text/standard schemas produced scores 91–92 vs 99–96 for the official `minimal` preset, but *permanently* staying Minimal gives up the broader Standard toolset. Anchored Standard "separates initial trajectory selection from later tool use" in **two phases**:

1. **Bootstrap (request #1):** the complete Minimal system prompt ("You are a helpful software engineer assistant." with `complete: true`), the Minimal preset's **real tool schemas** (`bash` persistent + `str_replace_editor`, byte-identical to `apps/cli/config/agent-presets/minimal/agent.cordis.yml`), and **no auto-injected context** — the AGENTS.md/CLAUDE.md digest (`source.kind: agent-instructions`) and skills reminder (`source.kind: skill-catalog`) are stripped. Evidence quote (`README.md`): *"the Minimal tool schema anchored 5/5 runs at the adapter-default maxTokens (256000) with zero `let me` first-lines, while every standard-family schema fell into standard-like behavior 11/11 — the tool schema is the decisive first-request variable at 256000, so no output cap is needed."*
2. **Promotion:** after the session records its first **durable promotion signal** — a `tool/call` or `assistant/message`, whichever first (`promoteOn: either`) — the full **Standard tool catalog** (~25 tools) and normal context injections are exposed. Phase is derived from durable session events, so resume/reload preserve it (`tool-bootstrap.mjs`: `isPromoted()` scans `session.events`, memoized per session id). Fail-safes: missing bootstrap tool degrades to full catalog with a one-time warning; context-filter bugs degrade to keeping everything; invalid config fails at preset mount.

A sibling mode (`zero-anchored-standard/`): request #1 carries **zero** tools (one fixed "tools not open yet" anchor turn) instead of two, as a comparison point — evidence that an extra model turn is needed since tool-bearing rounds return to standard-style behavior.

**Upstreaming:** this checkout (`deepseek-harness-master`, `0.1.0-rc.5`) already contains the *official* equivalent: `packages/guard/tool-bootstrap/README.md` and `src/index.ts` — same `bootstrapTools`/`promoteOn`/`suppressedContextSources`/`bootstrapMaxTokens` config, same waterfall listeners (`system-prompt/assemble` narrow, `agent/request` optional cap, `agent/pre-step` strip). The shipped `standard` agent preset (`apps/cli/config/agent-presets/standard/agent.cordis.yml`) now includes the bootstrap row as its first row. Note: the sibling checkout `D:\agent-complete\deepseek-harness\deepseek-harness-master` is an older snapshot — its `standard/agent.cordis.yml` has no bootstrap row and `packages/guard/` has no `tool-bootstrap`.

**Tool-catalog concept:** `docs/tool-catalog.md` is a **generated** catalog (regenerated by `pnpm run gen-tool-catalog`, gated by `verify-tool-catalog`) of every model-facing tool — name, description, JSON-Schema — registered into `ctx.tools`, produced by **booting each tool plugin on a real context** (schemas aren't statically knowable). A completeness guard fails if any `packages/*/tool-*` package is missing. This "tool catalog as first-class generated artifact" is the core capability model the bootstrap narrows at request time.

## 4. Tool Catalog / Capability Model — define, gate, promote

- **Define:** `ToolDefinition` (`packages/core/tools/src/index.ts`) = `ToolSchema` (name/description/parameters as JSON-Schema via `@deepseek-ai/schemastery`) + `output` (canonical lossless-JSON schema + render) + `execute(args, exec)` + optional `finalizeContent`, `timeoutMs`, `isConcurrencySafe`, `presentCall/presentResult` (UI render intent). Registration is `ctx.tools.register()` in a **scoped layer** (`ScopedLayers` — global or per-agent scope via `agent.ctx`); scoped registrations shadow globals; duplicates within a layer throw (this is why the anchored preset disables Standard's sandboxed `bash` row — both register `bash` into the same preset layer). `run_code` is a reserved transport outside filterable layers.
- **Gate (execution pipeline, `docs/tool-execution-pipeline.md`):** `tool/call` logged → `tools/pre-execute` waterfall (allow/deny/ask; approval seam) → **monotonic guards** (`tools.guard()`, deny-only, cannot be re-ordered into silence) → `tools/execute` around-dispatch (timeout/retry/metrics) → tool body → `fs/*` intent gates → `tools/post-execute` (replace/block/add context) → `finalizeContent` → `tools/result`. Restriction masks (`tools.restrict({allow, deny})`) are per-scope visibility filters; sandbox and approval are separate seams (`ctx.sandbox`, `ctx.approval`).
- **Promote (visibility at assembly):** tool schemas enter the model each request via `ctx.systemPrompt` ← `system-prompt/assemble` waterfall ← `ToolRuntime.wireSchemas(scope)` (in `packages/core/tools/src/index.ts`), which applies scope chain + `mode` (native/code/both). The bootstrap plugin is the outermost `system-prompt/assemble` transform that narrows this assembled view to `bootstrapTools` until promotion. So "gating" happens at two levels: **composition** (which tool plugins a preset mounts — `preset/agent.cordis.yml` rows) and **assembly-time narrowing** (bootstrap filter on request #1).

## 5. Concept Verdict

The project's "idea" is: **"An agent harness whose entire runtime is a Cordis plugin composition, with per-session agent presets as the unit of agent identity, a generated-and-verified model-facing tool catalog, and a two-phase 'anchored bootstrap → full catalog promotion' discipline that manipulates first-request tool schemas and injected context to steer an agent's opening trajectory before unlocking its full toolkit."** It is simultaneously (a) a complete, shippable AI coding-agent product (Web UI, headless, ACP), (b) an extension platform ("everything is a plugin", self-modification tools `cordis_*` allow the agent to inspect/mount its own plugins), and (c) an evaluation-target (snapshot replay infra, `modeltest` community methodology). The anchored-standard overlay is the cleanest demonstration of the "catalog as a first-class, controllable surface."

## 6. Strengths / Weaknesses as a BASE for "I-harness"

**Better as a foundation OUTSIDE the harness (concept source), not the harness as runtime:**

Strengths to borrow:
- **Per-session agent-preset composition** (`packages/preset/`) — one `agent.cordis.yml` per preset, mounted under an agent's scope with guards rejecting unusable rows or root-realm service leaks (`packages/preset/agent-presets/src/mount.ts`). This is the single most transferable idea for I-harness.
- **Capability seams** (Definition/Provider/Consumer) with swappable providers — filesystem/subprocess/sandbox/provider swap without touching tool layers.
- **Tool-catalog discipline** — generated catalog + completeness gate; strong precedent for making I-harness's tool surface a verified first-class artifact.
- **Waterfall extension points** (`agent/pre-step`, `system-prompt/assemble`, `tools/*`) with `next()` semantics — clean place to re-implement the bootstrap/promote phase.
- The **anchored-bootstrap/promotion** technique itself — a proven, evidence-backed mechanism (`tool-bootstrap.mjs` ~220 lines) that can be re-implemented in any agent framework; it needs only the three assembly seams, not dsh.
- Engineering rigor: 100% per-file coverage gate, snapshot replay, doc budgets, invariant checks.

Weaknesses / risks as the runtime for I-harness:
- **Heavyweight dependency**: pnpm monorepo, ~30 package groups + vendored Cordis + TS project-reference build graph; `pnpm install` + full `build` before any change. I-harness is a minimal `tsc --noEmit` + `node --test` template — adopting dsh means adopting its entire build/CI culture.
- **Developer preview with breaking changes**: "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" (`README.md`); `SESSION_FORMAT_VERSION` 0; AGENTS.md says "rename/repackage freely". The upstream `tool-bootstrap` README itself lists the risk: it relies on "developer-preview request-assembly seams ... that may change across Harness versions."
- **Locks you to its product model**: Harness home (`$DSH_HOME`), profiles/bundles, DeepSeek/OpenAI-compatible providers, Web UI + Browser client half. Using it *as* the runtime makes I-harness "a dsh preset" rather than "its own agent."
- **Windows caveats**: sandboxed bash disabled on Windows, persistent PTY bash unavailable on Windows (see `persistent-shell` `disabled: !!js process.platform === 'win32'` in `standard/agent.cordis.yml`); the anchored preset keeps `pwsh` and uses PTY bash only off-Windows.
- **`native/` (Landlock) is Linux-only**, irrelevant on Windows.

**Recommendation:** use dsh + anchored-standard as the **design reference** (presets, seams, catalog-as-artifact, bootstrap/promotion), and re-implement the ~200-line bootstrap plugin against I-harness's own step/pre-step/request hooks rather than embedding the monorepo. If the product goal is instead "a full agent hosted by dsh", the correct path is a new user-authored preset directory (`~/.dsh/.agent-presets/<id>/`) with an `agent.cordis.yml` + `tool-bootstrap` row — i.e., exactly what `dsh-anchored-standard` already demonstrates.