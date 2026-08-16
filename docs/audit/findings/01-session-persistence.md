# Section 01 — Session Persistence & Format

Audit of the dsh session event log and its persistence subsystem:
`packages/core/session` (append-only log, typed event schema, `deriveMessages`,
surface), `packages/session/session-persistence` (coordinator), the JSONL
backend (`packages/session/session-persistence-jsonl`), and the SQLite backend
(`packages/session/session-persistence-sqlite`).
Target: dsh `0.1.0-rc.5`. Read-only; all `path:line` citations verified against
the dsh tree (see the Verification block at the end).

Findings below use the canonical `F01-n` template; later sections reuse it.

---

### F01-1: `SESSION_FORMAT_VERSION` pinned at `0` — no back-compat, no migration path

- **Severity:** Critical
- **Component:** `packages/core/session/src/types.ts`
- **Evidence:** `packages/core/session/src/types.ts:56` — the version constant is hard-pinned at `0`; `packages/core/session/src/types.ts:37-38` — explicit statement that "no compatibility is implied, incompatible logs are rejected, and no migration is provided"; every load path refuses any other version (`packages/session/session-persistence/src/coordinator.ts:1046`, `assertVersion` throwing `sessionFormatVersionRefusal`).
- **Disposition:** improved-writing
- **Reason:** the single-monotonic-version + load-time-refusal concept is sound, but copying the deliberate no-migration stance would strand every stored session at the first format bump; we ship a compatibility strategy from day one.
- **Details:** dsh documents the version as a deliberate pre-release contract: while unreleased, the header version is always `0`, incompatible logs are rejected, and there is no upgrade step. The mechanism for a proper chain (bump decision driven by what the writer emits, upgrade-step sequence, migrate-on-continue) exists only as an Agent Note
  (`.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md`); it is not implemented because the version never moves. I-harness must define, before first release: monotonic version stamping, a stepwise upgrade chain, an explicit "bump only when the writer cannot guarantee semantic correctness" rule, and a migrate-on-continue path. Adopting dsh's refusal text (F01-7) while adding the migration chain avoids the "all persisted sessions unreadable after one format change" risk that spec §2.2 flags as a NEW audit-driven requirement.

### F01-2: Append atomicity and crash consistency are handled end-to-end (rollback + torn-tail tolerance + repair-on-load)

- **Severity:** Important
- **Component:** `packages/session/session-persistence-jsonl/src/index.ts` (+ `packages/session/session-persistence/src/coordinator.ts`)
- **Evidence:** `packages/session/session-persistence-jsonl/src/index.ts:665-679` — JSONL append writes the batch then `fsync`s and, on any write/sync failure, closes and calls `rollbackAppend` before rethrowing so the unchanged cursor retry cannot duplicate seqs; `packages/session/session-persistence-jsonl/src/index.ts:681-688` — `rollbackAppend` truncates back to the prior size and fsyncs; `packages/session/session-persistence-jsonl/src/format.ts:272-343` — `SessionLogScanner` tolerates a torn final record and returns the contiguous committed prefix; `packages/session/session-persistence-jsonl/src/index.ts:438-443` — `commitRepair` truncates the torn tail then appends synthetic closers; `packages/session/session-persistence-sqlite/src/index.ts:284-298` — SQLite runs each append batch in ONE `BEGIN`/`COMMIT` transaction (rollback on failure), satisfying the atomicity contract; `packages/session/session-persistence/src/coordinator.ts:697-710` — seq contiguity is enforced before the durable write and the durable write is treated as the transaction boundary (cursor advances only after commit).
- **Disposition:** reuse
- **Reason:** no fault found — spec §5.2's "a failed append must not leave partial events" is met by in-process rollback for both backends, tolerated torn tails on read, and load-time repair that truncates and re-closes interrupted turns.
- **Details:** The JSONL physical append is not itself atomic (write then fsync), but three mechanisms close the crash window: (1) failed in-process appends restore the prior byte size before erroring, so the pending batch retries cleanly; (2) a crash mid-append leaves only a torn tail that every read drops at the last complete record (`committedBytes`) and marks for truncation; (3) `commitRepair` truncates the torn tail and appends missing closers on the next load. SQLite is fully atomic per batch via a single transaction. I-harness can copy this exact machinery as a reference (per-id serialization, torn-marker round-trip, truncate-then-append repair); what must be preserved is the pairing of tolerated-read, repair-on-load, rollback-on-failure, and the caller-driven `session/flush` durability barrier.

### F01-3: `model-visible ⟺ logged` is a convention with runtime enforcement only at the agent-loop boundary

- **Severity:** Important
- **Component:** `packages/core/agent-loop/src/invariant.ts` (+ `packages/llm/llm/src/call-config.ts`, `packages/core/session/src/surface.ts`)
- **Evidence:** `packages/core/agent-loop/src/invariant.ts:39-41` — at `llm/stream` time the invariant JSON-compares the request's `messages` against `session.deriveMessages()` and fails on any divergence (log-reconstruction desync); `packages/core/agent-loop/src/invariant.ts:22` — the check is skipped unless `isAgentLoopRequest(options)`; `packages/llm/llm/src/call-config.ts:13` — `isAgentLoopRequest` is a process-local `WeakSet<GenerateOptions>` marking only requests assembled by `dsh-agent-loop`, so every other LLM caller gets no reconstruction check; `packages/core/session/src/surface.ts:26-27` — derivation eligibility restricted to the three message-producing types, and `packages/core/session/src/surface.ts:34-37` — a `surfaceOp` marker is required for an event to join the surface; `packages/core/session/src/index.ts:604-634` — `Session.append` validates JSON-serializable data and surface transitions at the append site.
- **Disposition:** improved-writing
- **Reason:** derivation-from-log is structurally sound ("logged ⇒ visible" holds by construction), but the "visible ⇒ logged" direction is enforced only on a WeakSet of loop-built requests; the kernel must own the check at the model seam so no request path bypasses it.
- **Details:** Because `deriveMessages()` reconstructs model history exclusively from the event log and `Session.append` rejects non-JSON data and invalid surface ops, a message reachable by the model is always logged. The reverse guard — every model-visible input must have a session event and reconstruct exactly — lives in an optional plugin (`agent-loop-invariant`) and only for requests registered in a process-local set; title-generation, subagent/driver, and other direct `llm/stream` calls bypass it entirely, and a composition without the plugin mounts no guard at all. I-harness should move the reconstruction/traceability check into the model seam (kernel-owned, on every request, comparing the assembled request against the log-derived history), which avoids the "silent divergence between the model transcript and durable history" bug the dsh convention leaves to caller discipline.

### F01-4: SQLite schema version pinned at `15` with no migration — a bump rejects the whole database

- **Severity:** Important
- **Component:** `packages/session/session-persistence-sqlite/src/schema.ts`
- **Evidence:** `packages/session/session-persistence-sqlite/src/schema.ts:20` — `SCHEMA_VERSION = 15`; `packages/session/session-persistence-sqlite/src/schema.ts:108-109` — any non-current `user_version` rejects with "incompatible with this build"; `packages/session/session-persistence-sqlite/src/schema.ts:96-108` — schema/application-id ownership is validated under `BEGIN IMMEDIATE`, then the DB is initialized (only when `user_version === 0`) or refused.
- **Disposition:** improved-writing
- **Reason:** version enforcement is correct, but with no forward migration any table-layout change permanently locks out an existing database; I-harness must couple every schema bump to a migration step.
- **Details:** `openDatabase` treats a zero `user_version` as "brand-new, initialize", and treats every non-zero, non-15 version as incompatible — there is no migration chain, and the AGENTS.md pillar ("SQLite uses monotonic `SCHEMA_VERSION` … no compatibility promise") confirms this is deliberate pre-release policy. Note this `SCHEMA_VERSION` is orthogonal to the per-session event-format version stored in the `sessions.version` column (rowToMeta maps it into `SessionHeader.version`, checked by `assertVersion`). If I-harness chooses SQLite as the durable store, it must implement forward migrations with a backup/rollback story for each bump, otherwise a single schema change bricks the entire history database.

### F01-5: JSONL and SQLite expose materially different capabilities behind one persistence seam

- **Severity:** Minor
- **Component:** `packages/session/session-persistence-jsonl/src/index.ts` vs `packages/session/session-persistence-sqlite/src/index.ts`
- **Evidence:** `packages/session/session-persistence-jsonl/src/index.ts:122` — `supportsRawArtifacts = true`, with `locate` at `packages/session/session-persistence-jsonl/src/index.ts:172` and `readRaw` at `packages/session/session-persistence-jsonl/src/index.ts:252` (per-session verbatim artifacts); `packages/session/session-persistence-sqlite/src/index.ts:225-239` — SQLite implements the seek-capable `loadStoredFrom` (suffix read scales with the suffix); `packages/session/session-persistence-jsonl/src/format.ts:388-394` — JSONL `scanLog` parses the whole file even for a suffix read (the coordinator falls back to parse-then-skip); `packages/session/session-persistence-sqlite/src/schema.ts:232-269` — SQLite `scanRows` drops torn rows past the preserved region and never repairs on a read.
- **Disposition:** improved-writing
- **Reason:** the backend seam is clean and the differences are documented, but consumers that assume symmetric capabilities (raw artifacts, O(suffix) reads, repair semantics) will misbehave; the kernel must declare which backend capabilities it relies on.
- **Details:** JSONL is sequential media with one artifact per session: it offers raw artifacts, located paths, and whole-file scan even for `readFrom`/`prepare`; SQLite offers per-event rows with O(suffix) `readFrom`, no raw artifact, no `locate`, and torn rows silently dropped on suffix reads (repair only happens on load). A projection cache or log-export code path that assumes O(suffix) reads or raw artifacts will silently change cost or fail on the other backend. I-harness should either fix one backend as the kernel's durable contract or spell out the capability surface (raw artifacts, suffix reads, torn-tail repair) so every consumer codes against the documented seam.

### F01-6: JSONL root pins one physical encoding — switching compression orphans every stored session

- **Severity:** Minor
- **Component:** `packages/session/session-persistence-jsonl/src/index.ts`
- **Evidence:** `packages/session/session-persistence-jsonl/src/index.ts:905-907` — `rejectOppositeArtifact` refuses to materialize when the other encoding's file exists; `packages/session/session-persistence-jsonl/src/index.ts:884-885` — `checkRootEncoding` rejects a root that already contains the opposite-encoded artifact (a permanent per-root property); `packages/session/session-persistence-jsonl/src/index.ts:480-485` — `listArtifacts` rejects a single opposite-encoded log in any session directory.
- **Disposition:** improved-writing
- **Reason:** the guard is defensive but irreversible — a root is permanently `zstd`- or `none`-affiliated with no conversion utility, so a config toggle bricks the whole workspace's history.
- **Details:** Physical encoding is derived from loader config (`compression` default `zstd`), and the backend refuses to read or write a log under the opposite suffix, instructing "use a separate root or select the matching compression mode". A deployment that changes `compression` (or `packChunks`, which only affects new bytes but which users may toggle alongside) or switches the plugin between backends cannot open its existing logs. I-harness should make encoding choice a durable per-root property with an explicit migration (convert-on-repeat-run or a documented permanent decision), avoiding the "config change = all history unreadable" trap.

### F01-7: Unknown/foreign format versions are refused before structural decode — "upgrade the harness", never "corrupt session"

- **Severity:** Minor
- **Component:** `packages/session/session-persistence-jsonl/src/format.ts` (+ `packages/session/session-persistence/src/coordinator.ts`)
- **Evidence:** `packages/session/session-persistence-jsonl/src/format.ts:240-246` — `refuseForeignFormatVersion` throws `SessionFormatUnsupportedError` with direction-aware refusal text BEFORE header-shape validation (a future format need not satisfy today's structural checks); `packages/session/session-persistence-jsonl/src/format.ts:258-259` — invoked from `parseHeaderRecord` before `isHeaderLine`; `packages/core/session/src/types.ts:408-422` — the `ignorable?: true` envelope guard: an unrecognized type without the marker MUST refuse rather than silently drop a required event; `packages/session/session-persistence/src/coordinator.ts:1061-1066` — `assertEventsSupported` refuses an unknown event type unless the writer marked it ignorable.
- **Disposition:** reuse
- **Reason:** refusal-before-decode plus the `ignorable` vocabulary guard is clean, stable forward-compatibility behavior; copy it as reference alongside the F01-1 migration addition.
- **Details:** dsh never classifies a foreign header as corruption: a version refusal happens before any decode so the user sees "upgrade the harness", the raw log path is attached when the backend owns one artifact per session, and unknown event types refuse unless explicitly marked `ignorable: true` (defaulting to required so a forgotten marker over-refuses rather than silently resuming a gutted session). This is exactly the read-side discipline a versioned format needs; I-harness should adopt it unchanged while adding the upgrade chain dsh lacks.

---

## Verification

All 31 evidence cites verified against `D:\agent-complete\deepseek-harness-master` on 2026-08-16.

Verified cites (11 distinct files, 31 `path:line` references):
`packages/core/session/src/types.ts` (:37-38, :56, :408-422); `packages/core/session/src/index.ts` (:604-634); `packages/core/session/src/surface.ts` (:26-27, :34-37); `packages/core/session/src/known-event-types.ts` (catalog consulted for F01-7 vocabulary); `packages/core/agent-loop/src/invariant.ts` (:22, :39-41); `packages/llm/llm/src/call-config.ts` (:13); `packages/session/session-persistence/src/coordinator.ts` (:697-710, :1046, :1061-1066); `packages/session/session-persistence-jsonl/src/index.ts` (:122, :172, :252, :438-443, :480-485, :665-679, :681-688, :884-885, :905-907); `packages/session/session-persistence-jsonl/src/format.ts` (:240-246, :258-259, :272-343, :388-394); `packages/session/session-persistence-sqlite/src/index.ts` (:225-239, :284-298); `packages/session/session-persistence-sqlite/src/schema.ts` (:20, :96-108, :108-109, :232-269).

Verification method: each cited `path:line` was located in the dsh tree with `grep -n`/`sed`; the line content at the cited range matches the claim in the corresponding Evidence field. 3 citations were corrected during verification (bare `:line` refs in F01-3 and F01-5 were filled in with their full package paths); all 31 passed after the fix.