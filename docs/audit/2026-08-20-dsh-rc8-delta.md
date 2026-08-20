# dsh rc.8 Delta — What Changed vs rc.7 and Impact on I-harness

Date: 2026-08-20. Read-only comparison of
`D:\agent-complete\deepseek-harness-master-rc8\deepseek-harness-master`
(`0.1.0-rc.8`) against `D:\agent-complete\deepseek-harness-master` (`0.1.0-rc.7`).

## 1. What changed (rc.7 → rc.8)

### 1.1 Agent Teams — the headline (NEW, experimental)

`packages/experimental/agent-team` (`@deepseek-ai/dsh-experimental-agent-team`)
+ `packages/experimental/tool-agent-team` (`...-tool-agent-team`):
- Durable **named-roster peer teams** over continuable children. Every runtime
  root is the implicit Lead of a Team identified by its SessionId.
- **Lead-log mailbox**: `team/message/queued` → `team/message/delivered`
  acknowledgement; quiet `send_message` (no wake) vs waking `followup_task`
  (next FIFO turn / cold resume); process-local retry, target-session
  de-duplication (not cross-process exactly-once).
- **Shared task board**: complete snapshots with Team-local ids + monotonic
  revisions, **compare-and-set** (`expectedRevision`), DAG dependencies
  (complete, non-deleted), tombstones for deleted tasks, `writeScopes` path
  prefixes (diagnostics only).
- **`wait_agent`** blocking on roster/mailbox/task/live-status edges (no
  polling).
- **Provisioning + recovery reconciliation**: `team/member` provisioning
  snapshots; recovery reconciles unterminated provisioning against the child's
  persisted Session (mismatch → failed, conflict drained); names reserved never
  reused; disposal drains live children.
- **Experimental package policy**: private `packages/experimental/`, name
  prefix `dsh-experimental-*`, release exclusion, dependency isolation,
  promotion path.
- Model-visible Team tools are **opt-in** (default catalog unchanged).

### 1.2 SQLite persistence: packed rows + compression (schema 15 → 17)

`session/session-persistence-sqlite` (+2 files: `codec.ts`, `compression.ts`):
- **Physical packed chunk rows**: one row per up to 1,024 events / 1 MiB of
  data; storage tags `text-chunks` / `reasoning-chunks` / `tool-call-chunks`;
  scalar rows kept for everything else (exact-field whitelisting — unknown
  fields stay scalar rather than losing info).
- **Zstandard compression**: `data` TEXT below 4 KiB; BLOB + zstd level 3 above
  (kept only when smaller); reader decompresses + strict UTF-8 decodes.
- **varint/zigzag-varint `source_event_seqs`** (first as unsigned varint,
  subsequent as signed differences) — exploits consecutive streaming lists.
- SQLite stays opt-in; shipped default is JSONL. Both backends behind the same
  `PersistenceCoordinator`.

### 1.3 pwsh persistent PTY (NEW)

`subprocess/subprocess-local` gained a **persistent PowerShell PTY** session
(architecture note `2026-08-11-pwsh-persistent-pty`) — interactive shell
sessions, not one-shot `bash -c`.

### 1.4 Product subagent enhancements

- **Noninteractive permissions** for background subagents
  (`2026-08-15-product-subagent-noninteractive-permissions`).
- **Failure facts** + **named instances** (subagent-list identity projection).
- (Earlier rc-line already had: parallel subagent delegations, background-first
  continuable delegation, completion-wakes-idle-owner.)

### 1.5 LLM / multimodal

- **Direct DeepSeek vision input** (`2026-08-19-direct-deepseek-vision-input`).
- `llm-pi-ai` wire-compat surface; adapter-owned reasoning-effort capabilities.

### 1.6 Web / client / distribution

- "Open-ready" web UI, web search multiple queries, image attachment envelope,
  file/session references, home-path tilde, session-log export, theme colors,
  install manifest, etc. (heavy churn in `client/*`).
- Client shells + dynamic packages, client build environment, settings
  describe mirror, `apps/cli` + `apps/web` at repo root, `docs/` directory.

### 1.7 Misc architecture

- `cancelled-stream-prefix-finalize`; `code-runtime-python-fd3-protocol`;
  `dynamic-client-render-and-attachment-ownership`.

## 2. What did NOT change (the stable core I-harness mirrors)

The package list is identical except `experimental/`. The kernel concepts
I-harness mirrors — event-sourced sessions, plugin kernel / scopes / capability
seams, compaction (pressure + manual), session-query (FTS + lineage), guards,
approval — had **minimal to no source churn** in rc.7 → rc.8. I-harness's
foundation remains architecturally aligned with dsh's stable core.

## 3. Impact on I-harness

| rc.8 item | Impact | Verdict |
|---|---|---|
| **Agent Teams** (experimental) | The strongest signal: dsh is evolving the subagent seam toward **durable peer teams** (roster / mailbox / task-board / wait_agent). I-harness subagents are single-lineage sequential with followups + cold resume — a major gap. The provisioning/recovery and CAS-task patterns are the reference if we build parallel/team subagents. | Reference for a future subagent-teams milestone. Experimental + heavy; our parity audit ranks simpler gaps (retry, parallel tool calls) higher for foundation value. |
| **SQLite packed rows + zstd** | dsh chose packed rows for scale. I-harness sqlite (schema v2) keeps **per-event scalar rows** because M10b's `events_fts` indexes each event — packed rows would complicate FTS maintenance. Compression matters only when sessions grow very large (M11 compaction keeps all events + the FTS index grows with them). | Later storage-optimization direction; not urgent. If adopted, consider compressing only the FTS `text`/tool payloads, not packing rows. |
| **pwsh persistent PTY** | Interactive terminals are a product-layer feature; I-harness shell is one-shot `bash -c` / `pwsh -Command`. | Out of foundation scope; reference if interactive shells are ever wanted. |
| **Product subagent + web + vision** | Product layer + LLM seam change (multimodal content blocks). I-harness `LLMMessage` is text-only. | Out of scope unless multimodal becomes a requirement. |
| **Experimental package policy** | dsh formalized an experimental-package pattern (name prefix, release exclusion, isolation). I-harness has no equivalent. | Useful pattern to adopt when we ship experimental features (e.g., a teams port). |
| **Stable core** | Compaction / session-query / guards / session semantics unchanged. | No re-alignment needed; our foundation tracks dsh's stable core. |

## 4. Net assessment

- **rc.8 is mostly product/experimental churn** (client/web, attachment, vision,
  packaging). The headless-kernel areas I-harness mirrors are stable.
- The single architecture-relevant new direction is **Agent Teams** — the
  natural successor to dsh's subagent seam. If/when I-harness closes its
  subagent-parallelism gap, the durable-roster/mailbox/task-board patterns
  (including provisioning/recovery reconciliation and CAS) are the reference
  design.
- **No urgent action** for I-harness. The parity audit's recommended next steps
  (retry-on-timeout, parallel tool calls, token meter, sandbox) are unaffected
  by rc.8.
