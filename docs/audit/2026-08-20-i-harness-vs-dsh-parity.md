# I-harness vs DeepSeek Harness — Progress & Completion Audit

Date: 2026-08-20. Read-only comparison. Purpose: inventory I-harness's current
capability against its conceptual base (DeepSeek Harness, dsh) to decide what
M12+ should build.

## 1. Framing

I-harness's stated goal (runtime-design spec, 2026-08-16): **a stable, audited
agent foundation on which the opencode-fork features can later be decomposed
into plugins** — using dsh's architecture as the *conceptual base*, not its
source. Therefore the parity comparison focuses on dsh's **headless-agent
kernel layer** (agent loop, sessions, tools, persistence, query, compaction,
subagents, safety), NOT dsh's product/web layer (GUI, goals, workflows, skills,
telemetry, attachments, multi-session web UX — 172 feature notes, most product).

## 2. I-harness milestone inventory (M1–M11)

| M | Delivered | Key artifacts |
|---|---|---|
| M1–M2 | Kernel: plugin kernel (scopes, listeners, waterfalls, guards, services), session log + projection, tool registry/catalog/exec pipeline, minimal agent loop + mock LLM | `core-plugin`, `core-session`, `core-tools`, `core-agent`, `llm-mock` |
| M3 | Subagent capability seam + tool_search (BM25, deferred promotion) + harness mount | `subagent` (P1), `tool-search`, `preset` |
| M3c | Cross-scope decision propagation (ancestor guards/decisions) | core-plugin `resolveDecision`/`checkGuards` |
| M4 | Session persistence seam (JSONL + coordinator) | `session-persistence`, `session-persistence-jsonl` |
| M5 | SQLite backend + migration chain | `session-persistence-sqlite` (schema v1) |
| M6 | Subagent state persistence (registry snapshot via documents) | coordinator `putDocument`/`getDocument` |
| M7 | Write-behind batching + document serialization | `SessionWriteBehind` |
| M8 | Child-session substrate (lineage headers) | `subagent` child scopes, lineage columns |
| M9 | Multi-turn subagent driver + cold resume | followup driver, durable inbox |
| M10a | Guards: tool timeout (cooperative, `TOOL_TIMEOUT`) + repeat-tool reminder; `ctx.cascade` around-seam | `guard-timeout`, `guard-repeat-tool` |
| M10b | session-query: SQLite FTS5 + lineage, `session_search`/`lineage` tools | `session-query` |
| M11 | Compaction: context-pressure auto + manual compact (dsh-faithful surface shadowing) | `compaction` |

26 packages + apps/cli. All gates green (`pnpm -r test` / `typecheck`).

## 3. dsh capability areas (headless-kernel scope)

From dsh packages + implemented notes, the headless-agent kernel areas:

| Area | dsh packages/notes |
|---|---|
| Microkernel / scopes / capability seams | `core`, `microkernel-event-taxonomy`, `capability-seams` |
| Event-sourced sessions + surface | `session`, `event-sourced-sessions`, `session-surface` |
| Agent loop (harness-level) + inbox | `harness-level-loop`, `agent-lifecycle-and-ownership-contracts`, `claimed-pre-step-inbox-lifecycle` |
| LLM adapters (multi-provider) + token meter | `llm`, `twin-llm-adapters`, `provider-routed-llm-adapters`, `replay-token-meter-service`, `bounded-llm-request-recovery` |
| Persistence (JSONL/SQLite) + write coordinator + batching | `storage`, `session-persistence`, `shared-persistence-write-coordinator`, `bounded-session-persistence-write-batching` |
| Session-query (SQLite FTS) + tracing + model-facing tools | `session-query`, `sqlite-session-query-provider`, `session-query-tracing`, `model-facing-session-query-tools` |
| Compaction + overflow recovery + routed policies | `compaction`, `after-call-compaction-pressure-and-overflow-recovery`, `routed-model-context-and-compaction-policy` |
| Subagents (parallel, background, continuable, policy inheritance) | `subagent`, `parallel-subagent-delegations`, `background-subagent-tasks`, `continuable-subagent-*`, `subagent-policy-inheritance` |
| Tools: fs, shell (bash stdin/env), terminal/PTY, sandbox, timeout, retry, spill, todo, goal | `fs`, `shell`, `terminal`, `subprocess`, `sandbox`, `timeout-deadline-library`, `tool-call-timeout-policy`, `provider-retry-policies`, `tool-output-spill-files`, `tool-result-retention-library`, `todo-write-tool`, `goal-*` |
| Safety: approval seam, sandbox (cross-family fs, Windows restricted-token) | `guard`, `approval-seam`, `sandbox`, `cross-family-fs-sandbox`, `windows-acl-restricted-token-sandbox` |
| Plugins: MCP client, skills, workflows, hooks, LSP | `mcp`, `skill`, `workflow`, `hooks`, `lsp`, `mcp-client-auto-reconnect` |
| Interaction/approval + model catalog + credentials | `interaction`, `llm-model-catalog`, `credentials-*`, `request-level-llm-config-credentials` |
| Headless entry + presets + CLI | `headless-direct-core-entry-point`, `per-session-agent-presets`, `dsh-cli-*` |
| Code runtime / ACP / SDK / web (out of scope for I-harness foundation) | `acp`, `code-runtime`, `sdk`, `web`, `gui-*`, `workflow-runs-in-chat` |

## 4. Completion matrix — I-harness vs dsh (headless kernel)

Legend: ✅ implemented · ◑ partial · ✖ not built · — out of I-harness foundation scope.

| dsh area | I-harness | Notes |
|---|---|---|
| Microkernel / scopes / waterfall / guards / services | ✅ `core-plugin` | Lightweight self-developed; **improved**: ancestor-visible `cascade`, `resolveDecision`/`checkGuards` ancestor walk (M3c/M10a); unmount reclamation; decision nearest-wins |
| Event-sourced sessions + projection | ✅ `core-session` | `deriveMessages` + shadow-aware projection (M11) + `deriveSearchText` |
| Agent loop + inbox/followup | ◑ `core-agent` | runTurn + followup driver (M9); NO per-agent inbox lifecycle (`agent/pre-step` event only); NO durable cross-session queue |
| LLM adapters | ◑ `llm-seam`+openai/anthropic/openai-compatible/mock | Multi-protocol seam ✅; NO token meter service, NO provider retry policies, NO bounded request recovery, NO model catalog |
| Persistence + write coordinator | ✅ `session-persistence` (+jsonl +sqlite) | `SessionWriteBehind`, document store, `KNOWN_EVENT_TYPES` gate; sqlite migration chain (M5); FTS same-tx (M10b) |
| Session-query (FTS + lineage) | ✅ `session-query` | BM25 + snippet + lineage + `session_search`/`lineage` tools; NO query tracing |
| Compaction | ◑ `compaction` | pressure auto + manual + re-fire guard + fail-soft; NO overflow recovery (`prompt_too_long`), NO routed per-model policies, NO summary checkpoint progress UI |
| Subagents | ◑ `subagent` | child scopes, lineage, persistence, multiturn, cold resume (M8/M9); NO parallel delegations, NO background/continuable subagents, NO policy inheritance, NO subagent list/catalog tool |
| Tools: fs, shell | ✅ `fs`, `shell`, `fs-search` | bash/pwsh, timeout threading (M10a); NO stdin/env trusted API, NO PTY/terminal, NO tool-result retention/spill files |
| Tools: timeout | ✅ `guard-timeout` | cooperative + `TOOL_TIMEOUT` marker + cascade seam; NO retry-on-timeout |
| Tools: todo / goal | ✖ | NO todo tool; NO goal domain (dsh goal tools are model-facing task tracking) |
| Tools: parallel tool calls | ✖ | tool calls are sequential inline (dsh has `parallel-tool-call-execution`) |
| Safety: approval | ✅ `guard-approval` | read-only detection, dangerous argv/commands, fail-closed; NO `ask` UI beyond the interaction seam |
| Safety: sandbox (OS) | ✖ | Runtime-design planned "pluggable later" (Linux Landlock/bwrap; Windows restricted token) — NOT built; approval + read-only gating is the current safety layer |
| Plugins: MCP / skills / workflows / LSP | ✖ | NOT built (opencode-fork features "become plugins later" — the stated end game, still pending) |
| Interaction/approval seam | ◑ `interaction` | `registerApprovalAnswerer` seam; NO model catalog UI, NO credentials management |
| Presets + CLI + headless | ✅ `preset`, `apps/cli` | runHeadless + M10a/M10b/M11 wiring; NO web/TUI/desktop/SDK/ACP |
| Token budget / context limits | ◑ | approx token estimation only (M11); NO per-model context windows, NO provider-side budget enforcement |
| Telemetry / diagnostics | ✖ | NO telemetry/OTel (dsh `session-telemetry-otel-revival`, `runtime-diagnostics`) |

## 5. Parity gaps by priority (for M12+)

### Kernel-level gaps (plausible next milestones, in the foundation's scope)
1. **Retry-on-timeout + provider retry policies** — the `tools/execute` cascade seam exists; a retry wrapper is a natural M12. dsh has `tool-call-timeout-policy`, `provider-retry-policies`, `bounded-llm-request-recovery`.
2. **Sandbox** — the runtime-design explicitly deferred OS sandbox ("pluggable later"); guard-approval is the safety today. dsh: `cross-family-fs-sandbox`, `windows-acl-restricted-token-sandbox`.
3. **Overflow recovery** — codex/dsh `prompt_too_long` → auto-compact path; M11's §Out-of-Scope.
4. **Parallel tool-call execution** — dsh has it; I-harness runs tools sequentially.
5. **Token meter / per-model context metadata** — M11's approx estimator works, but a real token-meter service + per-model catalog would harden compaction and enable budget checks.
6. **Subagent parallelism / background / policy inheritance** — dsh is far ahead; I-harness subagents are single-lineage, in-process, sequential.
7. **`KNOWN_EVENT_TYPES` registration process** — M11 final-review recommendation: make additive event registration mandatory with a coordinator round-trip test (would have caught the C1 bug).

### Product-layer gaps (out of the foundation's stated scope; the "opencode-fork features become plugins" end game)
- MCP client, skills, workflows, LSP, todo/goal tools, attachments/multimodal, telemetry, web/TUI/desktop front ends, ACP/SDK, persistent PTY, tool-output spill.

## 6. Where I-harness is already better than dsh (improved writings)

- **`ctx.cascade` (M10a)**: a clean around-dispatch primitive distinct from the
  value-producing waterfall — dsh's `tools/execute` chain conflates the two;
  I-harness's cascade is ancestor-visible and testable in isolation.
- **Cooperative timeout contract (M10a)**: no force-cancel, no promise racing —
  `TOOL_TIMEOUT` substitution with upstream-signal linking and restore. dsh's
  timeout library is heavier (deadline + retention libraries).
- **Same-transaction FTS maintenance (M10b)**: the FTS index can never diverge
  from the event log (append + migration are atomic).
- **Shadow pre-pass projection (M11)**: a log-preserving surface projection
  (two-pass `deriveMessages`) that keeps the durable log and FTS search intact —
  the ordering invariant (`agent/post-tool` after `tool/result`) also fixes a
  provider message-alternation bug dsh's reminder can hit.
- **Migration chain with backup + SAVEPOINT per step (M5)**: exercised by the
  first real migration in M10b.
- **Fail-loud config validation + no-hardcoded-tunables** discipline across
  guards and compaction.

## 7. Assessment

- **Kernel completeness vs the stated goal**: strong. The agent loop, session
  substrate, persistence (JSONL+SQLite), query (FTS+lineage), compaction,
  guards, subagents (single-lineage multiturn), and headless CLI form a
  coherent, audited, fully-green foundation. Every milestone ran the
  spec → plan → SDD → review pipeline with no open Critical/Important findings.
- **Parity vs dsh headless kernel**: roughly 60-70% by capability area, with
  the biggest kernel gaps being parallel tool calls, provider retry, sandbox,
  overflow recovery, per-model metadata, and subagent parallelism.
- **The end game is still ahead**: the opencode-fork features (tool_search is
  DONE as `tool-search`; MCP, skills, workflows, LSP, task/subagent plugins)
  were the *point* of building the foundation — most are not yet ported.

### Recommended next steps — M12+ roadmap (user-decided 2026-08-20)

Decided direction: parity-audit kernel items first, then the opencode-fork
plugin ports (MCP, LSP) referencing dsh's design as the primary base combined
with codex-rust's strengths, then Agent-Teams-style subagent teams. TUI / Web /
Desktop and llm-gemini / llm-bedrock are explicitly deferred.

1. **M12: Retry-on-timeout (tool + provider) + tool-result retention** — uses the
   existing cascade seam, closes the biggest operational gap, small surface.
2. **M13: Parallel tool-call execution** in core-agent (dsh `parallel-tool-call-execution`)
   — requires tool-result ordering discipline; medium risk.
3. **M14: Token meter service + per-model context catalog** — hardens M11
   compaction and enables budget checks + overflow recovery (codex/dsh
   `prompt_too_long` auto-compact).
4. **M15: Sandbox** (Linux Landlock/bwrap; Windows restricted token) — the
   deferred runtime-design item; pairs with guard-approval as defense-in-depth.
5. **M16: MCP client** — dsh primary design base, codex-rust advantages where
   it is stronger.
6. **M17: LSP** — same reference approach.
7. **M18: Subagent teams** — research first, referencing dsh's experimental
   Agent Teams (durable roster / Lead-log mailbox / task board with
   compare-and-set / wait_agent) adapted to I-harness's substrate.
8. Deferred: TUI / Web / Desktop front ends; llm-gemini / llm-bedrock adapters;
   workflows; skills-as-plugins; telemetry. (Agent-Teams experimental-package
   policy is a useful pattern to adopt when shipping experimental features.)
