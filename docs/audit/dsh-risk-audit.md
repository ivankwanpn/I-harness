# DeepSeek Harness Risk Audit — Disposition Table

Date: 2026-08-16
Source: `D:\agent-complete\deepseek-harness-master` (dsh `0.1.0-rc.5`)
Purpose: input for I-harness kernel design (spec §2-§4). Each row states whether
the dsh component should be reused, rewritten, or re-implemented with an
improved design.

_Disposition scope note: each disposition labels the finding's mechanism (the
component and behavior cited in the row's Evidence), not the whole file or
package it lives in — a `rewrite` row targets that mechanism, not every line of
the file._

## Summary

- Findings: 39 total (3 Critical, 19 Important, 17 Minor) across sections
  01-05. Counts from the section files.
- Disposition mix: 14 reuse, 1 rewrite, 24 improved-writing.
- Top risks that MUST drive the kernel design:
  1. **F03-1 (Critical)** — Guard bypass: a malformed or non-vocabulary
     `tools/pre-execute` decision (kind not exactly `allow`, `reason` undefined)
     dispatches the tool body and skips the monotonic guards entirely. The
     kernel must validate every pre-execute decision against the closed
     vocabulary and evaluate the guards before ANY dispatch.
  2. **F01-1 (Critical)** — `SESSION_FORMAT_VERSION` pinned at `0` with no
     migration chain: any format bump strands every stored session. The kernel
     ships a monotonic version, a stepwise upgrade chain, and a
     migrate-on-continue path from day one.
  3. **F04-1 (Critical)** — Windows profiles ship no `bash` tool and no
     persistent shell, and the bootstrap anchor silently fails open to the
     full catalog. The kernel resolves `bootstrapTools` per platform and treats
     a missing bootstrap tool as a loud error, never a silent fallback.
  4. **F02-1 (Important)** — Waterfall dispatch has no per-listener
     containment: a forgotten `next()` silently vetoes and a throwing listener
     aborts the whole chain. The kernel needs a distinct veto signal,
     per-listener error attribution, and a return-the-delegated-promise rule.
  5. **F02-4 (Important)** — Unbounded disposer quiescence: one non-settling
     disposer hangs plugin removal, scope disposal, and whole-tree shutdown.
     The kernel needs a bounded quiescence budget with forced-unload
     escalation and a log naming the wedged disposer. (T2 review: arguably
     Critical for a hardened kernel — held at Important here, but mandatory.)
  6. **F02-5 (Important)** — Blanket `internal/*` interception gives any
     plugin undetectable rewrite of all service traffic; "no privileged core"
     is cosmetic. The kernel must treat the interception surface as a
     documented, sealable privileged API. (T2 review: arguably Critical —
     surfaced at Important or higher as required.)
  7. **F03-2 (Important, rewrite)** — The `bash` destructive-command consent
     gate is a raw-string regex bypassable by shell quoting (`r\m`, `'r''m'`).
     Do not copy it; classify destructive intent on the parsed argv at the
     effect boundary.
  8. **F03-4 (Important)** — Timeouts are cooperative and opt-in: a missing
     watchdog plugin or an undeclared `timeoutMs` silently disables every
     deadline. The kernel arms deadlines at the registry for every tool that
     declares one and gates `TOOL_TIMEOUT` on body quiescence.
  9. **F04-4 (Important)** — The Windows sandbox is write-only,
     partial-enforcement, console-constrained, and weaker than the same
     `SandboxMode` vocabulary under bwrap. The kernel must scope sandbox policy
     claims per platform ("approval + directory whitelist" first on Windows).
  10. **F01-3 (Important)** — `model-visible ⟺ logged` is enforced only on a
      process-local WeakSet of agent-loop requests; every other LLM caller
      bypasses the reconstruction check. The kernel owns the check at the
      model seam on every request.

## Disposition Table

| # | Section | Component | Finding | Severity | Disposition | Reason | Evidence |
|---|---------|-----------|---------|----------|-------------|--------|----------|
| T1 | 01 | `packages/core/session/src/types.ts` | F01-1 — `SESSION_FORMAT_VERSION` pinned at `0`: no back-compat, no migration path | Critical | improved-writing | version-stamp concept is sound but the no-migration stance strands every stored session at the first format bump | `packages/core/session/src/types.ts:56` |
| T2 | 01 | `session-persistence-jsonl` (+ coordinator) | F01-2 — Append atomicity and crash consistency handled end-to-end (rollback + torn-tail tolerance + repair-on-load) | Important | reuse | no fault found; the append-atomicity contract is met for both backends | `packages/session/session-persistence-jsonl/src/index.ts:665-679` |
| T3 | 01 | `packages/core/agent-loop/src/invariant.ts` (+ llm, session surface) | F01-3 — `model-visible ⟺ logged` is a convention enforced only at the agent-loop boundary | Important | improved-writing | derivation-from-log is sound but the visible⇒logged guard runs only on a process-local WeakSet of loop-built requests | `packages/core/agent-loop/src/invariant.ts:39-41` |
| T4 | 01 | `packages/session/session-persistence-sqlite/src/schema.ts` | F01-4 — SQLite schema version pinned at `15` with no migration: a bump rejects the whole database | Important | improved-writing | version enforcement is correct but no forward migration locks out an existing DB on any table-layout change | `packages/session/session-persistence-sqlite/src/schema.ts:20` |
| T5 | 01 | `session-persistence-jsonl` vs `session-persistence-sqlite` | F01-5 — JSONL and SQLite expose materially different capabilities behind one persistence seam | Minor | improved-writing | seam is clean but capability asymmetry (raw artifacts, O(suffix) reads, repair) misleads consumers; kernel must declare relied-on capabilities | `packages/session/session-persistence-jsonl/src/index.ts:122` |
| T6 | 01 | `packages/session/session-persistence-jsonl/src/index.ts` | F01-6 — JSONL root pins one physical encoding: switching compression orphans every stored session | Minor | improved-writing | the guard is defensive but irreversible; a config toggle bricks the workspace's whole history | `packages/session/session-persistence-jsonl/src/index.ts:905-907` |
| T7 | 01 | `session-persistence-jsonl/src/format.ts` (+ coordinator) | F01-7 — Unknown/foreign format versions are refused before structural decode — "upgrade the harness", never "corrupt session" | Minor | reuse | refusal-before-decode + `ignorable` vocabulary guard is clean forward-compat behavior | `packages/session/session-persistence-jsonl/src/format.ts:240-246` |
| T8 | 02 | `vendor/cordis/src/events.ts` (+ agent-loop, tools) | F02-1 — Waterfall dispatch has no per-listener containment: a forgotten `next()` silently vetoes and a throwing listener aborts the whole chain | Important | improved-writing | around-middleware concept is stable but there is no containment, no distinguishable veto, no truncated-chain detection | `vendor/cordis/src/events.ts:234-243` |
| T9 | 02 | `packages/core/tools/src/index.ts` | F02-2 — `tools.guard()` is a structurally monotonic deny-only guard: order cannot re-allow, only unmount can relax | Important | reuse | no fault found; deny-only + append-only per-plugin table makes late re-allow structurally impossible | `packages/core/tools/src/index.ts:704-711` |
| T10 | 02 | `packages/core/scope/src/store.ts` (+ tools, scope index) | F02-3 — Scope shadowing and unmount are correct: nearest-scope-wins, duplicates-in-layer fail loud, empty layers reclaimed | Important | reuse | no correctness fault found; resolution order, duplicate handling, restriction semantics, unmount reclamation are coherent | `packages/core/scope/src/store.ts:43-59` |
| T11 | 02 | `vendor/cordis/src/fiber.ts` (+ app-boot) | F02-4 — Plugin lifecycle is fail-loud on startup and contained on disposal, but a non-settling disposer hangs the entire unload chain | Important | improved-writing | fail-loud startup and per-disposer containment are right but settlement is unbounded; one wedged disposer pins shutdown | `vendor/cordis/src/fiber.ts:292-295` |
| T12 | 02 | `app-boot` + `vendor/cordis/src/reflect.ts` + `events.ts` | F02-5 — "Everything is a plugin" holds for the product spine — but three real privileged surfaces exist, incl. blanket `internal/*` interception | Important | improved-writing | plugin-everything spine is real but the interception surface gives any plugin undetectable rewrite of all service traffic | `vendor/cordis/src/reflect.ts:153-154` |
| T13 | 02 | `vendor/cordis/src/events.ts` (+ agent dispatch, tools) | F02-6 — `emit` (fire-and-forget) dispatches through `Array.map`: a throwing listener starves later observers and propagates into the emitter | Minor | improved-writing | fire-and-forget concept is right but `emit` has no containment while dsh's busiest callers re-implement it | `vendor/cordis/src/events.ts:194-198` |
| T14 | 02 | `packages/core/scope/src/index.ts` | F02-7 — `bindScopeParent().rebind()` re-parents inheritance under live layers with an unenforceable precondition | Minor | improved-writing | bind-once primitive is good but rebind silently re-parents live registrations with no runtime idleness check | `packages/core/scope/src/index.ts:72-84` |
| T15 | 02 | `packages/guard/*` (repeat-tool-reminder, timeout-policy, tool-bootstrap) | F02-8 — `packages/guard/*` loop-hygiene plugins are clean reference implementations for advice-style guard plugins | Minor | reuse | no fault found; reference patterns for composing with the tool pipeline | `packages/guard/timeout-policy/src/index.ts:55-78` |
| T16 | 03 | `packages/core/tools/src/index.ts` | F03-1 — Guard enforcement is conditionally skipped: a non-`allow`, reason-less pre-execute decision dispatches the call and bypasses the monotonic guards | Critical | improved-writing | deny-only monotonic guard is the right invariant but the implementation trusts an unvalidated runtime object; kernel must validate the vocabulary and run guards before ANY dispatch | `packages/core/tools/src/index.ts:1486-1488` |
| T17 | 03 | `packages/shell/tool-bash/src/index.ts` | F03-2 — `bash` destructive-command consent gate is a raw-string regex: shell quoting executes `rm` without the approval ask | Important | rewrite | a string-substring classifier over an unparsed shell command is trivially bypassable — do not copy; classify destructive intent on parsed argv at the effect boundary | `packages/shell/tool-bash/src/index.ts:39` |
| T18 | 03 | `packages/core/tools/src/code-mode.ts` (+ index) | F03-3 — `run_code` reserved transport re-enters the complete guarded pipeline per sub-dispatch: no policy shortcut | Minor | reuse | no fault found; transport changes only visibility, every sub-dispatch re-enters the full guarded pipeline | `packages/core/tools/src/code-mode.ts:545-561` |
| T19 | 03 | `packages/guard/timeout-policy/src/index.ts` (+ tools, util/timeout) | F03-4 — Timeouts are cooperative and opt-in: a missing watchdog plugin or an undeclared `timeoutMs` silently disables every deadline | Important | improved-writing | signal-based cooperative timeout is sound but the effective deadline depends on a per-tool declaration AND an optional plugin; arm at the registry and gate on body quiescence | `packages/guard/timeout-policy/src/index.ts:58-59` |
| T20 | 03 | `packages/core/scope/src/store.ts` (+ tools, subagent) | F03-5 — `bash` duplicate-registration pitfall: a scoped registration silently shadows the global `bash` and escapes every deny/allow restriction | Important | improved-writing | fail-loud duplicate-in-layer is the right floor but cross-layer shadowing lets a per-agent `bash` bypass all masks; bind sandbox/approval to the capability provider, not the tool name | `packages/core/tools/src/index.ts:1176-1180` |
| T21 | 03 | `packages/core/tools/src/index.ts` (+ escalation, fs-sandbox, user-approval) | F03-6 — Restriction masks, approval, and sandbox are genuinely separate seams with no cross-bypass — but only approval and effect-time fences are security boundaries | Minor | reuse | seam separation is real and worth copying; document that `restrict()` is presentation, never a security boundary | `packages/core/tools/src/index.ts:1475-1488` |
| T22 | 03 | `scripts/gen-tool-catalog.ts` (+ `docs/tool-catalog.md`) | F03-7 — Catalog completeness gate checks doc freshness against default-config package boots: it cannot see agent-scoped, config-branched, or non-`tool-*` tools | Minor | improved-writing | doc-freshness gate is a good discipline but stays green while the runtime shows tools the catalog never recorded | `scripts/gen-tool-catalog.ts:607-614` |
| T23 | 03 | `packages/guard/tool-bootstrap/src/index.ts` | F03-8 — Anchored bootstrap is a prompt/catalog narrow, not an execution boundary: degrade-to-full-catalog is safe only because nothing gates the non-bootstrap tools | Minor | reuse | nothing claims to be an enforcement boundary; presentational anchor with an honest fail-safe degrade — copy it | `packages/guard/tool-bootstrap/src/index.ts:142-153` |
| T24 | 04 | `agent-presets/*` + `cordis.patch.yml` + `tool-bootstrap` | F04-1 — On Windows the shipped profile has no `bash` tool and no persistent shell: the bootstrap anchor silently degrades to the full catalog | Critical | improved-writing | minimal-catalog anchor concept is sound but hardcodes a POSIX-only pair and fails open on Windows; resolve per platform and fail loud | `apps/cli/config/agent-presets/standard/agent.cordis.yml:89` |
| T25 | 04 | `packages/subprocess/subprocess-local/src/process-inspector.ts` (+ consumers) | F04-2 — Root cause of F04-1: the terminal process inspector throws on `win32`, so `spawnTerminal` cannot create any PTY | Important | improved-writing | Linux-specific inspector is by construction and correctly refuses on Windows, but the all-or-nothing throw forces composition-level disable; add a win32 inspector or a first-class "no terminal" signal | `packages/subprocess/subprocess-local/src/process-inspector.ts:366-374` |
| T26 | 04 | `packages/sandbox/sandbox/src/index.ts` + `sandbox-local` + twin executors | F04-3 — The sandbox seam is genuinely per-platform pluggable: one interface, three real backends, zero Linux leakage into call sites | Important | reuse | no fault found; exactly the cross-platform ablation I-harness §4.3 asks for | `packages/sandbox/sandbox/src/index.ts:158-175` |
| T27 | 04 | `packages/sandbox/sandbox-windows-acl` (+ `sandbox-local`) | F04-4 — The Windows sandbox is a real restricted-token mechanism — but write-only, partial-enforcement, console-constrained | Important | improved-writing | strong mechanism reference but its contract is materially weaker than the same `SandboxMode` under bwrap; scope policy claims per platform | `packages/sandbox/sandbox-windows-acl/src/index.ts:4` |
| T28 | 04 | `bash-local`, `pwsh-local`, `shell` + tool consumers | F04-5 — The pwsh/bash shell split is two dialects over ONE capability seam: one-shot pwsh is a real capability loss on Windows | Important | improved-writing | one shell seam / one dialect per host is the right shape but the Windows dialect is one-shot; decide the persistent-pwsh question explicitly | `packages/shell/shell/src/index.ts:2-16` |
| T29 | 04 | `packages/subprocess/subprocess-local/src/spawn.ts` (+ index, cli plugin) | F04-6 — Subprocess/exec plumbing is Windows-correct (taskkill trees, PATHEXT resolution, case-insensitive env) — reuse-as-is | Minor | reuse | no faults found; every platform branch is the right Windows answer | `packages/subprocess/subprocess-local/src/spawn.ts:276-283` |
| T30 | 04 | `fs-sandbox/containment.ts` + `fs-local` + credentials | F04-7 — Filesystem isolation and atomic writes are Windows-aware — except POSIX permission-privacy silently degrades to skipped checks | Important | improved-writing | DACL-preserving atomic write and identity containment are correct Windows engineering, but "POSIX permissions → silently skipped" is not a Windows privacy policy | `packages/fs/fs-sandbox/src/containment.ts:58-82` |
| T31 | 04 | `.gitattributes` + subprocess decode + pwsh + str-replace-editor | F04-8 — Canonical line endings and output decoding are already LF/UTF-8: no CRLF hazard in the surface the tools see | Minor | reuse | no fault found; LF-canonical + UTF-8 decode + CRLF-aware PTY boundary — adopt unchanged | `.gitattributes:7` |
| T32 | 04 | `packages/e2b/*` (opt-in family) | F04-9 — E2B remote sandboxing is the only escape hatch for Linux-only features on Windows, and it is out-of-box-unavailable | Minor | improved-writing | remote-VM concept is the usual escape hatch but ships as an out-of-tree opt-in POC with no profile wiring | `packages/e2b/e2b/README.md:5` |
| T33 | 05 | `apiproxy/src/api/events.ts` + `api/index.ts` + `client/connection` | F05-1 — UI-consumption wire contract is a push-subscription model: one shared typed `ApiProxy` barrel, two downlink streams, one `/api/respond` echo | Important | reuse | typed push-subscription + unary + respond-echo framing is exactly the decoupled consumer contract the `Interaction` seam needs | `packages/host/apiproxy/src/api/events.ts:69-108` |
| T34 | 05 | `packages/core/tools/src/presentation.ts` + `schema.ts` + host + `ui-tool` | F05-2 — Tool render intent is a provider-neutral pure-function contract (`presentCall`/`presentResult` → card-tagged views), host-computed per frame, never persisted | Minor | reuse | no fault found; the card-tagged render-intent union with replay-enforced purity is a stable cross-surface contract | `packages/core/tools/src/schema.ts:528` |
| T35 | 05 | `packages/host/apiproxy/src/api-proxy.ts` + client manager + user-approval | F05-3 — Approval is resumable across a client disconnect, but only while the host process and the tool's open turn survive | Important | improved-writing | same-rpcId replay baseline answers the disconnect question but resumability is process-local; state the approval durability boundary explicitly | `packages/host/apiproxy/src/api-proxy.ts:1410-1414` |
| T36 | 05 | `tsconfig.host.json` + `tsconfig.client.json` + api barrel + zod schemas | F05-4 — The host/client split is drift-guarded by two TS aggregates sharing one wire barrel, but the same payload shapes are hand-repeated in zod validation schemas | Minor | improved-writing | single-source typing is right but each payload exists in two hand-maintained forms; close the drift with generated schemas | `packages/host/apiproxy/src/api/events.schema.ts:47-51` |
| T37 | 05 | `user-approval` + `user-questions` + headless + ACP + sdk/protocol | F05-5 — The interaction seams are provider-neutral by design, but dsh ships no interactive human consumer except the web host: headless fails closed, the SDK approval flow is dead capability, ACP is machine-only | Important | improved-writing | provider/answerer neutrality is correct and reusable but the shipped tree has no interactive human consumer besides the web GUI; `interaction-cli` is net-new design | `packages/interaction/user-approval/README.md:5` |
| T38 | 05 | `packages/interaction/commands` | F05-6 — The command channel is a UI-plane-only human-input path whose results never enter model history | Minor | reuse | cleaner than folding gestures into `user/message`; UI-plane command steering + log-only `command/run`/`command/done` pair is replayable | `packages/interaction/commands/README.md:15` |
| T39 | 05 | `apiproxy/src/api/events.ts` + client manager | F05-7 — Transient interaction-adjacent state (`session/queue`, `session/jobs`, `session/projection`) is push-only and never logged: every consumer must replicate the reconnect/replay discipline | Minor | improved-writing | push-only + whole-snapshot + host-recompute posture is consistent but puts a heavy unstated contract on every consumer; log it or document the discipline centrally | `packages/host/apiproxy/src/api/events.ts:101-102` |

## Reuse candidates

Components the kernel can copy as reference (`reuse` rows, 14 total):

| # | Section | Component | Finding | Evidence |
|---|---------|-----------|---------|----------|
| R1 | 01 | `session-persistence-jsonl` (+ coordinator) | F01-2 — Append atomicity and crash consistency handled end-to-end | `packages/session/session-persistence-jsonl/src/index.ts:665-679` |
| R2 | 01 | `session-persistence-jsonl/src/format.ts` (+ coordinator) | F01-7 — Unknown/foreign format versions refused before structural decode | `packages/session/session-persistence-jsonl/src/format.ts:240-246` |
| R3 | 02 | `packages/core/tools/src/index.ts` | F02-2 — Monotonic deny-only `tools.guard()` pipeline | `packages/core/tools/src/index.ts:704-711` |
| R4 | 02 | `packages/core/scope/src/store.ts` (+ tools, scope index) | F02-3 — Scoped layers: nearest-scope-wins shadowing + unmount reclamation | `packages/core/scope/src/store.ts:43-59` |
| R5 | 02 | `packages/guard/*` | F02-8 — Loop-hygiene guard plugins (repeat-tool-reminder, timeout-policy, tool-bootstrap) | `packages/guard/timeout-policy/src/index.ts:55-78` |
| R6 | 03 | `packages/core/tools/src/code-mode.ts` (+ index) | F03-3 — `run_code` reserved transport re-enters the guarded pipeline per sub-dispatch | `packages/core/tools/src/code-mode.ts:545-561` |
| R7 | 03 | `packages/core/tools/src/index.ts` (+ escalation, fs-sandbox, user-approval) | F03-6 — Separate restriction / approval / sandbox seams | `packages/core/tools/src/index.ts:1475-1488` |
| R8 | 03 | `packages/guard/tool-bootstrap/src/index.ts` | F03-8 — Presentational anchored bootstrap with honest degrade | `packages/guard/tool-bootstrap/src/index.ts:142-153` |
| R9 | 04 | `packages/sandbox/sandbox/src/index.ts` + `sandbox-local` + twin executors | F04-3 — Per-platform pluggable sandbox seam (argv-in/argv-out) | `packages/sandbox/sandbox/src/index.ts:158-175` |
| R10 | 04 | `packages/subprocess/subprocess-local/src/spawn.ts` (+ index, cli plugin) | F04-6 — Windows-correct subprocess plumbing (taskkill, PATHEXT, case-insensitive env) | `packages/subprocess/subprocess-local/src/spawn.ts:276-283` |
| R11 | 04 | `.gitattributes` + subprocess decode + pwsh + str-replace-editor | F04-8 — LF/UTF-8 canonical surface with CRLF-aware PTY boundary | `.gitattributes:7` |
| R12 | 05 | `apiproxy/src/api/events.ts` + `api/index.ts` + `client/connection` | F05-1 — Push-subscription wire contract (typed `ApiProxy` barrel, two downlinks, `/api/respond`) | `packages/host/apiproxy/src/api/events.ts:69-108` |
| R13 | 05 | `packages/core/tools/src/presentation.ts` + `schema.ts` + host + `ui-tool` | F05-2 — Provider-neutral pure-function render intents | `packages/core/tools/src/schema.ts:528` |
| R14 | 05 | `packages/interaction/commands` | F05-6 — UI-plane command channel (never enters model history) | `packages/interaction/commands/README.md:15` |

## Findings detail

For each row there is a findings block in `findings/0N-*.md`, referenced by ID:

- Section 01 — `findings/01-session-persistence.md` (F01-1 … F01-7)
- Section 02 — `findings/02-plugin-kernel.md` (F02-1 … F02-8)
- Section 03 — `findings/03-tool-pipeline.md` (F03-1 … F03-8)
- Section 04 — `findings/04-windows-exec.md` (F04-1 … F04-9)
- Section 05 — `findings/05-interaction.md` (F05-1 … F05-7)
