# Core session maintenance map

`@i-harness/core-session` owns the append-only session event log and its derived
views. The package exports only `src/index.ts`; consumers import that public
entry. The facade explicitly re-exports the existing API, including Inbox,
provider continuation types, image validation, projections, and JSONL helpers.
The session format remains version 1.

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Stable public facade; no state or projection implementation. |
| `src/events/types.ts` | Event protocol, session/header shapes, todo/goal payload vocabulary, format version. |
| `src/events/state.ts` | Sole owner of the append-hook and subscriber WeakMaps. |
| `src/events/append.ts` | Session creation, append validation, image admission references, durable sequencing and observer delivery. |
| `src/events/subscription.ts` | Subscribe/unsubscribe and transient delivery through the shared subscriber map. |
| `src/inbox.ts` | Durable admission, promotion, cancellation, and pending-input replay. |
| `src/images.ts` | Image shapes, capacity/base64 validation, and compact image descriptors. |
| `src/projection/types.ts` | Provider continuation metadata and model message/content shapes. |
| `src/projection/messages.ts` | Model-visible message fold, block ordering, failed-step suppression, admitted image resolution, and prefix projection. |
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
- Compaction shadow sequences and rewind windows hide a union of events; they
  never truncate the raw log. Pruning substitutes model-visible tool-result text
  only. Prefix projection retains content-addressed prune markers beyond its
  sequence cutoff, while time-scoped rewrite markers obey the cutoff.
- Search excludes media bytes and streaming noise. JSONL decoding retains its
  existing version/error behavior and does not add append-time validation;
  migration to the sole supported version remains the existing no-op seam.

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
