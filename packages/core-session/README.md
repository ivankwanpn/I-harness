# Core session maintenance map

`@i-harness/core-session` owns the append-only session event log and its derived
views. The package exports only `src/index.ts`; consumers import that public
entry. The facade explicitly re-exports the existing API, including Inbox,
provider continuation types, image validation, projections, and JSONL helpers.
The writer uses session format 3; versions 1 and 2 remain readable. A version-3
header without a semantics fence still describes a legacy prefix.

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Stable public facade; no state or projection implementation. |
| `src/events/types.ts` | Event protocol, session/header shapes, todo/goal payload vocabulary, format version. |
| `src/events/state.ts` | Sole owner of append-hook, subscriber and derived conversation-index WeakMaps. |
| `src/events/append.ts` | Session creation, append validation, image admission references, durable sequencing and observer delivery. |
| `src/events/conversation.ts` | Versioned acceptance/provenance shapes and scalar-safe format errors. |
| `src/conversation/validation.ts` | Sole incremental reference/fence algorithm; complete-prefix validation reuses it. |
| `src/events/subscription.ts` | Subscribe/unsubscribe and transient delivery through the shared subscriber map. |
| `src/inbox.ts` | Durable admission, promotion, cancellation, and pending-input replay. |
| `src/images.ts` | Image shapes, capacity/base64 validation, and compact image descriptors. |
| `src/projection/types.ts` | Provider continuation metadata and model message/content shapes. |
| `src/projection/messages.ts` | Existing message APIs delegate to semantic projection and rendering, including prefix views. |
| `src/conversation/types.ts` | Public semantic items, source/provenance, exchange facts and scalar diagnostics. |
| `src/conversation/sources.ts` | Owner-local source identities, safe durable coordinates, recorded admission and inherited provenance. |
| `src/conversation/visibility.ts` | Time-scoped compaction visibility and unconditional rewind branch exclusion. |
| `src/conversation/legacy.ts` | Legacy failure/acceptance inference, call/result/dispatch evidence and structural diagnostics; no message construction. |
| `src/conversation/project.ts` | Sole conversation fold; attaches sources at event boundaries, resolves admitted images and preserves block/reminder output order. |
| `src/conversation/exchange.ts` | Projection-local item builders and frozen metadata publication, including complete exchange bundles. |
| `src/conversation/render.ts` | Fresh message/container copies from selected semantic items, retaining ordered native sidecars. |
| `src/projection/pruning.ts` | Last-wins prune records and rendered substitutes. |
| `src/projection/rewind.ts` | Non-overlapping rewind windows and their shared interval merge. |
| `src/projection/rewrite.ts` | Projection rewrite marker counts and attribution. |
| `src/projection/search.ts` | Search text normalization and transport-media exclusion. |
| `src/projection/plan.ts` | Latest plan-mode snapshot. |
| `src/projection/title.ts` | Latest session title snapshot. |
| `src/serialization/jsonl.ts` | JSONL encoding/decoding, version checks, and migration seam. |

Internal modules import their owners directly. Inbox imports `events/append.ts`
at runtime and the session/image types with type-only imports. The event protocol
references Inbox, projection, and image types through erased imports; those
references do not introduce a runtime cycle. Internal helpers such as image
descriptors, image summaries, and interval merging are not public package exports.

## Ownership and ordering invariants

- `events/state.ts` creates both WeakMaps exactly once. Session creation,
  durable appends, subscriptions, and transient publication share those owners.
  No observer state is added to the serializable Session shape.
- Append validation completes before the event is sealed and pushed. The sealed
  event uses `session.events.length` as its sequence, overrides any incoming
  sequence, and is the same object delivered first to `onAppend` and then to
  subscribers. Observer exceptions propagate with the original ordering and
  durable append already applied.
- Transient publication strips any supplied sequence, delivers only to live
  subscribers, and never enters the durable log or append hook. Durable append
  continues to reject model activity and reasoning chunks.
- Inbox keeps its append-only admission/promotion/cancellation semantics. A
  referenced user image is validated against the latest admission at append;
  replay resolves it against the latest earlier admission, including admissions
  hidden by compaction or rewind.
- The message fold retains assistant/tool-call/result adjacency, deferred
  mid-step user messages, tool image follow-ups, signed provider continuation
  metadata, and suppression of failed or unresolved tool steps. It stays one
  algorithm because its buffered state and flush order form one protocol unit.
- `projectConversation` owns the only model-visible fold; `deriveMessages` and
  `deriveMessagesUpTo` are rendering facades. Prefix projection keeps original
  archive indices and full archive event count. A selected exchange includes its
  result-image companions; reminders remain separately attributed input items.
- Source IDs are opaque owner-local coordinates, never authority. Missing,
  invalid or duplicate legacy sequences render compatibly but have no durable
  reduction address. Only matching durable human admission establishes recorded
  request provenance. Plugin, internal, system and synthetic inputs are
  observations; unknown legacy users stay unknown. Child seed sources are
  inherited and seed admissions cannot confer fresh child-local human authority.
- Legacy outcome metadata records evidence, never replay permission. A normal
  non-error result reports success; generic error records report error. The
  canonical error/`TOOL_OUTCOME_UNKNOWN`/`replay:false` record reports unknown
  even in unmarked logs. A not-dispatched error code additionally requires no
  matching dispatch and a failed attempt or dispatch-boundary evidence. A
  contradictory dispatch remains unknown. Code strings alone do not establish
  a synthetic producer. Failed/unresolved content stays audit-only with no
  fabricated result; metadata retains scalar refs rather than hidden payloads.
- Metadata envelopes, sources, provenance, calls and diagnostics are newly owned
  and frozen. Message copies recursively own plain object/array containers;
  arbitrary non-plain legacy arguments remain opaque and are not claimed to be
  deeply immutable. The later validated request snapshot owns that boundary.
- Core JSONL helpers still encode events and format only. Storage restores
  `Session.header` separately; inherited provenance needs that header and does
  not fabricate missing lineage from the event content.
- Compaction shadow sequences and rewind windows hide a union of events; they
  never truncate the raw log. Pruning substitutes model-visible tool-result text
  only. Prefix projection retains content-addressed prune markers beyond its
  sequence cutoff, while time-scoped rewrite markers obey the cutoff.
- Search excludes media bytes and streaming noise. JSONL decoding validates conversation references and versioned fields before
  migration. Operational context facts require at least version 2.

## Verification

Run from the repository root:

```powershell
pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-session typecheck
pnpm --filter @i-harness/core-agent exec vitest run test/agent.test.ts test/executor.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-agent typecheck
node scripts/audit/check-reachability.mjs --self-test
pnpm verify:reachability
git diff --check
```

The audit's exact source-owner map treats the extracted original entry modules
as their former logical owner. Inbox remains a separate consumer. A moved
internal import must not retire an existing unused-export finding. The event
producer scanner's existing filename filter does not cover this event union
(formerly in `index.ts`, now in `events/types.ts`); the decomposition does not
claim additional event-producer coverage.
R1A extends that map only for `conversation/visibility.ts`, where the existing
internal rewind-type read moved. The new semantic API has a real production
consumer in the message facade; its use is not supplied by a test or allowlist.

After the semantics fence, only an explicit `model/exchange-accepted` record can
expose an assistant/call bundle. Accepted unresolved exchanges keep their metadata
while protocol rendering waits for truthful results. Later settlement failure does
not revoke acceptance. The fence is read from the archive independently of rewrite
visibility. In-memory append stages structural metadata, pushes the event, commits
metadata, then publishes observations; a throwing observer cannot erase that fact.
Recorded descriptors follow the matched admission, and inherited admissions never
establish child-local human request authority.

## Format 8 generation ownership

Format 8 adds closed `context/action`, `context/attempt` and `agent/input/preparation`
families to the existing fact journal. Action/attempt records contain only bounded
scalar identities, counters, timestamps and references. They contain no request
body, credentials, audio, prompt text or provider response. A successful attribution
callback is synchronous evidence about a particular candidate; durable reservation
is a separate awaited operation before physical handoff.

A main response freezes its final selected retry descriptor before any automatic
summary. For `r` retries its total allowance is `2 * (r + 1) + 8`: original and
changed-input lanes each allow `r + 1`, and all summary pieces share eight. There is
one changed-input phase. Manual compaction has its own summary-only eight. Approval
and title each use their own selected client's `r + 1`; direct video audio allows
one. Explicit lower caps and earlier deadlines persist monotonically, retain past
spend, and cannot be raised by later settings or cold reopen. A lower summary
client retry count limits that client's wrapper without shrinking the main pool.

Origins are validated against the actual own-document suffix and closed causal
references: a real input admission, a settled accepted predecessor, manual command,
accepted/dispatch tool or code source, a new child delegation/inbox item, or a genuine
system wake admission. Inherited seed records import no operational grant. An
unresolved physical reservation or local invocation blocks further execution until
its real disposition is known. Known-unsent rebinding requires private live proof,
keeps its ordinal, invalidates the old ticket and allows at most three rebinds in
total for the action. Serialized owner IDs cannot reconstruct that proof.

The explicitly selected built-in mock uses a separate `local-test` execution domain.
Its committed local invocations consume the same finite lane/deadline policy, but
are never physical network attempts. Acceptance links the exact completed local
invocation; it has no fabricated payload, send or B2 request attribution. Full,
staged, candidate and cold validation reject mixed or forged operational links.

Input preparation retains exact original admission text/images/provenance. Changed
host preparation and supplemental context are separate framed lower-authority
observations, dormant until one atomic raw-input promotion. The closed preparation
identity links its original admission, started effect, completed content and eventual
promotion. Images remain once-owned by the raw admission. Seeds retain only remapped
semantic raw/derived linkage inside the compiler-owned prefix, never preparation or
action lifecycle authority.
