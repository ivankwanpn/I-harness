# R4B Task2 storage bootstrap acceptance — internal staging

**Root accepts Task2/B2.1 at9b7f3fa343528cb7e77725273b19ca7aa3fabf87 as an internal storage foundation.** The initial functional/quality review found three Important defects; controlled unchanged-source probes reproduced all three, and the SAME reviewer approved their correction. Two Minor findings remain explicitly assigned below. This does not accept actual child/fork consumers, artifact transfer, native requests, whole B or the complete ContextEngine redesign.

The binding scope is the [R4B plan](../superpowers/plans/2026-10-22-context-r4b-semantic-inheritance.md) and [owner rulings R-B-20..27](2026-10-23-context-r4b-b2-owner-rulings.md), informed by the [source preflight](2026-10-23-context-r4b-b2-owner-preflight.md). Product remains0.1.13-rc.1, Session11/codec1. Original decomposition remains28/43 with15files/12groups deferred. No push, merge, tag or release accompanied this work.

## Source and review

| Checkpoint | Meaning |
| --- | --- |
| cf437fb549e550ac33cf7e524b99162173c58122 | Task2 approved composition/contract BASE. |
| 50db21c16cc8a4add4b2ff4bf2d6c7c0d4757c58 | Initial20-file compiler/coordinator/JSONL implementation; not accepted at that point. |
| 9b7f3fa343528cb7e77725273b19ca7aa3fabf87 | Six-file correction; final accepted product for this storage gate. |

One GPT6.1Sol writer/runtime owner implemented and probed the scope; a fresh independent GPT6.1Sol reviewer read the complete initial range and then the complete correction range. Root read the full reports, relevant actual source, probe observations and source-timed verification. The [initial review](context-r4b-b2-review-20261023/initial-review.md), [unchanged-source probes](context-r4b-b2-review-20261023/probes.md) and [same-reviewer correction approval](context-r4b-b2-review-20261023/fix1-review.md) retain the findings and their disposition.

## Accepted behavior

- The pure compiler produces deterministic dedicated semantic-seed records from B1 data. None uses the fixed empty identities without parent payload work. Creation data is captured separately from host currentness/authority, and the initial-input hash is shared with the existing reader.
- Header reservation, dependency confirmation and deterministic seed/completion phases use the existing session lease/lane, managed registry, queue, capacity, Pending state and sole view/index. Incomplete work remains unavailable to normal reads/actions; an issued unknown operation is retained across rejected public calls and close.
- A bounded original header transaction survives metadata changes and cold recovery. Exact original stage/header/publication bytes continue only under current guards; passive reconciliation never fills or replaces missing bytes. Inspection is read-only and can report an unknown manifest honestly. These small header-artifact limits are not session-archive limits.
- Existing-empty and new targets have distinct qualification. Cached ordinary views, pending write-behind, foreign/nonempty state and cold pre-publication stages cannot be mistaken for a pristine target. Closing new admissions still permits already-admitted ordinary write-behind work to drain.
- Completion and optional initial admission share one deterministic frame. Historical confirmation validates actual original phase bytes/keys under the current owner and preserves current mutable metadata and complete live suffixes. It never replays observers, admits another initial input or launches a model/action.
- Empty dependencies use the exact empty closure without source/port work. Nonempty dependencies require the injected current source/transfer owner and exact closure reconciliation. This gate implements the port contract; the actual artifact transfer is Task3.
- Owned deletion includes exact target-owned stage/publication artifacts in its original cleanup inventory and retains existing identity/confinement/tombstone rules. It does not invent orphan deletion or access authority.

The independent review exposed gaps beyond the original passing suites. The corrected behavior is now covered by maintained real-file tests:

1. **Ordinary replacement preserves the actual initialization frames.** Rewriting identical events or an allowed later suffix keeps the raw header and actual seed/completion/initial frame bytes. Normal reads/title changes and cold adoption still work. Changed/dropped birth records or a foreign physical layout refuse before publication; stage-free/legacy rewriting remains supported.
2. **Every short-write continuation rechecks currentness/Stop.** After the first11-byte write triggers stale/abort, the four stage/target controls make no further writes. Original partial bytes remain recoverable under a fresh current guard; stopped resume makes no changes.
3. **Retained publication bytes participate in recovery.** Publication-only state is unavailable/needsConfirmation, not absent. New-target work cannot ignore it. Genuine matching existing-empty partial publication can continue under current guards; foreign or conflicting publication remains unchanged and blocks original-operation confirmation.

## Verification and evidence limits

| Evidence | Result and scope |
| --- | --- |
| Final correction JSONL suite | **228/228**,19files, including40 bootstrap physical cases. |
| Final correction focused owner suites | **101/101**,4files; overlaps the full JSONL suite and is not added to it. |
| Final correction typechecks | Persistence and JSONL tsc both exit0, including their transitive contracts. |
| Initial stable core suite/types | **506/506**,46files, plus core tsc exit0. Core source is unchanged by the correction; this evidence is explicitly reused, not labelled a fresh correction run. |
| Initial stable persistence suite | **180pass +1 original fork RED**. The later persistence changes are exercised by the actual JSONL bootstrap tests and selected types; no all-green persistence claim. |
| Reachability | Initial normal gate has7staged rows: B1 exporter plus six caller-facing bootstrap types. No fake consumer, reseed or exemption. The correction adds no public facade/consumer; this is reused gate evidence, not a fresh passing run. |

The [delivery report](context-r4b-b2-review-20261023/delivery.md) lists exact commands, intermediate source timing, API/setup failures, genuine behavioral REDs and final correction results. An initial broader JSONL run exposed a new deletion-drain regression; it was fixed and rechecked, not relabelled as baseline. Actual short-write, fsync/lost-response, install, rename, cold copied-store and deletion tests use real file handles and held ownership. Copied-store cold tests model a fresh process over persisted operation bytes; they are not a power-loss or another-OS certification. Windows directory synchronization remains best effort.

Root's [initial audit](context-r4b-b2-review-20261023/root-audit.json) checked241current source/test files,20changed Git blob bindings,7stable run manifests/exits and101evidence files, with0errors. The [correction audit](context-r4b-b2-review-20261023/fix1-root-audit.json) checked241source/test files,6fix Git blobs,4final run manifests/exits and43evidence files, with0errors. The unchanged-source probe manifests match the initial qualified source; HEAD and index-file hashes stayed unchanged. These are identity/timing checks, separate from functional review.

Final correction scope-manifest SHA256 is f37d8c3414041c2a994ea4f18bae06e215e3692eefc4ee61217e6476af257683. The [portable review checkpoint](context-r4b-b2-review-20261023/README.md) contains6normalized reports/audits and159encoded original evidence entries; root decoded and verified every entry and copied-report hash,0errors. Original per-case store directories are not duplicated; their probe observations/native-write traces and reproducing script are retained. No live provider, credential or user-session experiment was performed.

## Explicit remaining obligations

- **Minor4:** new bootstrap DTO codecs may silently omit non-enumerable data fields. Review found a strict-input contract gap without a new storage authority path. Carry it into Task4/connected B qualification; it is not fixed or waived by this acceptance.
- **Minor5:** an inherited journal test emits its expected cleanup diagnostic without asserting the reporter. Carry it into whole-program test hygiene. The output remains visible and is not claimed pristine.
- **Task3:** actual artifact/catalog/member transfer, original-operation reconciliation, current host access and durable seed-reference evidence.
- **Task4:** genuine fork/spawn/team/SDK/Gateway/Desktop/standalone consumers, per-entry logical intent, original action/deadline ownership, initial admission consumption and closure of the original raw-fork regression and staged exports.
- **Tasks5/6/7:** live native proof, protocol-specific final request preparation and connected B acceptance. R4C delivery and R5/R6 integration/archive qualification remain separate.

Missing original payload/binding can still require explicit recovery rather than guessed bytes. Later torn ordinary suffixes remain with the original qualified recovery owner. Storage readiness never authorizes rerunning an already launched or uncertain task. Broad event-driven/instruction work remains paused and decomposition-only work remains deferred by the user's latest direction.
